//! Authenticated RPC requests select fixed operations only. Downloads and worker
//! dispatch happen off the transport task; one in-process operation at a time.
use super::{
    destination::AppDestination,
    preparation::{self, Source},
    runtime,
    store::Dir,
    transaction::{Journal, Phase},
    verify::{self, Manifest},
    Policy, Version, SERVICE, STATE,
};
use anyhow::{ensure, Result};
use rieul_daemon_core::generated::rpc::{
    RequestUpdateReq, UpdateAction, UpdatePhase, UpdateStatus,
};
use rieul_daemon_host::{maintenance::Workload, updates::UpdateService};
use serde::{Deserialize, Serialize};
use std::{
    path::Path,
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc, Mutex,
    },
    time::{Duration, Instant},
};
#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub(super) struct InstallIntent {
    pub nonce: String,
    pub confirmed: bool,
}
struct Inner {
    status: UpdateStatus,
    last_check: Option<Instant>,
    pending_manual: bool,
    last_dispatch: Option<Instant>,
}
#[derive(Clone)]
pub(super) struct Controller {
    inner: Arc<Mutex<Inner>>,
    running: Arc<AtomicBool>,
}
fn enabled(state: &Dir) -> Result<bool> {
    use std::os::unix::fs::MetadataExt;
    let Some(policy) = state.load::<Policy>("policy.json")? else {
        return Ok(false);
    };
    ensure!(
        state.read_file("policy.json")?.metadata()?.mode() & 0o077 == 0,
        "unsafe updater policy permissions"
    );
    Ok(policy.allows())
}
impl Controller {
    fn set(&self, phase: UpdatePhase, reason: Option<String>) {
        if let Ok(mut inner) = self.inner.lock() {
            inner.status.phase = phase;
            inner.status.reason = reason;
        }
    }
    fn launch(&self, task: impl FnOnce(Controller) -> Result<()> + Send + 'static) -> bool {
        if self
            .running
            .compare_exchange(false, true, Ordering::SeqCst, Ordering::SeqCst)
            .is_err()
        {
            return false;
        }
        let controller = self.clone();
        std::thread::spawn(move || {
            if let Err(error) = task(controller.clone()) {
                tracing::warn!(?error, "updater operation failed");
                controller.set(UpdatePhase::Failed,Some("Update could not complete. The existing service has been preserved where possible.".into()));
            }
            controller.running.store(false, Ordering::SeqCst);
        });
        true
    }
    fn check(self) -> Result<()> {
        self.check_candidate(false)
    }
    fn check_candidate(self, confirmed_retry: bool) -> Result<()> {
        self.set(UpdatePhase::Checking, None);
        self.inner.lock().unwrap().last_check = Some(Instant::now());
        let state = Dir::open(Path::new(STATE), 0, true)?;
        let old = {
            let _lock = state.lock()?;
            if state.exists("journal.json")? {
                self.set(
                    UpdatePhase::Ready,
                    Some("A verified update is already staged".into()),
                );
                return Ok(());
            }
            state.discard_child("current-app")?;
            let current = state.create_dir("current-app", 0o700)?;
            let original = AppDestination::open()?.snapshot(&current)?;
            let manifest: Manifest = current
                .child("Rieul.app")?
                .child("Contents")?
                .child("Resources")?
                .load("rieul-update.json")?
                .ok_or_else(|| anyhow::anyhow!("missing installed update manifest"))?;
            let mut old = verify::candidate(
                &current,
                Version::parse(&manifest.version)?,
                Version(0, 0, 0),
                super::DATABASE_SCHEMA,
            )?;
            old.app_dev = original.0;
            old.app_ino = original.1;
            let service = Dir::open(Path::new(SERVICE).parent().unwrap(), 0, true)?;
            ensure!(
                verify::digest(service.read_file("rieul-macos-system")?)? == old.daemon_sha256,
                "app and running service version differ"
            );
            state.discard_child("current-app")?;
            old
        };
        self.inner.lock().unwrap().status.current_version = Some(old.version.text());
        struct Progress(Controller);
        impl Source for Progress {
            fn latest(&mut self) -> Result<Version> {
                super::source::latest()
            }
            fn download(&mut self, version: Version, stage: &Dir) -> Result<()> {
                self.0.set(UpdatePhase::Downloading, None);
                super::source::download(version, stage)
            }
        }
        let data = Dir::open(Path::new(super::gate::DATA), 0, true)?;
        let prepared = preparation::prepare_with_retry(
            &state,
            old,
            preparation::database_schema(&data)?,
            &mut Progress(self.clone()),
            |stage, target, current, db| {
                self.set(UpdatePhase::Verifying, None);
                verify::candidate(stage, target, current, db)
            },
            confirmed_retry,
        )?;
        let mut inner = self.inner.lock().unwrap();
        inner.last_check = Some(Instant::now());
        if prepared {
            let j: Journal = state.load("journal.json")?.unwrap();
            inner.status.target_version = Some(j.new.version.text());
            inner.status.phase = UpdatePhase::Ready;
            inner.status.can_install = true;
        } else {
            inner.status.phase = UpdatePhase::Idle;
            inner.status.reason = Some("No newer stable desktop release is available".into());
            inner.status.can_install = false;
        }
        Ok(())
    }
    fn dispatch(self, manual: bool) -> Result<()> {
        let state = Dir::open(Path::new(STATE), 0, true)?;
        if manual && !state.exists("journal.json")? {
            self.clone().check_candidate(true)?;
        }
        self.set(UpdatePhase::Installing, None);
        runtime::dispatch_prepared(manual)
    }
}
impl UpdateService for Controller {
    fn status(&self) -> Result<UpdateStatus> {
        let mut status = self.inner.lock().unwrap().status.clone();
        let state = Dir::open(Path::new(STATE), 0, true)?;
        if !enabled(&state)? {
            return Ok(rieul_daemon_host::updates::unavailable());
        }
        if let Some(j) = state.load::<Journal>("journal.json")? {
            status.current_version = Some(j.old.version.text());
            status.target_version = Some(j.new.version.text());
            status.can_install = matches!(j.phase, Phase::Prepared);
            status.phase = match j.phase {
                Phase::Prepared
                    if matches!(status.phase, UpdatePhase::Deferred | UpdatePhase::Failed) =>
                {
                    status.phase
                }
                Phase::Prepared => UpdatePhase::Ready,
                Phase::Starting | Phase::RollingBack => UpdatePhase::Restarting,
                Phase::Committed | Phase::RolledBack => UpdatePhase::Idle,
                _ => UpdatePhase::Installing,
            };
            if let Some(result) = state.load::<runtime::WorkerResult>("worker-result.json")? {
                apply_worker_result(&mut status, &j.nonce, &result);
            }
        } else if !matches!(
            status.phase,
            UpdatePhase::Checking | UpdatePhase::Downloading | UpdatePhase::Verifying
        ) {
            if let Some(last) = state.load::<Journal>("last-result.json")? {
                if last.schema == 1 && last.phase == Phase::RolledBack {
                    status.phase = UpdatePhase::Failed;
                    status.current_version = Some(last.old.version.text());
                    status.target_version = Some(last.new.version.text());
                    status.can_install = true;
                    status.reason = Some("This candidate failed readiness and was rolled back. Automatic installation of the same version and digest is suppressed; confirm installation to retry, or check for a newer candidate.".into());
                }
            }
        }
        Ok(status)
    }
    fn request(&self, request: RequestUpdateReq) -> Result<UpdateStatus> {
        ensure!(
            self.status()?.phase != UpdatePhase::Unavailable,
            "updater is not activated"
        );
        match request.action {
            UpdateAction::Check => {
                ensure!(
                    self.launch(|controller| controller.check()),
                    "an updater operation is already running"
                );
            }
            UpdateAction::InstallConfirmed => {
                ensure!(
                    request.confirmed,
                    "explicit disconnection confirmation required"
                );
                let status = self.status()?;
                ensure!(
                    status.can_install,
                    "no verified update ready for installation"
                );
                self.inner.lock().unwrap().pending_manual = true;
                self.set(UpdatePhase::Deferred,Some("Installation requested; active terminal, command, transfer or agent work must finish first".into()));
            }
        }
        self.status()
    }
    fn tick(&self, work: &Workload) {
        if self.running.load(Ordering::SeqCst) {
            return;
        }
        let Ok(inner) = self.inner.try_lock() else {
            return;
        };
        let manual = inner.pending_manual;
        let blocked = work.blocks_update(manual);
        // This six-hour cadence is an implementation default, not a user-stated
        // requirement. It is not active until the initial installer enables policy.
        let due = inner
            .last_check
            .is_none_or(|last| last.elapsed() >= Duration::from_secs(6 * 60 * 60));
        let can_dispatch = inner
            .last_dispatch
            .is_none_or(|last| last.elapsed() >= Duration::from_secs(30));
        drop(inner);
        let Ok(status) = self.status() else {
            return;
        };
        if status.phase == UpdatePhase::Unavailable {
            return;
        }
        if status.can_install && blocked {
            self.set(UpdatePhase::Deferred, Some(if manual { "Waiting for active terminals, commands, transfers and agent runtimes to finish" } else { "Automatic installation waits until all clients disconnect and active work finishes" }.into()));
        }
        if dispatch_allowed(&status, manual, can_dispatch, blocked) {
            self.inner.lock().unwrap().last_dispatch = Some(Instant::now());
            if self.launch(move |controller| controller.dispatch(manual)) {
                self.inner.lock().unwrap().pending_manual = false;
            }
        } else if due
            && (!status.can_install || status.phase == UpdatePhase::Failed)
            && !matches!(
                status.phase,
                UpdatePhase::Installing | UpdatePhase::Restarting
            )
        {
            let _ = self.launch(|controller| controller.check());
        }
    }
}
pub fn service() -> Result<Option<Arc<dyn UpdateService>>> {
    if unsafe { libc::geteuid() } != 0
        || std::env::current_exe()? != Path::new(SERVICE)
        || !Path::new(STATE).exists()
    {
        return Ok(None);
    }
    let state = Dir::open(Path::new(STATE), 0, true)?;
    state.require_private()?;
    Ok(Some(Arc::new(Controller {
        inner: Arc::new(Mutex::new(Inner {
            status: UpdateStatus {
                phase: UpdatePhase::Idle,
                current_version: None,
                target_version: None,
                reason: None,
                can_install: false,
            },
            last_check: None,
            pending_manual: false,
            last_dispatch: None,
        })),
        running: Arc::new(AtomicBool::new(false)),
    })))
}

