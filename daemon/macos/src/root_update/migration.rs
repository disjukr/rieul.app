//! Explicit one-time administrator operation. Prepare before stopping anything;
//! after stopping the legacy job, recover forward to the protected runtime.
//! Never restore root execution from the publicly replaceable app directory.
use super::{
    Policy, SERVICE, Version,
    destination::AppDestination,
    launchd::{self, Control, Job},
    receipt::{self, Request},
    runtime,
    store::Dir,
    verify::{self, Identity, Manifest},
};
use anyhow::{Result, ensure};
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
/// A migration worker holds the state lock while waiting for readiness.
/// Startup must inspect its atomic record without acquiring that same lock.
/// Only the bound runtime and a live fixed-identity system worker may authorize
/// opening the DB; all other migration phases recover through that worker.
pub(super) fn startup(
    state: &Dir,
    control: &mut impl Control,
    own_hash: &str,
) -> Result<Option<bool>> {
    startup_with(state, control, own_hash, runtime::ensure_worker)
}
fn startup_with<C: Control>(
    state: &Dir,
    control: &mut C,
    own_hash: &str,
    launch_worker: impl FnOnce(&Dir, &mut C) -> Result<()>,
) -> Result<Option<bool>> {
    let Some(m) = state.load::<Migration>("migration.json")? else {
        return Ok(None);
    };
    ensure!(m.schema == 1, "unsupported migration");
    let expected = Request {
        nonce: m.nonce,
        daemon_sha256: m.identity.daemon_sha256,
    };
    expected.validate()?;
    ensure!(
        expected.daemon_sha256 == own_hash,
        "unknown runtime during migration"
    );
    let worker_running = control
        .inspect(Job::Worker)?
        .and_then(|job| job.pid)
        .is_some();
    let allowed = matches!(m.phase, Phase::Starting | Phase::Complete)
        && state.load::<Request>("start-request.json")?.as_ref() == Some(&expected)
        && worker_running;
    if allowed {
        state.remove("parked.json")?;
        return Ok(Some(false));
    }
    // Publish before starting the worker: it must distinguish this instance,
    // which has not opened the DB or transport, from a serving process.
    state.remove("ready.json")?;
    state.save(
        "parked.json",
        &runtime::Parked {
            nonce: expected.nonce,
            pid: std::process::id(),
            daemon_sha256: own_hash.into(),
        },
    )?;
    launch_worker(state, control)?;
    Ok(Some(true))
}
trait Steps {
    fn validate(&mut self, m: &Migration) -> Result<()>;
    fn stop_legacy(&mut self) -> Result<()>;
    fn install_registration(&mut self) -> Result<()>;
    fn start(&mut self, m: &Migration) -> Result<()>;
    fn health(&mut self, m: &Migration) -> Result<()>;
    fn finalize_guis(&mut self) -> Result<()>;
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
    if matches!(m.phase, Phase::Starting | Phase::Complete) {
        // Complete is durable before retirement. A reboot in that interval
        // still needs the same verified readiness/restart path before cleanup.
        steps.start(&m)?;
        steps.health(&m)?;
        phase(state, &mut m, Phase::Complete)?;
    }
    steps.finalize_guis()?;
    steps.enable()?;
    state.save("migration-result.json", &m)?;
    state.remove("migration.json")?;
    state.discard_child("migration-app")?;
    Ok(())
}
// Only initial installation may lack a database. Existing files still go through
// protected no-follow/read-only validation; readiness must attest schema 2 after
// the daemon initializes a new database before policy activation.
fn initial_database_schema(data: &Dir) -> Result<u32> {
    if !data.exists("daemon-state.sqlite3")? {
        ensure!(
            !data.exists("daemon-state.sqlite3-wal")?
                && !data.exists("daemon-state.sqlite3-shm")?,
            "orphan database sidecars"
        );
        return Ok(super::DATABASE_SCHEMA);
    }
    super::preparation::database_schema(data)
}

