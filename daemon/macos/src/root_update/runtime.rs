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
    state.read_file("worker")?;
    launchd::checked(
        &state,
        "/usr/bin/codesign",
        &[
            "--verify",
            "--strict",
            "-R",
            &verify::requirement(DAEMON_ID),
            launchd::WORKER,
        ],
    )?;
    if state.exists("migration.json")? {
        if let Err(error) = super::migration::worker(&state) {
            state.save("worker-result.json", &WorkerResult::failure(None, &error))?;
        }
        return Ok(());
    }
    if cleanup_retired(&state)? {
        return Ok(());
    }
    let nonce = state
        .load::<Journal>("journal.json")?
        .ok_or_else(|| anyhow::anyhow!("transaction disappeared"))?
        .nonce;
    let outcome = (|| {
        let control = launchd::Native { state: &state };
        let mut effects = NativeEffects::new(&state, control)?;
        transaction::resume(&state, &mut effects)
    })();
    // Serialize result publication with dispatch's write-ahead marker. An early
    // adapter failure must not be erased by the submitter, nor may an old worker
    // overwrite a newer transaction's failure/drain state.
    let _result_lock = state.lock()?;
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
        Ok(()) => state.remove("worker-result.json"),
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
