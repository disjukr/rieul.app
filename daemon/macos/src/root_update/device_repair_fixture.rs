//! Opt-in disposable hosted VM fixture. Not compiled into any installer or
//! daemon. No live service is registered, signaled, or paired during this test.
use super::{
    APP, DATABASE_SCHEMA, Policy, SERVICE, STATE, Version,
    destination::AppDestination,
    gate,
    launchd::{Control, Job, JobState},
    native::NativeEffects,
    runtime::WorkerResult,
    store::Dir,
    transaction::{self, Effects, Journal, Phase},
    verify, vm_integration,
};
use anyhow::{Context, Result, ensure};
use serde::{Deserialize, Serialize};
use std::path::Path;

const OLD: Version = Version(0, 6, 23);
const STALE: Version = Version(0, 6, 24);
const NEXT: Version = Version(0, 6, 25);

/// Any path that might need a live launchd operation fails, including during
/// accidental fixture advancement into a later transaction phase.
struct NoService;
impl Control for NoService {
    fn sessions(&mut self) -> Result<Vec<u32>> {
        anyhow::bail!("fixture may not enumerate clients")
    }
    fn inspect(&mut self, _job: Job) -> Result<Option<JobState>> {
        anyhow::bail!("fixture may not inspect jobs")
    }
    fn stop(&mut self, _job: Job) -> Result<()> {
        anyhow::bail!("fixture may not stop jobs")
    }
    fn start(&mut self, _job: Job) -> Result<()> {
        anyhow::bail!("fixture may not start jobs")
    }
    fn submit_worker(&mut self) -> Result<()> {
        anyhow::bail!("fixture may not submit jobs")
    }
}

#[derive(Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
struct Snapshot {
    nonce: String,
    app: (u64, u64),
    service: String,
    db: String,
}

fn hosted_guard() -> Result<()> {
    // The enclosing guest-only test has already verified root, VirtualMac and
    // the protected marker. The CI wrapper independently checks fresh hosted
    // status and absence of the fixed fixture paths before enabling this code.
    ensure!(
        std::env::var("RIEUL_DISPOSABLE_HOSTED_REPAIR").as_deref() == Ok("confirmed"),
        "only the explicitly guarded hosted fixture may exercise this case"
    );
    Ok(())
}

fn require_absent(path: &str) -> Result<()> {
    match std::fs::symlink_metadata(path) {
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(error) => Err(error.into()),
        Ok(_) => anyhow::bail!("fixture destination already exists"),
    }
}