/// Called only by an explicit root invocation during the approved installer.
/// No command-line path, URL, version, identity or policy override is accepted.
pub fn prepare() -> Result<()> {
    ensure!(
        unsafe { libc::geteuid() } == 0,
        "initial updater migration requires administrator installation"
    );
    let parent = Dir::open(Path::new("/Library/Application Support"), 0, true)?;
    let data = parent.create_dir("rieul", 0o755)?;
    let state = data.create_dir("updates", 0o700)?;
    state.require_private()?;
    {
        let _lock = state.lock()?;
        ensure!(
            !state.exists("journal.json")?,
            "update transaction in progress"
        );
        if state
            .load::<Policy>("policy.json")?
            .is_some_and(|p| p.allows())
            && !state.exists("migration.json")?
        {
            ensure!(
                state
                    .load::<Migration>("migration-result.json")?
                    .is_some_and(|m| m.phase == Phase::Complete)
                    && state
                        .load::<GuiFinalization>("migration-guis.json")?
                        .is_some_and(|g| g.pending.is_empty()),
                "enabled updater has no completed GUI migration evidence"
            );
            return Ok(());
        }
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
                initial_database_schema(&data)?,
            )?;
            identity.app_dev = original.0;
            identity.app_ino = original.1;
            // Only the PKG-protected bootstrap or the same protected runtime
            // may authorize this payload. Never execute code read from the app.
            let own = verify::digest(std::fs::File::open(std::env::current_exe()?)?)?;
            ensure!(
                identity.daemon_sha256 == own,
                "payload does not match trusted installer bootstrap"
            );
            publish_initial_runtime(&data, &identity.daemon_sha256, |to| {
                stage
                    .child("Rieul.app")?
                    .child("Contents")?
                    .child("Library")?
                    .child("LaunchServices")?
                    .copy_file("rieul-macos-system", to, "rieul-macos-system", 0o755)
            })?;
            let plists = Dir::open(Path::new("/Library/LaunchDaemons"), 0, true)?;
            if !state.exists("legacy-system.plist")? && plists.exists("app.rieul.daemon.plist")? {
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
// Publish a complete runtime directory once. A pre-journal crash only leaves
// private disposable staging; an established runtime is never overwritten.
fn publish_initial_runtime(
    data: &Dir,
    digest: &str,
    copy: impl FnOnce(&Dir) -> Result<()>,
) -> Result<()> {
    if data.exists("service")? {
        ensure!(
            verify::digest(data.child("service")?.read_file("rieul-macos-system")?)? == digest,
            "existing protected service differs from migration"
        );
        return Ok(());
    }
    data.discard_child("service-migration-tmp")?;
    let stage = data.create_dir("service-migration-tmp", 0o700)?;
    copy(&stage)?;
    ensure!(
        verify::digest(stage.read_file("rieul-macos-system")?)? == digest,
        "incomplete migration runtime"
    );
    stage.read_file("rieul-macos-system")?.sync_all()?;
    stage.sync()?;
    data.publish_dir("service-migration-tmp", "service")
}

#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct GuiFinalization {
    pending: Vec<u32>,
}
fn finish_gui_sessions(
    state: &Dir,
    control: &mut impl Control,
    initial: impl FnOnce(&mut dyn Control) -> Result<Vec<u32>>,
) -> Result<()> {
    let mut saved = match state.load::<GuiFinalization>("migration-guis.json")? {
        Some(saved) => saved,
        None => {
            let pending = initial(control)?;
            ensure!(
                pending.len() <= 256 && pending.iter().all(|uid| *uid > 0),
                "invalid migration GUI sessions"
            );
            let saved = GuiFinalization { pending };
            state.save("migration-guis.json", &saved)?;
            saved
        }
    };
    let mut errors = Vec::new();
    for uid in saved.pending.clone() {
        let result = (|| -> Result<()> {
            if control.gui_domain(uid)? {
                control.stop(Job::Gui(uid))?;
                control.start(Job::Gui(uid))?;
            }
            Ok(())
        })();
        if let Err(error) = result {
            errors.push(format!("UID {uid}: {error:#}"));
        } else {
            saved.pending.retain(|pending| *pending != uid);
            state.save("migration-guis.json", &saved)?;
        }
    }
    ensure!(
        errors.is_empty(),
        "migration GUI finalization pending: {}",
        errors.join("; ")
    );
    Ok(())
}

// launchctl(1) documents that user-domain print includes the GUI ASID when
// associated with a login domain. Status 125 alone is never absence evidence.
fn background_domain_without_gui(uid: u32, code: i32, text: &str) -> bool {
    code == 0
        && text.starts_with(&format!("user/{uid} = {{\n"))
        && text.trim_end().ends_with('}')
        && text.lines().any(|line| line == "\ttype = user")
        && text.lines().any(|line| line == format!("\thandle = {uid}"))
        && !text.contains("gui asid")
        && !text.contains("subdomains =")
}
// Repeat before policy activation, including resumed migrations. A plist/job
// introduced after installer preflight cannot silently survive migration.
fn require_legacy_agent_absent(
    plist_exists: bool,
    uids: Vec<u32>,
    mut inspect: impl FnMut(&str) -> Result<(i32, String)>,
) -> Result<()> {
    ensure!(
        !plist_exists,
        "explicit maintenance retirement required for app.rieul.user.plist"
    );
    ensure!(uids.len() <= 256, "too many legacy user domains");
    for uid in uids {
        ensure!(uid > 0, "invalid legacy user domain");
        let target = format!("gui/{uid}/app.rieul.user");
        let (code, text) = inspect(&target)?;
        let absent = (code == 113 && text.contains("Could not find service"))
            || ((code == 112 || code == 113)
                && text.trim()
                    == format!("Bad request.\nCould not find domain for user gui: {uid}"));
        if absent {
            continue;
        }
        if code == 125
            && text.trim()
                == "Could not print domain: 125: Domain does not support specified action"
        {
            let domain = format!("user/{uid}");
            let (domain_code, domain_text) = inspect(&domain)?;
            ensure!(
                background_domain_without_gui(uid, domain_code, &domain_text),
                "cannot prove no GUI association for {domain}"
            );
            // User and GUI service sets are distinct; also reject an old job
            // loaded directly into the background user domain.
            let (job_code, job_text) = inspect(&format!("{domain}/app.rieul.user"))?;
            ensure!(
                job_code == 113 && job_text.contains("Could not find service"),
                "legacy background user job not absent"
            );
            let (again_code, again_text) = inspect(&domain)?;
            ensure!(
                background_domain_without_gui(uid, again_code, &again_text),
                "user acquired GUI association during legacy check"
            );
            continue;
        }
        anyhow::bail!(
            "explicit maintenance retirement/absence verification required for {target} ({code})"
        );
    }
    Ok(())
}

/// Used by both Native::start and Native::health. A current parked process
/// cannot satisfy readiness, even if reboot reused a prior receipt's PID.
fn ready_pid(state: &Dir, expected: &Request, job: &launchd::JobState) -> Result<Option<u32>> {
    let Some(pid) = job.pid else {
        return Ok(None);
    };
    if state
        .load::<runtime::Parked>("parked.json")?
        .is_some_and(|parked| parked.nonce == expected.nonce && parked.pid == pid)
    {
        return Ok(None);
    }
    let Some(ready) = state.load::<receipt::Receipt>("ready.json")? else {
        return Ok(None);
    };
    Ok(receipt::matches(&ready, expected, pid, &expected.daemon_sha256).then_some(pid))
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
            anyhow::bail!(
                "initial installer must stop the legacy service in an explicitly approved maintenance window"
            );
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
            if ready_pid(self.state, &expected, &job)?.is_some() {
                return Ok(());
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
            if let Some(job) = self.control.inspect(Job::System)? {
                if let Some(pid) = ready_pid(self.state, &expected, &job)? {
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
            ensure!(
                Instant::now() < deadline,
                "protected service did not become ready; retry migration, do not restore unsafe legacy execution"
            );
            std::thread::sleep(Duration::from_millis(100));
        }
    }
    fn finalize_guis(&mut self) -> Result<()> {
        // Verified at resume entry. Never source a privileged script or plist
        // through the replaceable public application entry.
        let resources = self
            .state
            .child("migration-app")?
            .child("Rieul.app")?
            .child("Contents")?
            .child("Resources")?;
        let agents = Dir::open(Path::new("/Library/LaunchAgents"), 0, true)?;
        require_legacy_agent_absent(
            agents.exists("app.rieul.user.plist")?,
            self.control.sessions()?,
            |target| launchd::run(self.state, "/bin/launchctl", &["print", target]),
        )?;
        agents.remove("app.rieul.gui.plist.new")?;
        resources.copy_file(
            "app.rieul.gui.plist",
            &agents,
            "app.rieul.gui.plist.new",
            0o644,
        )?;
        agents.rename_file("app.rieul.gui.plist.new", "app.rieul.gui.plist")?;
        finish_gui_sessions(self.state, &mut self.control, |control| {
            use std::os::unix::fs::MetadataExt;
            let mut uids = Vec::new();
            for uid in control.sessions()? {
                if control.discover_gui(uid)?.is_some() {
                    uids.push(uid);
                }
            }
            let console = std::fs::metadata("/dev/console")?.uid();
            if console != 0 && !uids.contains(&console) {
                uids.push(console);
            }
            Ok(uids)
        })
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
    #[test]
    fn initial_database_absence_does_not_hide_corruption_or_sidecars() {
        use std::os::unix::fs::{PermissionsExt, symlink};
        let tmp = tempfile::tempdir().unwrap();
        std::fs::set_permissions(tmp.path(), std::fs::Permissions::from_mode(0o700)).unwrap();
        let dir = Dir::open(
            &tmp.path().canonicalize().unwrap(),
            unsafe { libc::geteuid() },
            false,
        )
        .unwrap();
        assert_eq!(
            initial_database_schema(&dir).unwrap(),
            super::super::DATABASE_SCHEMA
        );
        dir.create("daemon-state.sqlite3-wal", 0o600).unwrap();
        assert!(initial_database_schema(&dir).is_err());
        dir.remove("daemon-state.sqlite3-wal").unwrap();
        symlink("missing", tmp.path().join("daemon-state.sqlite3")).unwrap();
        assert!(initial_database_schema(&dir).is_err());
        std::fs::remove_file(tmp.path().join("daemon-state.sqlite3")).unwrap();
        let db = rusqlite::Connection::open(tmp.path().join("daemon-state.sqlite3")).unwrap();
        db.pragma_update(None, "user_version", 3).unwrap();
        drop(db);
        assert_eq!(initial_database_schema(&dir).unwrap(), 3); // candidate validator must reject incompatible schema
    }
    fn fixture_dir() -> (tempfile::TempDir, Dir) {
        use std::os::unix::fs::PermissionsExt;
        let tmp = tempfile::tempdir().unwrap();
        std::fs::set_permissions(tmp.path(), std::fs::Permissions::from_mode(0o700)).unwrap();
        let dir = Dir::open(
            &tmp.path().canonicalize().unwrap(),
            unsafe { libc::geteuid() },
            false,
        )
        .unwrap();
        (tmp, dir)
    }
    #[test]
    fn interrupted_initial_runtime_is_disposable_until_atomic_publish() {
        let (_tmp, data) = fixture_dir();
        data.create("expected", 0o600)
            .unwrap()
            .write_all(b"complete")
            .unwrap();
        let digest = verify::digest(data.read_file("expected").unwrap()).unwrap();
        let write = |to: &Dir, bytes: &[u8]| -> Result<()> {
            to.create("rieul-macos-system", 0o755)?.write_all(bytes)?;
            Ok(())
        };
        assert!(
            publish_initial_runtime(&data, &digest, |to| {
                write(to, b"partial")?;
                anyhow::bail!("disk full before journal")
            })
            .is_err()
        );
        assert!(!data.exists("service").unwrap());
        // A crash after copy but before publication also leaves only staging.
        data.discard_child("service-migration-tmp").unwrap();
        write(
            &data.create_dir("service-migration-tmp", 0o700).unwrap(),
            b"complete",
        )
        .unwrap();
        publish_initial_runtime(&data, &digest, |to| write(to, b"complete")).unwrap();
        assert!(!data.exists("service-migration-tmp").unwrap());
        // Publication completed before a pre-journal crash: reuse, never overwrite.
        publish_initial_runtime(&data, &digest, |_| panic!("must reuse complete runtime")).unwrap();
        let other = "0".repeat(64);
        assert!(
            publish_initial_runtime(&data, &other, |_| panic!(
                "must not replace established runtime"
            ))
            .is_err()
        );
        assert_eq!(
            verify::digest(
                data.child("service")
                    .unwrap()
                    .read_file("rieul-macos-system")
                    .unwrap()
            )
            .unwrap(),
            digest
        );
    }
    struct GuiControl {
        fail: Option<u32>,
        logout: Option<u32>,
        started: Vec<u32>,
    }
    impl Control for GuiControl {
        fn sessions(&mut self) -> Result<Vec<u32>> {
            unreachable!()
        }
        fn gui_domain(&mut self, uid: u32) -> Result<bool> {
            Ok(self.logout != Some(uid))
        }
        fn inspect(&mut self, _: Job) -> Result<Option<launchd::JobState>> {
            unreachable!()
        }
        fn stop(&mut self, _: Job) -> Result<()> {
            Ok(())
        }
        fn start(&mut self, job: Job) -> Result<()> {
            let Job::Gui(uid) = job else { unreachable!() };
            self.started.push(uid);
            ensure!(
                self.fail != Some(uid),
                "injected GUI bootstrap/kickstart failure"
            );
            Ok(())
        }
        fn submit_worker(&mut self) -> Result<()> {
            unreachable!()
        }
    }
    #[test]
    fn gui_finalization_retries_saved_failures_without_losing_other_sessions() {
        for order in [vec![501, 502], vec![502, 501]] {
            let (_tmp, state) = fixture_dir();
            let mut control = GuiControl {
                fail: Some(501),
                logout: None,
                started: vec![],
            };
            assert!(finish_gui_sessions(&state, &mut control, |_| Ok(order.clone())).is_err());
            assert_eq!(control.started, order);
            assert_eq!(
                state
                    .load::<GuiFinalization>("migration-guis.json")
                    .unwrap()
                    .unwrap()
                    .pending,
                [501]
            );
            control.fail = None;
            control.started.clear();
            finish_gui_sessions(&state, &mut control, |_| {
                panic!("must recover saved targets")
            })
            .unwrap();
            assert_eq!(control.started, [501]);
            finish_gui_sessions(&state, &mut control, |_| {
                panic!("completed finalization is idempotent")
            })
            .unwrap();
            assert_eq!(control.started, [501]);
        }
        let (_tmp, state) = fixture_dir();
        let mut control = GuiControl {
            fail: None,
            logout: Some(501),
            started: vec![],
        };
        finish_gui_sessions(&state, &mut control, |_| Ok(vec![501, 502])).unwrap();
        assert_eq!(control.started, [502]);
    }
    #[test]
    fn retained_legacy_user_agent_blocks_finalization_without_terminating_it() {
        assert!(
            require_legacy_agent_absent(true, vec![501], |_| panic!("plist already blocks"))
                .is_err()
        );
        for code in [0, 1, 125] {
            let mut calls = vec![];
            assert!(
                require_legacy_agent_absent(false, vec![501], |target| {
                    calls.push(target.to_owned());
                    Ok((code, "registered or ambiguous".into()))
                })
                .is_err()
            );
            assert_eq!(calls, ["gui/501/app.rieul.user"]);
        }
        require_legacy_agent_absent(false, vec![501, 502], |target| {
            if target.contains("501") {
                Ok((113, "Could not find service".into()))
            } else {
                Ok((
                    112,
                    "Bad request.\nCould not find domain for user gui: 502".into(),
                ))
            }
        })
        .unwrap();
    }
    #[test]
    fn status_125_requires_background_domain_proof_and_absent_user_job() {
        let background = "user/55 = {\n\ttype = user\n\thandle = 55\n}\n";
        for (user_job, associated, malformed) in [
            (false, false, false),
            (true, false, false),
            (false, true, false),
            (false, false, true),
        ] {
            let result = require_legacy_agent_absent(false, vec![55], |target| {
                Ok(match target {
                    "gui/55/app.rieul.user" => (
                        125,
                        "Could not print domain: 125: Domain does not support specified action"
                            .into(),
                    ),
                    "user/55/app.rieul.user" => {
                        if user_job {
                            (0, "registered".into())
                        } else {
                            (113, "Could not find service".into())
                        }
                    }
                    "user/55" => (
                        0,
                        if associated {
                            background.replace("}", "\tgui asid = 123\n}")
                        } else if malformed {
                            "unknown format".into()
                        } else {
                            background.into()
                        },
                    ),
                    _ => unreachable!(),
                })
            });
            assert_eq!(result.is_ok(), !user_job && !associated && !malformed);
        }
        let mut prints = 0;
        assert!(
            require_legacy_agent_absent(false, vec![55], |target| {
                Ok(if target == "gui/55/app.rieul.user" {
                    (
                        125,
                        "Could not print domain: 125: Domain does not support specified action"
                            .into(),
                    )
                } else if target.ends_with("app.rieul.user") {
                    (113, "Could not find service".into())
                } else {
                    prints += 1;
                    (
                        0,
                        if prints == 1 {
                            background.into()
                        } else {
                            background.replace("}", "\tsubdomains = { gui/55 }\n}")
                        },
                    )
                })
            })
            .is_err()
        );
    }
    struct LiveWorker;
    impl Control for LiveWorker {
        fn sessions(&mut self) -> Result<Vec<u32>> {
            unreachable!()
        }
        fn inspect(&mut self, job: Job) -> Result<Option<launchd::JobState>> {
            assert_eq!(job, Job::Worker);
            Ok(Some(launchd::JobState { pid: Some(42) }))
        }
        fn stop(&mut self, _: Job) -> Result<()> {
            unreachable!()
        }
        fn start(&mut self, _: Job) -> Result<()> {
            unreachable!()
        }
        fn submit_worker(&mut self) -> Result<()> {
            unreachable!()
        }
    }
    #[test]
    fn migration_readiness_starts_while_worker_holds_lock_only_for_bound_request() {
        use std::os::unix::fs::PermissionsExt;
        let tmp = tempfile::tempdir().unwrap();
        std::fs::set_permissions(tmp.path(), std::fs::Permissions::from_mode(0o700)).unwrap();
        let state = Dir::open(
            &tmp.path().canonicalize().unwrap(),
            unsafe { libc::geteuid() },
            false,
        )
        .unwrap();
        let mut m = Migration {
            schema: 1,
            phase: Phase::Starting,
            identity: Identity {
                version: Version(0, 0, 1),
                daemon_sha256: "a".repeat(64),
                app_dev: 1,
                app_ino: 1,
            },
            nonce: "b".repeat(64),
        };
        let mut request = Request {
            nonce: m.nonce.clone(),
            daemon_sha256: m.identity.daemon_sha256.clone(),
        };
        state.save("migration.json", &m).unwrap();
        state.save("start-request.json", &request).unwrap();
        let _worker_lock = state.lock().unwrap();
        for phase in [Phase::Starting, Phase::Complete] {
            m.phase = phase;
            state.save("migration.json", &m).unwrap();
            assert_eq!(
                startup(&state, &mut LiveWorker, &"a".repeat(64)).unwrap(),
                Some(false)
            );
        }
        for phase in [Phase::Prepared, Phase::Stopping, Phase::Registered] {
            m.phase = phase;
            state.save("migration.json", &m).unwrap();
            assert_eq!(
                startup(&state, &mut LiveWorker, &"a".repeat(64)).unwrap(),
                Some(true)
            );
        }
        m.phase = Phase::Starting;
        state.save("migration.json", &m).unwrap();
        request.nonce = "c".repeat(64);
        state.save("start-request.json", &request).unwrap();
        assert_eq!(
            startup(&state, &mut LiveWorker, &"a".repeat(64)).unwrap(),
            Some(true)
        );
        assert!(startup(&state, &mut LiveWorker, &"d".repeat(64)).is_err());
    }
    struct AbsentWorker;
    impl Control for AbsentWorker {
        fn sessions(&mut self) -> Result<Vec<u32>> {
            unreachable!()
        }
        fn inspect(&mut self, job: Job) -> Result<Option<launchd::JobState>> {
            assert_eq!(job, Job::Worker);
            Ok(None)
        }
        fn stop(&mut self, _: Job) -> Result<()> {
            unreachable!()
        }
        fn start(&mut self, _: Job) -> Result<()> {
            unreachable!()
        }
        fn submit_worker(&mut self) -> Result<()> {
            unreachable!()
        }
    }
    #[test]
    fn native_readiness_rejects_reused_pid_receipt_until_park_clears_and_fresh_receipt_arrives() {
        use std::os::unix::fs::PermissionsExt;
        for phase in [Phase::Starting, Phase::Complete] {
            let tmp = tempfile::tempdir().unwrap();
            std::fs::set_permissions(tmp.path(), std::fs::Permissions::from_mode(0o700)).unwrap();
            let state = Dir::open(
                &tmp.path().canonicalize().unwrap(),
                unsafe { libc::geteuid() },
                false,
            )
            .unwrap();
            let m = Migration {
                schema: 1,
                phase,
                identity: Identity {
                    version: Version(0, 0, 1),
                    daemon_sha256: "a".repeat(64),
                    app_dev: 1,
                    app_ino: 1,
                },
                nonce: "b".repeat(64),
            };
            let expected = Request {
                nonce: m.nonce.clone(),
                daemon_sha256: m.identity.daemon_sha256.clone(),
            };
            let pid = std::process::id();
            let job = launchd::JobState { pid: Some(pid) };
            state.save("migration.json", &m).unwrap();
            state.save("start-request.json", &expected).unwrap();
            receipt::write(&state, expected.clone(), pid, super::super::DATABASE_SCHEMA).unwrap();
            assert_eq!(ready_pid(&state, &expected, &job).unwrap(), Some(pid));
            state
                .save(
                    "parked.json",
                    &runtime::Parked {
                        nonce: m.nonce.clone(),
                        pid,
                        daemon_sha256: m.identity.daemon_sha256.clone(),
                    },
                )
                .unwrap();
            // Exact same nonce/PID/hash as the old ready receipt. This helper
            // is the actual early-return predicate in Native::start and the
            // actual pre-signature predicate in Native::health.
            assert_eq!(ready_pid(&state, &expected, &job).unwrap(), None);
            assert_eq!(
                startup_with(
                    &state,
                    &mut AbsentWorker,
                    &m.identity.daemon_sha256,
                    |state, _| {
                        assert!(!state.exists("ready.json")?);
                        assert!(state.exists("parked.json")?);
                        Ok(())
                    }
                )
                .unwrap(),
                Some(true)
            );
            // Verified worker restarted the daemon. Being permitted to serve
            // does not alone constitute a fresh post-DB/transport receipt.
            assert_eq!(
                startup_with(
                    &state,
                    &mut LiveWorker,
                    &m.identity.daemon_sha256,
                    |_, _| panic!("already running")
                )
                .unwrap(),
                Some(false)
            );
            assert!(!state.exists("parked.json").unwrap());
            assert_eq!(ready_pid(&state, &expected, &job).unwrap(), None);
            receipt::write(&state, expected.clone(), pid, super::super::DATABASE_SCHEMA).unwrap();
            assert_eq!(ready_pid(&state, &expected, &job).unwrap(), Some(pid));
        }
    }
    struct RebootSteps<'a> {
        state: &'a Dir,
        fail_health: bool,
        events: Vec<&'static str>,
    }
    impl Steps for RebootSteps<'_> {
        fn validate(&mut self, _: &Migration) -> Result<()> {
            Ok(())
        }
        fn stop_legacy(&mut self) -> Result<()> {
            unreachable!()
        }
        fn install_registration(&mut self) -> Result<()> {
            unreachable!()
        }
        fn start(&mut self, m: &Migration) -> Result<()> {
            let parked: runtime::Parked = self.state.load("parked.json")?.unwrap();
            ensure!(
                parked.nonce == m.nonce
                    && parked.pid == std::process::id()
                    && parked.daemon_sha256 == m.identity.daemon_sha256,
                "unbound parked process"
            );
            self.events.push("restart-parked");
            let request = Request {
                nonce: m.nonce.clone(),
                daemon_sha256: m.identity.daemon_sha256.clone(),
            };
            self.state.save("start-request.json", &request)?;
            // This happens under resume's lock, like a newly started daemon
            // while the real worker waits for its receipt.
            ensure!(
                startup_with(
                    self.state,
                    &mut LiveWorker,
                    &m.identity.daemon_sha256,
                    |_, _| panic!("live worker must not be resubmitted")
                )? == Some(false),
                "replacement parked"
            );
            ensure!(!self.state.exists("parked.json")?, "stale park retained");
            receipt::write(self.state, request, 4242, super::super::DATABASE_SCHEMA)?;
            Ok(())
        }
        fn health(&mut self, m: &Migration) -> Result<()> {
            self.events.push("health");
            ensure!(!self.fail_health, "simulated readiness failure");
            let ready: receipt::Receipt = self.state.load("ready.json")?.unwrap();
            ensure!(
                receipt::matches(
                    &ready,
                    &Request {
                        nonce: m.nonce.clone(),
                        daemon_sha256: m.identity.daemon_sha256.clone()
                    },
                    4242,
                    &m.identity.daemon_sha256
                ),
                "wrong readiness"
            );
            Ok(())
        }
        fn finalize_guis(&mut self) -> Result<()> {
            Ok(())
        }
        fn enable(&mut self) -> Result<()> {
            ensure!(
                self.events.last() == Some(&"health"),
                "enabled before health"
            );
            self.events.push("enable");
            Ok(())
        }
    }
    #[test]
    fn starting_and_complete_reboot_daemon_parks_before_worker_then_requires_readiness() {
        use std::os::unix::fs::PermissionsExt;
        for phase in [Phase::Starting, Phase::Complete] {
            for fail_health in [false, true] {
                let tmp = tempfile::tempdir().unwrap();
                std::fs::set_permissions(tmp.path(), std::fs::Permissions::from_mode(0o700))
                    .unwrap();
                let state = Dir::open(
                    &tmp.path().canonicalize().unwrap(),
                    unsafe { libc::geteuid() },
                    false,
                )
                .unwrap();
                let m = Migration {
                    schema: 1,
                    phase,
                    identity: Identity {
                        version: Version(0, 0, 1),
                        daemon_sha256: "a".repeat(64),
                        app_dev: 1,
                        app_ino: 1,
                    },
                    nonce: "b".repeat(64),
                };
                state.save("migration.json", &m).unwrap();
                state.create_dir("migration-app", 0o700).unwrap();
                state
                    .save(
                        "start-request.json",
                        &Request {
                            nonce: m.nonce.clone(),
                            daemon_sha256: m.identity.daemon_sha256.clone(),
                        },
                    )
                    .unwrap();
                // Reboot: daemon starts first; no worker is present yet.
                assert_eq!(
                    startup_with(
                        &state,
                        &mut AbsentWorker,
                        &m.identity.daemon_sha256,
                        |state, _| {
                            let parked: runtime::Parked = state
                                .load("parked.json")?
                                .expect("park must precede worker launch");
                            assert_eq!(parked.nonce, m.nonce);
                            assert_eq!(parked.pid, std::process::id());
                            assert_eq!(parked.daemon_sha256, m.identity.daemon_sha256);
                            Ok(())
                        }
                    )
                    .unwrap(),
                    Some(true)
                );
                let mut steps = RebootSteps {
                    state: &state,
                    fail_health,
                    events: vec![],
                };
                let outcome = resume(&state, &mut steps);
                if fail_health {
                    assert!(outcome.is_err());
                    assert_eq!(steps.events, ["restart-parked", "health"]);
                    assert!(state.exists("migration.json").unwrap());
                    assert!(state.exists("migration-app").unwrap());
                    assert!(!state.exists("migration-result.json").unwrap());
                } else {
                    outcome.unwrap();
                    assert_eq!(steps.events, ["restart-parked", "health", "enable"]);
                    assert!(!state.exists("migration.json").unwrap());
                    assert!(!state.exists("migration-app").unwrap());
                    assert!(state.exists("migration-result.json").unwrap());
                }
            }
        }
    }
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
        fn finalize_guis(&mut self) -> Result<()> {
            self.effect("gui")
        }
        fn enable(&mut self) -> Result<()> {
            self.effect("enable")
        }
    }
    #[test]
    fn migration_recovers_forward_without_legacy_restart() {
        use std::os::unix::fs::PermissionsExt;
        for point in ["stop", "register", "start", "health", "gui", "enable"] {
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
            assert!(state.exists("migration.json").unwrap());
            if point == "gui" {
                assert!(!steps.events.contains(&"enable"));
                assert_eq!(
                    state
                        .load::<Migration>("migration.json")
                        .unwrap()
                        .unwrap()
                        .phase,
                    Phase::Complete
                );
            }
            resume(&state, &mut steps).unwrap();
            assert!(!state.exists("migration.json").unwrap());
            assert_eq!(steps.events.last(), Some(&"enable"));
        }
    }
}
