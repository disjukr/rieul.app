//! The worker is a copy of the already trusted daemon in private storage.
//! launchd owns its lifetime independently of the service being replaced.
use super::{
    launchd::{self, Control, Job},
    native::NativeEffects,
    receipt::Request,
    store::Dir,
    transaction::{self, Journal, Phase},
    verify, DAEMON_ID, SERVICE, STATE,
};
use anyhow::{ensure, Result};
use serde::{Deserialize, Serialize};
use std::path::Path;
#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub(super) struct Parked {
    pub nonce: String,
    pub pid: u32,
    pub daemon_sha256: String,
}
#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub(super) struct WorkerResult {
    pub nonce: Option<String>,
    pub phase: String,
    pub error: Option<String>,
    pub deferred: bool,
}
impl WorkerResult {
    fn failure(nonce: Option<String>, error: &anyhow::Error) -> Self {
        Self {
            nonce,
            phase: "failed".into(),
            error: Some(error.to_string()),
            deferred: error.downcast_ref::<super::drain::Deferred>().is_some(),
        }
    }
}
fn trusted_service(state: &Dir) -> Result<Dir> {
    ensure!(
        unsafe { libc::geteuid() } == 0,
        "protected service requires root"
    );
    let service = Dir::open(Path::new(SERVICE).parent().unwrap(), 0, true)?;
    service.read_file("rieul-macos-system")?;
    launchd::checked(
        state,
        "/usr/bin/codesign",
        &[
            "--verify",
            "--strict",
            "-R",
            &verify::requirement(DAEMON_ID),
            SERVICE,
        ],
    )?;
    Ok(service)
}
pub(super) fn ensure_worker(state: &Dir, control: &mut impl Control) -> Result<()> {
    if control
        .inspect(Job::Worker)?
        .and_then(|job| job.pid)
        .is_some()
    {
        return Ok(());
    }
    let service = trusted_service(state)?;
    state.remove("worker.new")?;
    service.copy_file("rieul-macos-system", state, "worker.new", 0o700)?;
    ensure!(
        verify::digest(service.read_file("rieul-macos-system")?)?
            == verify::digest(state.read_file("worker.new")?)?,
        "worker copy changed"
    );
    state.rename_file("worker.new", "worker")?;
    control.submit_worker()
}
pub fn worker() -> Result<()> {
    ensure!(
        unsafe { libc::geteuid() } == 0 && std::env::current_exe()? == Path::new(launchd::WORKER),
        "worker must execute from its protected fixed path"
    );
    let state = Dir::open(Path::new(STATE), 0, true)?;
    state.require_private()?;
    if state.exists("migration.json")? {
        verify_worker(&state)?;
        if let Err(error) = super::migration::worker(&state) {
            state.save("worker-result.json", &WorkerResult::failure(None, &error))?;
        }
        return Ok(());
    }
    run_transaction_worker(
        &state,
        || verify_worker(&state),
        |state| {
            let control = launchd::Native { state };
            let mut effects = NativeEffects::new(state, control)?;
            transaction::resume_locked(state, &mut effects)
        },
    )
}
fn verify_worker(state: &Dir) -> Result<()> {
    state.read_file("worker")?;
    launchd::checked(
        state,
        "/usr/bin/codesign",
        &[
            "--verify",
            "--strict",
            "-R",
            &verify::requirement(DAEMON_ID),
            launchd::WORKER,
        ],
    )?;
    Ok(())
}
fn run_transaction_worker(
    state: &Dir,
    verify_worker: impl FnOnce() -> Result<()>,
    execute: impl FnOnce(&Dir) -> Result<Phase>,
) -> Result<()> {
    // launchctl submit may start us before its caller releases the dispatch
    // lock. Wait only here, bounded beyond the native command's 45s timeout.
    let _handoff_lock = state.lock_wait(std::time::Duration::from_secs(60))?;
    let Some(journal) = state.load::<Journal>("journal.json")? else {
        verify_worker()?;
        transaction::cleanup_pending_locked(state)?;
        return Ok(());
    };
    let nonce = journal.nonce;
    let outcome = (|| {
        verify_worker()?;
        // Only this verified worker, with the lock and current journal nonce,
        // can acknowledge handoff. Submission alone never clears failure state.
        state.save(
            "worker-result.json",
            &WorkerResult {
                nonce: Some(nonce.clone()),
                phase: "accepted".into(),
                error: None,
                deferred: false,
            },
        )?;
        execute(state)
    })();
    // Keep the acquired handoff lock through result publication. There is no
    // second nonblocking acquisition that can lose an early failure report.
    if let Some(current) = state.load::<Journal>("journal.json")? {
        if current.nonce != nonce {
            return Ok(());
        }
    } else if !state
        .load::<Journal>("last-result.json")?
        .is_some_and(|last| last.nonce == nonce)
    {
        return Ok(());
    }
    match outcome {
        Ok(phase) => {
            state.save(
                "worker-result.json",
                &WorkerResult {
                    nonce: Some(nonce.clone()),
                    phase: format!("{phase:?}"),
                    error: None,
                    deferred: false,
                },
            )?;
            Ok(())
        }
        Err(error) => {
            // A deferral/error must not create a launchd KeepAlive crash loop.
            // Keep the journal for explicit retry or reboot recovery.
            state.remove("drain-request.json")?;
            state.save(
                "worker-result.json",
                &WorkerResult::failure(Some(nonce), &error),
            )?;
            Ok(())
        }
    }
}
/// Shared by worker and service startup. Do not take the lock while a journal
/// exists: its worker may be waiting for this service's readiness callback.
fn cleanup_retired(state: &Dir) -> Result<bool> {
    if state.exists("journal.json")? {
        return Ok(false);
    }
    let _lock = state.lock()?;
    if state.exists("journal.json")? {
        return Ok(false);
    }
    transaction::cleanup_pending_locked(state)?;
    Ok(true)
}
/// true means this instance must park before opening the database/listening.
/// Reboot recovery therefore cannot start an inconsistent app/runtime pair.
pub fn startup() -> Result<bool> {
    if std::env::current_exe()? != Path::new(SERVICE) {
        return Ok(false);
    }
    ensure!(unsafe { libc::geteuid() } == 0, "root service required");
    let state = Dir::open(Path::new(STATE), 0, true)?;
    state.require_private()?;
    if state.exists("migration.json")? {
        let service = trusted_service(&state)?;
        let hash = verify::digest(service.read_file("rieul-macos-system")?)?;
        if let Some(park) =
            super::migration::startup(&state, &mut launchd::Native { state: &state }, &hash)?
        {
            return Ok(park);
        }
    }
    if cleanup_retired(&state)? {
        state.remove("parked.json")?;
        return Ok(false);
    }
    let j = state
        .load::<Journal>("journal.json")?
        .ok_or_else(|| anyhow::anyhow!("transaction changed during startup"))?;
    let mut control = launchd::Native { state: &state };
    let service = trusted_service(&state)?;
    let hash = verify::digest(service.read_file("rieul-macos-system")?)?;
    if j.phase == Phase::Prepared && requires_confirmed_retry(&state, &j)? {
        ensure!(
            hash == j.old.daemon_sha256,
            "failed dispatch changed runtime unexpectedly"
        );
        state.remove("parked.json")?;
        return Ok(false);
    }
    let expected = state.load::<Request>("start-request.json")?;
    let allowed = matches!(
        j.phase,
        Phase::Starting | Phase::RollingBack | Phase::Committed | Phase::RolledBack
    ) && expected
        .as_ref()
        .is_some_and(|request| request.nonce == j.nonce && request.daemon_sha256 == hash)
        && control
            .inspect(Job::Worker)?
            .and_then(|job| job.pid)
            .is_some();
    if allowed {
        state.remove("parked.json")?;
        return Ok(false);
    }
    ensure!(
        hash == j.old.daemon_sha256 || hash == j.new.daemon_sha256,
        "unknown root runtime during recovery"
    );
    state.save(
        "parked.json",
        &Parked {
            nonce: j.nonce,
            pid: std::process::id(),
            daemon_sha256: hash,
        },
    )?;
    ensure_worker(&state, &mut control)?;
    Ok(true)
}
pub(super) fn requires_confirmed_retry(state: &Dir, j: &Journal) -> Result<bool> {
    let failed = state
        .load::<WorkerResult>("worker-result.json")?
        .is_some_and(|result| {
            result.nonce.as_deref() == Some(&j.nonce) && result.error.is_some() && !result.deferred
        });
    Ok(failed || super::preparation::rolled_back_candidate(state, &j.new)?)
}
pub(super) fn dispatch_prepared(manual: bool) -> Result<()> {
    let state = Dir::open(Path::new(STATE), 0, true)?;
    dispatch_attempt(&state, manual, |state| {
        ensure_worker(state, &mut launchd::Native { state })
    })
}
/// Persist pessimistic failure before any copy/sign/submit side effect. A crash
/// or dispatch error must require explicit retry, including after daemon restart.
pub(super) fn dispatch_attempt(
    state: &Dir,
    manual: bool,
    submit: impl FnOnce(&Dir) -> Result<()>,
) -> Result<()> {
    state.require_private()?;
    let _lock = state.lock()?;
    let j: Journal = state
        .load("journal.json")?
        .ok_or_else(|| anyhow::anyhow!("no prepared update"))?;
    if !manual {
        ensure!(
            !requires_confirmed_retry(state, &j)?,
            "explicit confirmed retry required"
        );
    }
    state.save(
        "worker-result.json",
        &WorkerResult::failure(
            Some(j.nonce.clone()),
            &anyhow::anyhow!("dispatch interrupted before completion; explicit retry required"),
        ),
    )?;
    let outcome = (|| {
        if manual {
            state.save(
                "install-request.json",
                &super::control::InstallIntent {
                    nonce: j.nonce.clone(),
                    confirmed: true,
                },
            )?;
        } else {
            state.remove("install-request.json")?;
        }
        submit(state)
    })();
    match outcome {
        Ok(()) => Ok(()),
        Err(error) => {
            state.save(
                "worker-result.json",
                &WorkerResult::failure(Some(j.nonce), &error),
            )?;
            Err(error)
        }
    }
}