pub(super) fn seed(fixtures: Dir) -> Result<()> {
    hosted_guard()?;
    for path in [
        APP,
        gate::DATA,
        "/Library/LaunchDaemons/app.rieul.daemon.plist",
    ] {
        require_absent(path)?;
    }
    ensure!(
        !fixtures.exists("old-verified")?,
        "fixture seed already attempted"
    );
    let verified = fixtures.create_dir("old-verified", 0o700)?;
    super::archive::extract(
        fixtures
            .child(&OLD.text())?
            .read_file("rieul-macos-update.tar")?,
        &verified,
    )?;
    let old = verify::candidate(&verified, OLD, Version(0, 0, 0), DATABASE_SCHEMA)?;

    std::fs::create_dir(gate::DATA)?;
    let data = Dir::open(Path::new(gate::DATA), 0, true)?;
    let state = data.create_dir("updates", 0o700)?;
    let service = data.create_dir("service", 0o755)?;
    let old_bundle = verified.child("Rieul.app")?;
    old_bundle
        .child("Contents")?
        .child("Library")?
        .child("LaunchServices")?
        .copy_file("rieul-macos-system", &service, "rieul-macos-system", 0o755)?;
    std::fs::create_dir(APP)?;
    // Match the public destination contract; /Applications itself can be
    // group-writable on macOS, but this fresh bundle remains root-owned.
    old_bundle.copy_contents(&Dir::open(Path::new(APP), 0, false)?)?;
    let runtime_digest = verify::digest(service.read_file("rieul-macos-system")?)?;
    ensure!(
        runtime_digest == old.daemon_sha256,
        "fixture runtime changed during copy"
    );

    let database = data.path.join("daemon-state.sqlite3");
    let db = rusqlite::Connection::open(&database)?;
    db.pragma_update(None, "user_version", DATABASE_SCHEMA)?;
    db.execute_batch("CREATE TABLE fixture_guard (proof TEXT NOT NULL); INSERT INTO fixture_guard VALUES ('preserve-me');")?;
    db.close().map_err(|(_, e)| e)?;
    state.save(
        "policy.json",
        &Policy {
            schema: 1,
            enabled: true,
        },
    )?;

    let snapshot_dir = Dir::open(&fixtures.path, 0, true)?;
    vm_integration::prepare_fixture(STALE, fixtures, false)?;
    let _lock = state.lock()?;
    let mut journal: Journal = state
        .load("journal.json")?
        .context("fixture journal not prepared")?;
    ensure!(
        journal.phase == Phase::Prepared
            && journal.old.version == OLD
            && journal.new.version == STALE
            && journal.old.app_dev == journal.new.app_dev,
        "fixture did not establish the exact pre-swap transaction"
    );

    // First exercise real signature/manifest verification and create the
    // protected candidate runtime stage. Then reproduce only device-number
    // churn and verify normal worker logic rejects it before any service call.
    let mut effects = NativeEffects::new(&state, NoService)?;
    effects.validate(&journal)?;
    let stale_dev = journal.old.app_dev ^ 1;
    journal.old.app_dev = stale_dev;
    journal.new.app_dev = stale_dev;
    state.save("journal.json", &journal)?;
    let error = transaction::resume_locked(&state, &mut NativeEffects::new(&state, NoService)?)
        .expect_err("device-number change must fail closed");
    ensure!(
        error.to_string() == "unknown app entry",
        "unexpected failure mode"
    );
    let still_prepared: Journal = state
        .load("journal.json")?
        .context("fixture journal removed")?;
    ensure!(
        still_prepared.phase == Phase::Prepared && still_prepared.nonce == journal.nonce,
        "fixture changed transaction phase"
    );
    state.save(
        "worker-result.json",
        &WorkerResult {
            nonce: Some(journal.nonce.clone()),
            phase: "failed".into(),
            error: Some(error.to_string()),
            deferred: false,
        },
    )?;
    snapshot_dir.save(
        "repair-fixture-proof.json",
        &Snapshot {
            nonce: journal.nonce,
            app: AppDestination::open()?.identity()?,
            service: runtime_digest,
            db: verify::digest(data.read_file("daemon-state.sqlite3")?)?,
        },
    )?;
    println!("Verified fixture failed before quiescing; no service operations attempted.");
    Ok(())
}

pub(super) fn verify_and_prepare(fixtures: Dir) -> Result<()> {
    hosted_guard()?;
    let proof: Snapshot = fixtures
        .load("repair-fixture-proof.json")?
        .context("fixture proof missing")?;
    let data = Dir::open(Path::new(gate::DATA), 0, true)?;
    let state = Dir::open(Path::new(STATE), 0, true)?;
    let service = Dir::open(Path::new(SERVICE).parent().unwrap(), 0, true)?;
    {
        let _lock = state.lock()?;
        ensure!(
            AppDestination::open()?.identity()? == proof.app
                && verify::digest(service.read_file("rieul-macos-system")?)? == proof.service
                && verify::digest(data.read_file("daemon-state.sqlite3")?)? == proof.db,
            "repair modified installed app, protected runtime or DB"
        );
        ensure!(
            !state.exists("journal.json")? && !state.exists("service-stage")?,
            "repair did not retire stale candidate"
        );
        let archived: Journal = state
            .load(&format!("retired-device-journal-{}.json", proof.nonce))?
            .context("archived journal missing")?;
        ensure!(
            archived.nonce == proof.nonce
                && archived.old.version == OLD
                && archived.new.version == STALE
                && archived.phase == Phase::Prepared,
            "repair did not preserve the exact stale transaction"
        );
        let archived_service = state.child(&format!("retired-device-stage-{}", proof.nonce))?;
        ensure!(
            verify::digest(archived_service.read_file("rieul-macos-system")?)?
                == archived.new.daemon_sha256,
            "repair did not preserve the verified staged runtime"
        );
    }

    vm_integration::prepare_fixture(NEXT, fixtures, false)?;
    let _lock = state.lock()?;
    let journal: Journal = state
        .load("journal.json")?
        .context("direct upgrade was not prepared")?;
    ensure!(
        journal.phase == Phase::Prepared
            && journal.old.version == OLD
            && journal.new.version == NEXT
            && journal.nonce != proof.nonce,
        "direct upgrade did not bind the verified new release"
    );
    println!("Signed repair retired only the stale update and enables direct 0.6.25 preparation.");
    Ok(())
}
