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
            state.save("worker-result.json",&serde_json::json!({"phase":"migration_deferred_or_failed","error":error.to_string()}))?;
        }
        return Ok(());
    }
    if !state.exists("journal.json")? {
        return Ok(());
    }
    let control = launchd::Native { state: &state };
    let mut effects = NativeEffects::new(&state, control)?;
    match transaction::resume(&state, &mut effects) {
        Ok(phase) => {
            state.save(
                "worker-result.json",
                &serde_json::json!({"phase":format!("{phase:?}"),"error":null}),
            )?;
            Ok(())
        }
        Err(error) => {
            // A deferral/error must not create a launchd KeepAlive crash loop.
            // Keep the journal for explicit retry or reboot recovery.
            state.remove("drain-request.json")?;
            state.save(
                "worker-result.json",
                &serde_json::json!({"phase":"deferred_or_failed","error":error.to_string()}),
            )?;
            Ok(())
        }
    }
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
    let Some(j) = state.load::<Journal>("journal.json")? else {
        state.remove("parked.json")?;
        return Ok(false);
    };
    let mut control = launchd::Native { state: &state };
    let service = trusted_service(&state)?;
    let hash = verify::digest(service.read_file("rieul-macos-system")?)?;
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
pub(super) fn dispatch_prepared() -> Result<()> {
    let state = Dir::open(Path::new(STATE), 0, true)?;
    state.require_private()?;
    let _lock = state.lock()?;
    ensure!(state.exists("journal.json")?, "no prepared update");
    ensure_worker(&state, &mut launchd::Native { state: &state })
}