#[cfg(test)]
mod result_tests {
    use super::*;
    fn handoff_fixture() -> (tempfile::TempDir, Dir) {
        use std::os::unix::fs::PermissionsExt;
        let tmp = tempfile::tempdir().unwrap();
        std::fs::set_permissions(tmp.path(), std::fs::Permissions::from_mode(0o700)).unwrap();
        let state = Dir::open(
            &tmp.path().canonicalize().unwrap(),
            unsafe { libc::geteuid() },
            false,
        )
        .unwrap();
        let identity = |n| super::super::verify::Identity {
            version: super::super::Version(1, 0, n),
            daemon_sha256: format!("{n:064x}"),
            app_dev: 1,
            app_ino: n,
        };
        transaction::prepare(&state, identity(1), identity(2)).unwrap();
        (tmp, state)
    }
    #[test]
    fn worker_waits_for_dispatch_lock_and_owns_result_publication() {
        use std::sync::mpsc;
        use std::time::Duration;
        let (_tmp, state) = handoff_fixture();
        let (started_tx, started_rx) = mpsc::channel();
        let (acquired_tx, acquired_rx) = mpsc::channel();
        std::thread::scope(|scope| {
            let mut handle = None;
            dispatch_attempt(&state, false, |state| {
                let path = state.path.clone();
                handle = Some(scope.spawn(move || {
                    let worker = Dir::open(&path, unsafe { libc::geteuid() }, false).unwrap();
                    started_tx.send(()).unwrap();
                    run_transaction_worker(
                        &worker,
                        || {
                            acquired_tx.send(()).unwrap();
                            Ok(())
                        },
                        |state| {
                            assert!(
                                state.lock().is_err(),
                                "worker must retain the lock during execution"
                            );
                            let mut j: Journal = state.load("journal.json")?.unwrap();
                            let accepted: WorkerResult = state.load("worker-result.json")?.unwrap();
                            assert_eq!(accepted.nonce.as_deref(), Some(j.nonce.as_str()));
                            assert_eq!(accepted.phase, "accepted");
                            j.phase = Phase::Committed;
                            state.save("journal.json", &j)?;
                            Ok(Phase::Committed)
                        },
                    )
                    .unwrap();
                }));
                started_rx.recv_timeout(Duration::from_secs(2)).unwrap();
                assert!(acquired_rx
                    .recv_timeout(Duration::from_millis(100))
                    .is_err());
                assert!(state
                    .load::<WorkerResult>("worker-result.json")?
                    .unwrap()
                    .error
                    .is_some());
                Ok(())
            })
            .unwrap();
            handle.unwrap().join().unwrap();
        });
        acquired_rx.recv_timeout(Duration::from_secs(2)).unwrap();
        let result: WorkerResult = state.load("worker-result.json").unwrap().unwrap();
        assert_eq!(result.phase, "Committed");
        assert!(result.error.is_none());
    }
    #[test]
    fn successful_submit_then_early_signature_failure_remains_durable() {
        let (_tmp, state) = handoff_fixture();
        dispatch_attempt(&state, false, |_| Ok(())).unwrap();
        assert!(state
            .load::<WorkerResult>("worker-result.json")
            .unwrap()
            .unwrap()
            .error
            .is_some());
        run_transaction_worker(
            &state,
            || anyhow::bail!("early worker signature rejection"),
            |_| panic!("must not execute transaction"),
        )
        .unwrap();
        let j: Journal = state.load("journal.json").unwrap().unwrap();
        assert_eq!(j.phase, Phase::Prepared);
        let result: WorkerResult = state.load("worker-result.json").unwrap().unwrap();
        assert_eq!(result.nonce.as_deref(), Some(j.nonce.as_str()));
        assert_eq!(
            result.error.as_deref(),
            Some("early worker signature rejection")
        );
        assert!(requires_confirmed_retry(&state, &j).unwrap());
        assert!(dispatch_attempt(&state, false, |_| panic!("must require confirmation")).is_err());
    }
    #[test]
    fn bounded_handoff_timeout_does_not_clear_dispatch_marker() {
        let (_tmp, state) = handoff_fixture();
        dispatch_attempt(&state, false, |_| Ok(())).unwrap();
        let lock = state.lock().unwrap();
        let before = std::time::Instant::now();
        assert!(state
            .lock_wait(std::time::Duration::from_millis(50))
            .is_err());
        assert!(before.elapsed() < std::time::Duration::from_secs(2));
        drop(lock);
        assert!(state
            .load::<WorkerResult>("worker-result.json")
            .unwrap()
            .unwrap()
            .error
            .is_some());
    }
    #[test]
    fn startup_and_worker_cleanup_entry_replays_retirement_but_skips_active_transaction() {
        use std::os::unix::fs::PermissionsExt;
        let tmp = tempfile::tempdir().unwrap();
        std::fs::set_permissions(tmp.path(), std::fs::Permissions::from_mode(0o700)).unwrap();
        let state = Dir::open(
            &tmp.path().canonicalize().unwrap(),
            unsafe { libc::geteuid() },
            false,
        )
        .unwrap();
        let identity = |version| super::super::verify::Identity {
            version: super::super::Version(1, 0, version),
            daemon_sha256: "a".repeat(64),
            app_dev: 1,
            app_ino: version,
        };
        let j = Journal {
            schema: 1,
            nonce: "b".repeat(64),
            old: identity(1),
            new: identity(2),
            phase: Phase::Committed,
        };
        state.save("last-result.json", &j).unwrap();
        state.save("cleanup-pending.json", &j).unwrap();
        state.create_dir("service-stage", 0o700).unwrap();
        assert!(cleanup_retired(&state).unwrap());
        assert!(!state.exists("service-stage").unwrap());
        assert!(!state.exists("cleanup-pending.json").unwrap());
        state.save("journal.json", &j).unwrap();
        state.create_dir("service-stage", 0o700).unwrap();
        let _lock = state.lock().unwrap();
        assert!(
            !cleanup_retired(&state).unwrap(),
            "active transaction must not take held lock or clean staging"
        );
        assert!(state.exists("service-stage").unwrap());
    }
    #[test]
    fn only_explicit_busy_drain_is_classified_as_deferral() {
        let busy = anyhow::Error::new(super::super::drain::Deferred("live PTY".into()))
            .context("worker drain");
        assert!(WorkerResult::failure(Some("transaction".into()), &busy).deferred);
        assert!(
            !WorkerResult::failure(
                Some("transaction".into()),
                &anyhow::anyhow!("signature failed")
            )
            .deferred
        );
        assert!(!WorkerResult::failure(None, &anyhow::anyhow!("launchd failed")).deferred);
    }
}