fn apply_worker_result(status: &mut UpdateStatus, nonce: &str, result: &runtime::WorkerResult) {
    if result.nonce.as_deref() != Some(nonce) || result.error.is_none() {
        return;
    }
    status.phase = if result.deferred {
        UpdatePhase::Deferred
    } else {
        UpdatePhase::Failed
    };
    status.reason = Some(if result.deferred {"Installation deferred because the service could not grant an idle drain. Retry after clients and active work finish."} else {"Update or recovery failed. Review the daemon logs before explicitly retrying."}.into());
    status.can_install = true;
}
#[cfg(test)]
mod result_tests {
    use super::*;
    #[test]
    fn repeated_idle_ticks_do_not_dispatch_failed_candidate_without_manual_confirmation() {
        let status = UpdateStatus {
            phase: UpdatePhase::Failed,
            current_version: None,
            target_version: None,
            reason: None,
            can_install: true,
        };
        for _ in 0..10 {
            assert!(!dispatch_allowed(&status, false, true, false));
        }
        assert!(dispatch_allowed(&status, true, true, false));
        assert!(!dispatch_allowed(&status, true, true, true));
    }
    #[test]
    fn stale_worker_result_cannot_mask_new_transaction_and_failure_is_not_busy() {
        let mut status = UpdateStatus {
            phase: UpdatePhase::Ready,
            current_version: None,
            target_version: None,
            reason: None,
            can_install: true,
        };
        let mut result = runtime::WorkerResult {
            nonce: Some("old".into()),
            phase: "failed".into(),
            error: Some("signature".into()),
            deferred: false,
        };
        apply_worker_result(&mut status, "new", &result);
        assert_eq!(status.phase, UpdatePhase::Ready);
        result.nonce = Some("new".into());
        apply_worker_result(&mut status, "new", &result);
        assert_eq!(status.phase, UpdatePhase::Failed);
        result.deferred = true;
        apply_worker_result(&mut status, "new", &result);
        assert_eq!(status.phase, UpdatePhase::Deferred);
    }
}

fn dispatch_allowed(
    status: &UpdateStatus,
    manual: bool,
    can_dispatch: bool,
    blocked: bool,
) -> bool {
    status.can_install
        && can_dispatch
        && !blocked
        && (manual || status.phase != UpdatePhase::Failed)
}
