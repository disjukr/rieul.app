//! Authenticated RPC requests select fixed operations only. Downloads and worker
//! dispatch happen off the transport task; one in-process operation at a time.
use super::{
    Policy, SERVICE, STATE, Version,
    destination::AppDestination,
    preparation::{self, Source},
    runtime,
    store::Dir,
    transaction::{Journal, Phase},
    verify::{self, Manifest},
};
use anyhow::{Result, ensure};
use rieul_daemon_core::generated::rpc::{UpdatePhase, UpdateStatus};
use rieul_daemon_host::{
    maintenance::Workload,
    updates::{UpdateCommand, UpdateService},
};
use serde::{Deserialize, Serialize};
use std::{
    path::Path,
    sync::{
        Arc, Mutex,
        atomic::{AtomicBool, Ordering},
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
    completion: Option<tokio::sync::watch::Sender<Option<UpdateStatus>>>,
    last_check: Option<Instant>,
    check_retry_at: Option<Instant>,
    pending_manual: bool,
    last_dispatch: Option<Instant>,
}
#[derive(Clone)]
pub(super) struct Controller {
    inner: Arc<Mutex<Inner>>,
    running: Arc<AtomicBool>,
    feed: Arc<rieul_daemon_host::updates::StatusFeed>,
    command: Arc<Mutex<()>>,
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
    fn set(&self, phase: UpdatePhase, reason: Option<String>) -> UpdateStatus {
        let mut inner = self.inner.lock().unwrap();
        inner.status.phase = phase;
        inner.status.reason = reason;
        self.publish(&inner)
    }
    fn publish(&self, inner: &Inner) -> UpdateStatus {
        let snapshot = self.feed.publish(inner.status.clone());
        if snapshot.phase != UpdatePhase::Checking {
            if let Some(completion) = &inner.completion {
                completion.send_if_modified(|outcome| {
                    if outcome.is_some() {
                        return false;
                    }
                    *outcome = Some(snapshot.clone());
                    true
                });
            }
        }
        snapshot
    }
    fn launch(
        &self,
        phase: UpdatePhase,
        task: impl FnOnce(Controller) -> Result<()> + Send + 'static,
    ) -> bool {
        let _command = self.command.lock().unwrap();
        self.launch_locked(phase, task)
    }
    fn launch_locked(
        &self,
        phase: UpdatePhase,
        task: impl FnOnce(Controller) -> Result<()> + Send + 'static,
    ) -> bool {
        if self
            .running
            .compare_exchange(false, true, Ordering::SeqCst, Ordering::SeqCst)
            .is_err()
        {
            return false;
        }
        self.inner.lock().unwrap().completion = if phase == UpdatePhase::Checking {
            Some(tokio::sync::watch::channel(None).0)
        } else {
            None
        };
        // Publish acceptance before the RPC returns, not when the OS schedules the worker.
        self.set(phase, None);
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
    fn join_check(
        &self,
        task: impl FnOnce(Controller) -> Result<()> + Send + 'static,
    ) -> Result<tokio::sync::watch::Receiver<Option<UpdateStatus>>> {
        let _command = self.command.lock().unwrap();
        if !self.launch_locked(UpdatePhase::Checking, task) {
            ensure!(
                self.inner.lock().unwrap().completion.is_some(),
                "an installation operation is already running"
            );
        }
        Ok(self
            .inner
            .lock()
            .unwrap()
            .completion
            .as_ref()
            .unwrap()
            .subscribe())
    }
    // Caller holds `command`, which also serializes worker admission.
    fn queue_install(&self, status: UpdateStatus) -> Result<UpdateStatus> {
        let mut inner = self.inner.lock().unwrap();
        if inner.pending_manual
            || (self.running.load(Ordering::SeqCst) && inner.completion.is_none())
        {
            return Ok(self.publish(&inner));
        }
        ensure!(
            status.can_install,
            "no verified update ready for installation"
        );
        inner.pending_manual = true;
        inner.status = status;
        inner.status.phase = UpdatePhase::Deferred;
        inner.status.reason = Some("Installation requested; active terminal, command, transfer or agent work must finish first".into());
        Ok(self.publish(&inner))
    }
    // A newly ready daemon may race its worker's durable finalization. Defer
    // discovery only for lock contention; never turn integrity/IO failures into
    // a retry and never wait while the worker needs this server's readiness.
    fn discovery_lock(&self, state: &Dir) -> Result<Option<super::store::Lock>> {
        match state.lock() {
            Ok(lock) => {
                self.inner.lock().unwrap().check_retry_at = None;
                Ok(Some(lock))
            }
            Err(error)
                if error
                    .downcast_ref::<std::io::Error>()
                    .is_some_and(|e| e.kind() == std::io::ErrorKind::WouldBlock) =>
            {
                let mut inner = self.inner.lock().unwrap();
                inner.check_retry_at = Some(Instant::now() + Duration::from_secs(30));
                inner.status.phase = UpdatePhase::Checking;
                inner.status.reason = Some("Waiting for the current update operation to finish before checking for releases".into());
                Ok(None)
            }
            Err(error) => Err(error),
        }
    }
    fn check(self) -> Result<()> {
        self.check_candidate(false, true)
    }
    fn check_candidate(self, confirmed_retry: bool, defer_discovery: bool) -> Result<()> {
        self.set(
            UpdatePhase::Checking,
            Some("Verifying the installed app and protected runtime".into()),
        );
        {
            let mut inner = self.inner.lock().unwrap();
            inner.last_check = Some(Instant::now());
            inner.check_retry_at = None;
        }
        let state = Dir::open(Path::new(STATE), 0, true)?;
        let started = Instant::now();
        let old = {
            let _lock = if confirmed_retry {
                // An explicit install must not continue to dispatch after a
                // deferred discovery; preserve its existing failure semantics.
                state.lock()?
            } else {
                let Some(lock) = self.discovery_lock(&state)? else {
                    ensure!(
                        defer_discovery,
                        "another updater process is finalizing; retry the check shortly"
                    );
                    return Ok(());
                };
                lock
            };
            if let Some(journal) = state.load::<Journal>("journal.json")? {
                {
                    let mut inner = self.inner.lock().unwrap();
                    inner.status.current_version = Some(journal.old.version.text());
                    inner.status.target_version = Some(journal.new.version.text());
                    inner.status.can_install = journal.phase == Phase::Prepared;
                }
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
        tracing::info!(
            elapsed_ms = started.elapsed().as_millis() as u64,
            "updater installed-app verification complete"
        );
        self.inner.lock().unwrap().status.current_version = Some(old.version.text());
        struct Progress(Controller);
        impl Source for Progress {
            fn latest(&mut self) -> Result<Version> {
                self.0.set(
                    UpdatePhase::Checking,
                    Some("Checking the official GitHub release".into()),
                );
                let started = Instant::now();
                let result = super::source::latest();
                tracing::info!(
                    elapsed_ms = started.elapsed().as_millis() as u64,
                    success = result.is_ok(),
                    "updater release lookup finished"
                );
                result
            }
            fn download(&mut self, version: Version, stage: &Dir) -> Result<()> {
                self.0.inner.lock().unwrap().status.target_version = Some(version.text());
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
        self.publish(&inner);
        Ok(())
    }
    fn dispatch(self, manual: bool) -> Result<()> {
        let state = Dir::open(Path::new(STATE), 0, true)?;
        if manual && !state.exists("journal.json")? {
            self.clone().check_candidate(true, false)?;
        }
        self.set(UpdatePhase::Installing, None);
        runtime::dispatch_prepared(manual)
    }
}
impl UpdateService for Controller {
    fn status(&self) -> Result<UpdateStatus> {
        let inner = self.inner.lock().unwrap();
        let mut status = inner.status.clone();
        let state = Dir::open(Path::new(STATE), 0, true)?;
        if !enabled(&state)? {
            return Ok(self.feed.publish(rieul_daemon_host::updates::unavailable()));
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
        Ok(self.feed.publish(status))
    }
    fn subscribe(&self) -> Result<tokio::sync::watch::Receiver<UpdateStatus>> {
        let receiver = self.feed.subscribe();
        self.status()?;
        Ok(receiver)
    }
    fn request(&self, request: UpdateCommand) -> rieul_daemon_host::updates::UpdateRequest<'_> {
        Box::pin(async move {
            let completion = {
                ensure!(
                    self.status()?.phase != UpdatePhase::Unavailable,
                    "updater is not activated"
                );
                match request {
                    UpdateCommand::Check => Some(
                        self.join_check(|controller| controller.check_candidate(false, false))?,
                    ),
                    UpdateCommand::InstallConfirmed => {
                        let _command = self.command.lock().unwrap();
                        // Return this accepted transition, even if a previous
                        // worker failure is concurrently observed by the watcher.
                        return self.queue_install(self.status()?);
                    }
                }
            };
            if let Some(mut completion) = completion {
                loop {
                    if let Some(snapshot) = completion.borrow_and_update().clone() {
                        return Ok(snapshot);
                    }
                    completion.changed().await?;
                }
            }
            self.status()
        })
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
        let due = check_due(&inner, Instant::now());
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
            if self.launch(UpdatePhase::Installing, move |controller| {
                controller.dispatch(manual)
            }) {
                self.inner.lock().unwrap().pending_manual = false;
            }
        } else if due
            && (!status.can_install || status.phase == UpdatePhase::Failed)
            && !matches!(
                status.phase,
                UpdatePhase::Installing | UpdatePhase::Restarting
            )
        {
            let _ = self.launch(UpdatePhase::Checking, |controller| controller.check());
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
    let controller = Controller {
        inner: Arc::new(Mutex::new(Inner {
            status: UpdateStatus {
                phase: UpdatePhase::Idle,
                current_version: None,
                target_version: None,
                reason: None,
                can_install: false,
                ordering: rieul_daemon_host::updates::unavailable().ordering,
            },
            completion: None,
            last_check: None,
            check_retry_at: None,
            pending_manual: false,
            last_dispatch: None,
        })),
        running: Arc::new(AtomicBool::new(false)),
        feed: Arc::default(),
        command: Arc::default(),
    };
    // The worker commits journal/result files by atomic rename. Install the
    // directory watch before reading the initial snapshot so neither a rename
    // nor a state change between registration and snapshot can be missed.
    let observed = controller.clone();
    let watcher = watch_state(
        Path::new(STATE),
        move |event: notify::Result<notify::Event>| match event {
            Ok(event) if !matches!(event.kind, notify::EventKind::Access(_)) => {
                if let Err(error) = observed.status() {
                    tracing::warn!(?error, "updater status refresh failed");
                    observed.set(
                        UpdatePhase::Failed,
                        Some("Updater state could not be read".into()),
                    );
                }
            }
            Err(error) => {
                tracing::warn!(?error, "updater status watcher failed");
                observed.set(
                    UpdatePhase::Failed,
                    Some("Updater state notifications failed".into()),
                );
            }
            _ => {}
        },
    )?;
    controller.status()?;
    Ok(Some(Arc::new(WatchedController {
        controller,
        _watcher: watcher,
    })))
}
fn watch_state(
    path: &Path,
    handler: impl notify::EventHandler,
) -> Result<notify::RecommendedWatcher> {
    use notify::Watcher;
    let mut watcher = notify::recommended_watcher(handler)?;
    watcher.watch(path, notify::RecursiveMode::NonRecursive)?;
    Ok(watcher)
}
struct WatchedController {
    controller: Controller,
    _watcher: notify::RecommendedWatcher,
}
impl UpdateService for WatchedController {
    fn status(&self) -> Result<UpdateStatus> {
        self.controller.status()
    }
    fn subscribe(&self) -> Result<tokio::sync::watch::Receiver<UpdateStatus>> {
        self.controller.subscribe()
    }
    fn request(&self, request: UpdateCommand) -> rieul_daemon_host::updates::UpdateRequest<'_> {
        self.controller.request(request)
    }
    fn tick(&self, work: &Workload) {
        self.controller.tick(work);
    }
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
    fn worker_atomic_rename_notifies_without_status_polling_and_watcher_stops_on_drop() {
        let dir = tempfile::tempdir().unwrap();
        let (events, received) = std::sync::mpsc::channel();
        let watcher = watch_state(dir.path(), move |event: notify::Result<notify::Event>| {
            if let Ok(event) = event {
                if !matches!(event.kind, notify::EventKind::Access(_)) {
                    let _ = events.send(());
                }
            }
        })
        .unwrap();
        std::fs::write(dir.path().join("worker.new"), b"fixture").unwrap();
        std::fs::rename(
            dir.path().join("worker.new"),
            dir.path().join("worker-result.json"),
        )
        .unwrap();
        received.recv_timeout(Duration::from_secs(3)).unwrap();
        drop(watcher);
        while received.try_recv().is_ok() {}
        std::fs::write(dir.path().join("worker-result.json"), b"after shutdown").unwrap();
        assert!(matches!(
            received.recv_timeout(Duration::from_millis(100)),
            Err(std::sync::mpsc::RecvTimeoutError::Disconnected)
        ));
    }
    fn fixture() -> Controller {
        Controller {
            inner: Arc::new(Mutex::new(Inner {
                status: UpdateStatus {
                    phase: UpdatePhase::Idle,
                    current_version: None,
                    target_version: None,
                    reason: None,
                    can_install: false,
                    ordering: rieul_daemon_host::updates::unavailable().ordering,
                },
                completion: None,
                last_check: None,
                check_retry_at: None,
                pending_manual: false,
                last_dispatch: None,
            })),
            running: Arc::new(AtomicBool::new(false)),
            feed: Arc::default(),
            command: Arc::default(),
        }
    }
    #[test]
    fn duplicate_install_during_dispatch_does_not_queue_an_unrequested_retry() {
        let c = fixture();
        let mut staged = rieul_daemon_host::updates::unavailable();
        staged.phase = UpdatePhase::Ready;
        staged.can_install = true;
        staged.target_version = Some("1.2.3".into());
        assert_eq!(
            c.queue_install(staged.clone()).unwrap().phase,
            UpdatePhase::Deferred
        );
        assert_eq!(
            c.inner.lock().unwrap().status.target_version.as_deref(),
            Some("1.2.3")
        );
        // Model admission consuming the request before the external worker has
        // advanced its journal from Prepared. A duplicate must not re-arm it.
        c.inner.lock().unwrap().pending_manual = false;
        c.running.store(true, Ordering::SeqCst);
        c.set(UpdatePhase::Installing, None);
        assert_eq!(
            c.queue_install(staged).unwrap().phase,
            UpdatePhase::Installing
        );
        assert!(!c.inner.lock().unwrap().pending_manual);
    }
    #[test]
    fn concurrent_checks_join_and_cancel_does_not_cancel_discovery_or_download() {
        let c = fixture();
        let (release, wait) = std::sync::mpsc::channel();
        let (download, downloading) = std::sync::mpsc::channel();
        let (finish, finish_wait) = std::sync::mpsc::channel();
        let first = c
            .join_check(move |controller| {
                wait.recv_timeout(Duration::from_secs(5))?;
                controller.set(UpdatePhase::Downloading, None);
                download.send(())?;
                finish_wait.recv_timeout(Duration::from_secs(5))?;
                controller.set(UpdatePhase::Ready, None);
                Ok(())
            })
            .unwrap();
        assert!(first.borrow().is_none());
        drop(first); // A disconnected requester must not cancel accepted work.
        let callers: Vec<_> = (0..8)
            .map(|_| {
                let c = c.clone();
                std::thread::spawn(move || c.join_check(|_| panic!("duplicate discovery")).unwrap())
            })
            .collect();
        let replies: Vec<_> = callers.into_iter().map(|t| t.join().unwrap()).collect();
        release.send(()).unwrap();
        downloading.recv_timeout(Duration::from_secs(5)).unwrap();
        for reply in &replies {
            assert_eq!(
                reply.borrow().as_ref().unwrap().phase,
                UpdatePhase::Downloading
            );
        }
        // Check has an outcome even though the archive worker is still blocked.
        assert!(c.running.load(Ordering::SeqCst));
        finish.send(()).unwrap();
        let deadline = Instant::now() + Duration::from_secs(5);
        while c.running.load(Ordering::SeqCst) {
            assert!(Instant::now() < deadline);
            std::thread::yield_now();
        }
        let (done, finished) = std::sync::mpsc::channel();
        let next = c
            .join_check(move |controller| {
                controller.set(
                    UpdatePhase::Idle,
                    Some("No newer stable desktop release is available".into()),
                );
                done.send(())?;
                Ok(())
            })
            .unwrap();
        finished.recv_timeout(Duration::from_secs(5)).unwrap();
        assert_eq!(next.borrow().as_ref().unwrap().phase, UpdatePhase::Idle);
        // A later check cannot overwrite the previous check's promised outcome.
        assert_eq!(
            replies[0].borrow().as_ref().unwrap().phase,
            UpdatePhase::Downloading
        );
    }
    #[tokio::test]
    async fn discovery_error_completes_all_waiters_and_installation_is_not_joined() {
        let c = fixture();
        let mut result = c
            .join_check(|_| anyhow::bail!("fixture metadata failure"))
            .unwrap();
        tokio::time::timeout(Duration::from_secs(5), async {
            while result.borrow_and_update().is_none() {
                result.changed().await.unwrap();
            }
        })
        .await
        .unwrap();
        assert_eq!(result.borrow().as_ref().unwrap().phase, UpdatePhase::Failed);
        let c = fixture();
        let (release, wait) = std::sync::mpsc::channel();
        c.launch(UpdatePhase::Installing, move |_| {
            wait.recv()?;
            Ok(())
        });
        assert!(c.join_check(|_| panic!("must not run")).is_err());
        release.send(()).unwrap();
    }
    #[test]
    fn accepted_check_is_visible_before_worker_progress_and_duplicate_cannot_overwrite_it() {
        let c = Controller {
            inner: Arc::new(Mutex::new(Inner {
                status: UpdateStatus {
                    phase: UpdatePhase::Idle,
                    current_version: None,
                    target_version: None,
                    reason: None,
                    can_install: false,
                    ordering: rieul_daemon_host::updates::unavailable().ordering,
                },
                completion: None,
                last_check: None,
                check_retry_at: None,
                pending_manual: false,
                last_dispatch: None,
            })),
            running: Arc::new(AtomicBool::new(false)),
            feed: Arc::default(),
            command: Arc::default(),
        };
        let (release, wait) = std::sync::mpsc::channel();
        let (finished, done) = std::sync::mpsc::channel();
        assert!(c.launch(UpdatePhase::Checking, move |controller| {
            wait.recv_timeout(Duration::from_secs(5))?;
            controller.set(UpdatePhase::Downloading, None);
            finished.send(())?;
            Ok(())
        }));
        assert_eq!(c.inner.lock().unwrap().status.phase, UpdatePhase::Checking);
        assert!(!c.launch(UpdatePhase::Installing, |_| panic!("duplicate task ran")));
        assert_eq!(c.inner.lock().unwrap().status.phase, UpdatePhase::Checking);
        release.send(()).unwrap();
        done.recv_timeout(Duration::from_secs(5)).unwrap();
        assert_eq!(
            c.inner.lock().unwrap().status.phase,
            UpdatePhase::Downloading
        );
    }

    #[test]
    fn repeated_idle_ticks_do_not_dispatch_failed_candidate_without_manual_confirmation() {
        let status = UpdateStatus {
            phase: UpdatePhase::Failed,
            current_version: None,
            target_version: None,
            reason: None,
            can_install: true,
            ordering: rieul_daemon_host::updates::unavailable().ordering,
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
            ordering: rieul_daemon_host::updates::unavailable().ordering,
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

fn check_due(inner: &Inner, now: Instant) -> bool {
    inner.check_retry_at.map_or_else(
        || {
            inner.last_check.is_none_or(|last| {
                now.saturating_duration_since(last) >= Duration::from_secs(6 * 60 * 60)
            })
        },
        |retry| now >= retry,
    )
}

#[cfg(test)]
mod discovery_lock_tests {
    use super::*;
    use std::os::unix::fs::PermissionsExt;
    #[test]
    fn startup_discovery_defers_while_worker_finalizes_then_can_retry() {
        let tmp = tempfile::tempdir().unwrap();
        std::fs::set_permissions(tmp.path(), std::fs::Permissions::from_mode(0o700)).unwrap();
        let state = Dir::open(
            &tmp.path().canonicalize().unwrap(),
            unsafe { libc::geteuid() },
            false,
        )
        .unwrap();
        let c = Controller {
            inner: Arc::new(Mutex::new(Inner {
                status: UpdateStatus {
                    phase: UpdatePhase::Checking,
                    current_version: None,
                    target_version: None,
                    reason: None,
                    can_install: false,
                    ordering: rieul_daemon_host::updates::unavailable().ordering,
                },
                completion: None,
                last_check: Some(Instant::now()),
                check_retry_at: None,
                pending_manual: false,
                last_dispatch: None,
            })),
            running: Arc::new(AtomicBool::new(false)),
            feed: Arc::default(),
            command: Arc::default(),
        };
        let failure = runtime::WorkerResult {
            nonce: Some("same-transaction".into()),
            phase: "failed".into(),
            error: Some("signature verification failed".into()),
            deferred: false,
        };
        state.save("worker-result.json", &failure).unwrap();
        let marker = std::fs::read(state.path.join("worker-result.json")).unwrap();
        let mut autosubmits = 0;
        let mut observe_dispatch = || {
            let mut status = c.inner.lock().unwrap().status.clone();
            status.can_install = true;
            let durable: runtime::WorkerResult = state.load("worker-result.json").unwrap().unwrap();
            apply_worker_result(&mut status, "same-transaction", &durable);
            assert_eq!(status.phase, UpdatePhase::Failed);
            if dispatch_allowed(&status, false, true, false) {
                autosubmits += 1;
            }
        };
        let worker = state.lock().unwrap();
        assert!(c.discovery_lock(&state).unwrap().is_none());
        observe_dispatch();
        {
            let inner = c.inner.lock().unwrap();
            assert_eq!(inner.status.phase, UpdatePhase::Checking);
            assert!(!check_due(&inner, Instant::now()));
            assert!(check_due(&inner, inner.check_retry_at.unwrap()));
        }
        drop(worker);
        assert!(c.discovery_lock(&state).unwrap().is_some());
        assert!(c.inner.lock().unwrap().check_retry_at.is_none());
        // The 30-second retry can acquire discovery's lock, but the same nonce's
        // durable failure still prevents all automatic installation decisions.
        for _ in 0..10 {
            observe_dispatch();
        }
        assert_eq!(autosubmits, 0);
        assert_eq!(
            std::fs::read(state.path.join("worker-result.json")).unwrap(),
            marker
        );
        // Corrupt lock type is an integrity failure, not retryable contention.
        state.remove("lock").unwrap();
        std::fs::create_dir(tmp.path().join("lock")).unwrap();
        assert!(c.discovery_lock(&state).is_err());
        assert!(c.inner.lock().unwrap().check_retry_at.is_none());
    }
}
