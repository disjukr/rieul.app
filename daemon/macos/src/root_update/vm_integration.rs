//! Explicit guest-only harness. Compiled only into the test executable, never
//! into signed production binaries. No host services may be used as fixtures.
use super::{
    DATABASE_SCHEMA, SERVICE, STATE, Version,
    destination::AppDestination,
    preparation::{self, Source},
    runtime,
    store::Dir,
    verify::{self, Manifest},
};
use anyhow::{Result, ensure};
use std::{io::Write, path::Path};
const FIXTURES: &str = "/Library/Application Support/rieul-vm-fixtures";
fn guest_guard() -> Result<Dir> {
    ensure!(
        unsafe { libc::geteuid() } == 0,
        "guest fixture requires root"
    );
    let model = std::process::Command::new("/usr/sbin/sysctl")
        .args(["-n", "hw.model"])
        .output()?;
    ensure!(
        model.status.success()
            && String::from_utf8(model.stdout)?
                .trim()
                .starts_with("VirtualMac"),
        "refusing non-virtual Mac"
    );
    let dir = Dir::open(Path::new(FIXTURES), 0, true)?;
    dir.require_private()?;
    ensure!(
        std::io::read_to_string(dir.read_file("guest-only.txt")?)?.trim()
            == "rieul-issue-45-isolated-vm",
        "missing explicit guest fixture marker"
    );
    Ok(dir)
}
struct FixtureSource {
    dir: Dir,
    version: Version,
}
impl Source for FixtureSource {
    fn latest(&mut self) -> Result<Version> {
        Ok(self.version)
    }
    fn download(&mut self, version: Version, stage: &Dir) -> Result<()> {
        ensure!(version == self.version, "fixture version mismatch");
        let mut input = self
            .dir
            .child(&version.text())?
            .read_file("rieul-macos-update.tar")?;
        let mut output = stage.create("candidate.tar", 0o600)?;
        std::io::copy(&mut input, &mut output)?;
        output.flush()?;
        output.sync_all()?;
        stage.sync()
    }
}
pub(super) fn prepare_fixture(version: Version, fixtures: Dir, confirmed_retry: bool) -> Result<()> {
    let state = Dir::open(Path::new(STATE), 0, true)?;
    state.require_private()?;
    let old = {
        let _lock = state.lock()?;
        ensure!(!state.exists("journal.json")?, "pending transaction");
        state.discard_child("vm-current-app")?;
        let snapshot = state.create_dir("vm-current-app", 0o700)?;
        let original = AppDestination::open()?.snapshot(&snapshot)?;
        let manifest: Manifest = snapshot
            .child("Rieul.app")?
            .child("Contents")?
            .child("Resources")?
            .load("rieul-update.json")?
            .ok_or_else(|| anyhow::anyhow!("missing installed manifest"))?;
        let mut identity = verify::candidate(
            &snapshot,
            Version::parse(&manifest.version)?,
            Version(0, 0, 0),
            DATABASE_SCHEMA,
        )?;
        identity.app_dev = original.0;
        identity.app_ino = original.1;
        let service = Dir::open(Path::new(SERVICE).parent().unwrap(), 0, true)?;
        ensure!(
            verify::digest(service.read_file("rieul-macos-system")?)? == identity.daemon_sha256,
            "installed runtime mismatch"
        );
        state.discard_child("vm-current-app")?;
        identity
    };
    let data = Dir::open(Path::new(super::gate::DATA), 0, true)?;
    ensure!(
        preparation::prepare_with_retry(
            &state,
            old,
            preparation::database_schema(&data)?,
            &mut FixtureSource {
                dir: fixtures,
                version
            },
            verify::candidate,
            confirmed_retry
        )?,
        "fixture not prepared"
    );
    println!("prepared verified fixture {}", version.text());
    Ok(())
}
#[test]
#[ignore = "requires explicitly provisioned isolated macOS VM; NEVER run on host"]
fn signed_native_guest_operation() -> Result<()> {
    let fixtures = guest_guard()?;
    match std::env::var("RIEUL_VM_TEST_OPERATION")?.as_str() {
        "seed-device-churn-fixture" => super::device_repair_fixture::seed(fixtures),
        "verify-device-repair-and-prepare-0.6.25" => super::device_repair_fixture::verify_and_prepare(fixtures),
        "prepare-0.0.2" => prepare_fixture(Version(0, 0, 2), fixtures, false),
        "prepare-0.0.3" => prepare_fixture(Version(0, 0, 3), fixtures, false),
        "prepare-retry-0.0.2" => prepare_fixture(Version(0, 0, 2), fixtures, true),
        "verify-fixtures" => {
            ensure!(
                !fixtures.exists("validation")?,
                "existing validation fixture"
            );
            let stage = fixtures.create_dir("validation", 0o700)?;
            super::archive::extract(
                fixtures
                    .child("0.0.2")?
                    .read_file("rieul-macos-update.tar")?,
                &stage,
            )?;
            verify::candidate(&stage, Version(0, 0, 2), Version(0, 0, 1), DATABASE_SCHEMA)?;
            ensure!(
                verify::candidate(&stage, Version(0, 0, 3), Version(0, 0, 1), DATABASE_SCHEMA)
                    .is_err(),
                "wrong version accepted"
            );
            ensure!(
                verify::candidate(&stage, Version(0, 0, 2), Version(0, 0, 2), DATABASE_SCHEMA)
                    .is_err(),
                "non-increasing version accepted"
            );
            let resources = stage
                .child("Rieul.app")?
                .child("Contents")?
                .child("Resources")?;
            resources.remove("vm-test-only.json")?;
            let mut tampered = resources.create("vm-test-only.json", 0o644)?;
            tampered.write_all(b"{\"tampered\":true}\n")?;
            tampered.sync_all()?;
            ensure!(
                verify::candidate(&stage, Version(0, 0, 2), Version(0, 0, 1), DATABASE_SCHEMA)
                    .is_err(),
                "tampered signed bundle accepted"
            );
            ensure!(
                super::launchd::checked(
                    &stage,
                    "/usr/bin/codesign",
                    &[
                        "--verify",
                        "--strict",
                        "-R",
                        &verify::requirement(super::DAEMON_ID),
                        "/Library/Application Support/rieul-vm-fixtures/unsigned-daemon"
                    ]
                )
                .is_err(),
                "wrong signing identity accepted"
            );
            fixtures.discard_child("validation")?;
            println!(
                "signed candidate accepted; wrong signing identity, tamper, wrong version and downgrade rejected"
            );
            Ok(())
        }
        "dispatch-auto" => runtime::dispatch_prepared(false),
        "dispatch-manual" => runtime::dispatch_prepared(true),
        "status" => {
            let state = Dir::open(Path::new(STATE), 0, true)?;
            for name in [
                "migration-result.json",
                "journal.json",
                "last-result.json",
                "worker-result.json",
                "ready.json",
                "downtime.json",
            ] {
                if let Some(value) = state.load::<serde_json::Value>(name)? {
                    println!("{name}: {value}");
                }
            }
            Ok(())
        }
        _ => anyhow::bail!("unsupported fixed guest operation"),
    }
}
