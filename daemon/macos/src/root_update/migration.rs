//! Explicit one-time administrator operation. Prepare before stopping anything;
//! after stopping the legacy job, recover forward to the protected runtime.
//! Never restore root execution from the publicly replaceable app directory.
use super::{
    destination::AppDestination,
    gate,
    launchd::{self, Control, Job},
    receipt::{self, Request},
    runtime,
    store::Dir,
    verify::{self, Identity, Manifest},
    Policy, Version, SERVICE,
};
use anyhow::{ensure, Result};
use serde::{Deserialize, Serialize};
use std::{
    io::{Read, Write},
    os::fd::AsRawFd,
    path::Path,
    time::{Duration, Instant},
};
#[derive(Clone, Copy, Debug, Serialize, Deserialize, Eq, PartialEq)]
enum Phase {
    Prepared,
    Stopping,
    Registered,
    Starting,
    Complete,
}
#[derive(Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct Migration {
    schema: u32,
    phase: Phase,
    identity: Identity,
    nonce: String,
}
trait Steps {
    fn validate(&mut self, m: &Migration) -> Result<()>;
    fn stop_legacy(&mut self) -> Result<()>;
    fn install_registration(&mut self) -> Result<()>;
    fn start(&mut self, m: &Migration) -> Result<()>;
    fn health(&mut self, m: &Migration) -> Result<()>;
    fn enable(&mut self) -> Result<()>;
}
fn phase(state: &Dir, m: &mut Migration, next: Phase) -> Result<()> {
    m.phase = next;
    state.save("migration.json", m)
}
fn resume(state: &Dir, steps: &mut impl Steps) -> Result<()> {
    let _lock = state.lock()?;
    let mut m: Migration = state
        .load("migration.json")?
        .ok_or_else(|| anyhow::anyhow!("no migration"))?;
    ensure!(m.schema == 1, "unsupported migration");
    steps.validate(&m)?;
    if m.phase == Phase::Prepared {
        phase(state, &mut m, Phase::Stopping)?;
    }
    if m.phase == Phase::Stopping {
        steps.stop_legacy()?;
        steps.install_registration()?;
        phase(state, &mut m, Phase::Registered)?;
    }
    if m.phase == Phase::Registered {
        phase(state, &mut m, Phase::Starting)?;
    }
    if m.phase == Phase::Starting {
        steps.start(&m)?;
        steps.health(&m)?;
        phase(state, &mut m, Phase::Complete)?;
    }
    steps.enable()?;
    state.save("migration-result.json", &m)?;
    state.remove("migration.json")?;
    state.discard_child("migration-app")?;
    Ok(())
}
/// Called only by an explicit root invocation during the approved installer.
/// No command-line path, URL, version, identity or policy override is accepted.
pub fn prepare() -> Result<()> {
    ensure!(
        unsafe { libc::geteuid() } == 0,
        "initial updater migration requires administrator installation"
    );
    let data = Dir::open(Path::new(gate::DATA), 0, true)?;
    let state = data.create_dir("updates", 0o700)?;
    state.require_private()?;
    {
        let _lock = state.lock()?;
        ensure!(
            !state.exists("journal.json")?,
            "update transaction in progress"
        );
        ensure!(
            !state
                .load::<Policy>("policy.json")?
                .is_some_and(|p| p.allows()),
            "updater already enabled"
        );
        if !state.exists("migration.json")? {
            state.discard_child("migration-app")?;
            let stage = state.create_dir("migration-app", 0o700)?;
            let original = AppDestination::open()?.snapshot(&stage)?;
            let resources = stage
                .child("Rieul.app")?
                .child("Contents")?
                .child("Resources")?;
            let manifest: Manifest = resources
                .load("rieul-update.json")?
                .ok_or_else(|| anyhow::anyhow!("installer app lacks signed update manifest"))?;
            let mut identity = verify::candidate(
                &stage,
                Version::parse(&manifest.version)?,
                Version(0, 0, 0),
                super::preparation::database_schema(&data)?,
            )?;
            identity.app_dev = original.0;
            identity.app_ino = original.1;
            let service = data.create_dir("service", 0o755)?;
            if !service.exists("rieul-macos-system")? {
                stage
                    .child("Rieul.app")?
                    .child("Contents")?
                    .child("Library")?
                    .child("LaunchServices")?
                    .copy_file("rieul-macos-system", &service, "rieul-macos-system", 0o755)?;
            }
            ensure!(
                verify::digest(service.read_file("rieul-macos-system")?)? == identity.daemon_sha256,
                "existing protected service differs from migration"
            );
            let plists = Dir::open(Path::new("/Library/LaunchDaemons"), 0, true)?;
            if !state.exists("legacy-system.plist")? {
                plists.copy_file(
                    "app.rieul.daemon.plist",
                    &state,
                    "legacy-system.plist",
                    0o600,
                )?;
            }
            // A GUI barrier is public-read, root-write; no policy is enabled yet.
            if !data.exists("gui-update.lock")? {
                let file = data.create("gui-update.lock", 0o644)?;
                ensure!(
                    unsafe { libc::fchmod(file.as_raw_fd(), 0o644) } == 0,
                    "GUI barrier permissions"
                );
                file.sync_all()?;
                data.sync()?;
            }
            data.read_file("gui-update.lock")?;
            let mut nonce = [0u8; 32];
            std::fs::File::open("/dev/urandom")?.read_exact(&mut nonce)?;
            state.save(
                "migration.json",
                &Migration {
                    schema: 1,
                    phase: Phase::Prepared,
                    identity,
                    nonce: nonce.iter().map(|b| format!("{b:02x}")).collect(),
                },
            )?;
        }
    }
    runtime::ensure_worker(&state, &mut launchd::Native { state: &state })
}
struct Native<'a> {
    state: &'a Dir,
    control: launchd::Native<'a>,
}
impl Steps for Native<'_> {
    fn validate(&mut self, m: &Migration) -> Result<()> {
        let stage = self.state.child("migration-app")?;
        let candidate = verify::candidate(
            &stage,
            m.identity.version,
            Version(0, 0, 0),
            super::DATABASE_SCHEMA,
        )?;
        ensure!(
            candidate.daemon_sha256 == m.identity.daemon_sha256,
            "migration candidate changed"
        );
        let service = Dir::open(Path::new(SERVICE).parent().unwrap(), 0, true)?;
        ensure!(
            verify::digest(service.read_file("rieul-macos-system")?)? == m.identity.daemon_sha256,
            "migration runtime changed"
        );
        Ok(())
    }
    fn stop_legacy(&mut self) -> Result<()> {
        // No forced update drain is available in pre-updater releases. Initial
        // installer consent is separate; require the legacy job already stopped
        // by that installer rather than silently kill server workloads here.
        if self
            .control
            .inspect(Job::LegacySystem)
            .ok()
            .flatten()
            .is_some()
        {
            anyhow::bail!("initial installer must stop the legacy service in an explicitly approved maintenance window");
        }
        // A resumed migration may already have the protected service registered.
        if self.control.inspect(Job::System)?.is_some() {
            return Ok(());
        }
        Ok(())
    }
    fn install_registration(&mut self) -> Result<()> {
        let plists = Dir::open(Path::new("/Library/LaunchDaemons"), 0, true)?;
        let xml = format!(
            r#"<?xml version="1.0"?><!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd"><plist version="1.0"><dict><key>Label</key><string>app.rieul.daemon</string><key>ProgramArguments</key><array><string>{SERVICE}</string><string>run</string></array><key>RunAtLoad</key><true/><key>KeepAlive</key><true/><key>EnvironmentVariables</key><dict><key>RUST_LOG</key><string>info</string></dict></dict></plist>"#
        );
        plists.remove("app.rieul.daemon.plist.new")?;
        let mut file = plists.create("app.rieul.daemon.plist.new", 0o644)?;
        file.write_all(xml.as_bytes())?;
        file.sync_all()?;
        plists.rename_file("app.rieul.daemon.plist.new", "app.rieul.daemon.plist")
    }
    fn start(&mut self, m: &Migration) -> Result<()> {
        let expected = Request {
            nonce: m.nonce.clone(),
            daemon_sha256: m.identity.daemon_sha256.clone(),
        };
        if let Some(job) = self.control.inspect(Job::System)? {
            if let (Some(pid), Some(ready)) =
                (job.pid, self.state.load::<receipt::Receipt>("ready.json")?)
            {
                if receipt::matches(&ready, &expected, pid, &m.identity.daemon_sha256) {
                    return Ok(());
                }
            }
            // A crash may have booted the registered service before a readiness
            // request was persisted. Never kill work to repair that ordering.
            super::drain::request_exit(self.state, &mut self.control, &m.nonce, false)?;
            self.control.stop(Job::System)?;
        }
        self.state.remove("ready.json")?;
        self.state.save("start-request.json", &expected)?;
        self.control.start(Job::System)?;
        Ok(())
    }
    fn health(&mut self, m: &Migration) -> Result<()> {
        let deadline = Instant::now() + Duration::from_secs(45);
        let expected = Request {
            nonce: m.nonce.clone(),
            daemon_sha256: m.identity.daemon_sha256.clone(),
        };
        loop {
            if let (Some(job), Some(receipt)) = (
                self.control.inspect(Job::System)?,
                self.state.load::<receipt::Receipt>("ready.json")?,
            ) {
                if let Some(pid) = job.pid {
                    if receipt::matches(&receipt, &expected, pid, &m.identity.daemon_sha256) {
                        launchd::checked(
                            self.state,
                            "/usr/bin/codesign",
                            &[
                                "--verify",
                                "--strict",
                                "-R",
                                &verify::requirement(super::DAEMON_ID),
                                &pid.to_string(),
                            ],
                        )?;
                        return Ok(());
                    }
                }
            }
            ensure!(Instant::now()<deadline,"protected service did not become ready; retry migration, do not restore unsafe legacy execution");
            std::thread::sleep(Duration::from_millis(100));
        }
    }
    fn enable(&mut self) -> Result<()> {
        self.state.save(
            "policy.json",
            &Policy {
                schema: 1,
                enabled: true,
            },
        )
    }
}
pub(super) fn worker(state: &Dir) -> Result<()> {
    resume(
        state,
        &mut Native {
            state,
            control: launchd::Native { state },
        },
    )
}
#[cfg(test)]
mod tests {
    use super::*;
    struct Fake {
        events: Vec<&'static str>,
        fail: Option<&'static str>,
    }
    impl Fake {
        fn effect(&mut self, s: &'static str) -> Result<()> {
            self.events.push(s);
            if self.fail == Some(s) {
                self.fail = None;
                anyhow::bail!("power loss");
            }
            Ok(())
        }
    }
    impl Steps for Fake {
        fn validate(&mut self, _: &Migration) -> Result<()> {
            Ok(())
        }
        fn stop_legacy(&mut self) -> Result<()> {
            self.effect("stop")
        }
        fn install_registration(&mut self) -> Result<()> {
            self.effect("register")
        }
        fn start(&mut self, _: &Migration) -> Result<()> {
            self.effect("start")
        }
        fn health(&mut self, _: &Migration) -> Result<()> {
            self.effect("health")
        }
        fn enable(&mut self) -> Result<()> {
            self.effect("enable")
        }
    }
    #[test]
    fn migration_recovers_forward_without_legacy_restart() {
        use std::os::unix::fs::PermissionsExt;
        for point in ["stop", "register", "start", "health", "enable"] {
            let tmp = tempfile::tempdir().unwrap();
            std::fs::set_permissions(tmp.path(), std::fs::Permissions::from_mode(0o700)).unwrap();
            let state = Dir::open(
                &tmp.path().canonicalize().unwrap(),
                unsafe { libc::geteuid() },
                false,
            )
            .unwrap();
            state
                .save(
                    "migration.json",
                    &Migration {
                        schema: 1,
                        phase: Phase::Prepared,
                        identity: Identity {
                            version: Version(1, 0, 0),
                            daemon_sha256: "a".repeat(64),
                            app_dev: 1,
                            app_ino: 1,
                        },
                        nonce: "b".repeat(64),
                    },
                )
                .unwrap();
            let mut steps = Fake {
                events: vec![],
                fail: Some(point),
            };
            assert!(resume(&state, &mut steps).is_err());
            resume(&state, &mut steps).unwrap();
            assert!(!state.exists("migration.json").unwrap());
            assert_eq!(steps.events.last(), Some(&"enable"));
        }
    }
}
