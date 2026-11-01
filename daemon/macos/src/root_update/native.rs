//! Native transaction adapter. Constructed only by the protected worker.
use super::{
    destination::AppDestination,
    drain, gate,
    launchd::{self, Control, Job},
    preparation,
    receipt::{self, Request},
    store::Dir,
    transaction::{Effects, Installed, Journal},
    verify::{self, Identity},
    Version, DAEMON_ID, SERVICE,
};
use anyhow::{ensure, Result};
use serde::{Deserialize, Serialize};
use std::{
    path::Path,
    time::{Duration, Instant},
};
#[derive(Default, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct Sessions {
    uids: Vec<u32>,
}
pub(super) struct NativeEffects<'a, C: Control> {
    pub state: &'a Dir,
    pub data: Dir,
    pub service: Dir,
    pub app: AppDestination,
    pub control: C,
    journal: Option<Journal>,
    verified: bool,
    barrier: Option<gate::Gate>,
    stopped_at: Option<u64>,
}
impl<'a, C: Control> NativeEffects<'a, C> {
    pub fn new(state: &'a Dir, control: C) -> Result<Self> {
        Ok(Self {
            state,
            data: Dir::open(Path::new(gate::DATA), 0, true)?,
            service: Dir::open(Path::new(SERVICE).parent().unwrap(), 0, true)?,
            app: AppDestination::open()?,
            control,
            journal: None,
            verified: false,
            barrier: None,
            stopped_at: None,
        })
    }
    fn journal(&self) -> Result<&Journal> {
        self.journal
            .as_ref()
            .ok_or_else(|| anyhow::anyhow!("missing transaction context"))
    }
    fn expected_app(&self, id: (u64, u64)) -> Result<&Identity> {
        let j = self.journal()?;
        if id == (j.old.app_dev, j.old.app_ino) {
            Ok(&j.old)
        } else if id == (j.new.app_dev, j.new.app_ino) {
            Ok(&j.new)
        } else {
            anyhow::bail!("unknown app entry")
        }
    }
    fn validate_private_app(&self, dir: &Dir, expected: &Identity) -> Result<()> {
        let checked = verify::candidate(
            dir,
            expected.version,
            Version(0, 0, 0),
            super::DATABASE_SCHEMA,
        )?;
        ensure!(
            checked.version == expected.version && checked.daemon_sha256 == expected.daemon_sha256,
            "artifact contract changed"
        );
        Ok(())
    }
    fn service_hash(&self) -> Result<String> {
        verify::digest(self.service.read_file("rieul-macos-system")?)
    }
    fn quiesce_inner(&mut self) -> Result<()> {
        if matches!(
            self.journal()?.phase,
            super::transaction::Phase::Prepared | super::transaction::Phase::Quiescing
        ) {
            ensure!(
                self.state
                    .load::<super::Policy>("policy.json")?
                    .is_some_and(|p| p.allows()),
                "update deferred: automatic updater policy disabled"
            );
        }

        let mut sessions: Sessions = self.state.load("gui-sessions.json")?.unwrap_or_default();
        for uid in self.control.sessions()? {
            if self.control.discover_gui(uid)?.is_some() && !sessions.uids.contains(&uid) {
                sessions.uids.push(uid);
            }
        }
        ensure!(
            sessions.uids.len() <= 256 && sessions.uids.iter().all(|uid| *uid > 0),
            "invalid GUI recovery set"
        );
        self.state.save("gui-sessions.json", &sessions)?;
        for uid in &sessions.uids {
            self.control.stop(Job::Gui(*uid))?;
        }
        if self.barrier.is_none() {
            self.barrier = gate::exclusive(&self.data)?;
        }
        ensure!(
            self.barrier.is_some(),
            "update deferred: unmanaged or newly connected GUI still active"
        );
        let nonce = self.journal()?.nonce.clone();
        let manual = self
            .state
            .load::<super::control::InstallIntent>("install-request.json")?
            .is_some_and(|intent| intent.confirmed && intent.nonce == nonce);
        drain::request_exit(self.state, &mut self.control, &nonce, manual)?;
        self.stopped_at = Some(drain::monotonic_ms()?);
        self.control.stop(Job::System)?;
        Ok(())
    }
    fn verify_running(&mut self, pid: u32, expected: &str) -> Result<()> {
        ensure!(
            self.service_hash()? == expected,
            "running service path digest mismatch"
        );
        let req = verify::requirement(DAEMON_ID);
        let pid = pid.to_string();
        launchd::checked(
            self.state,
            "/usr/bin/codesign",
            &["--verify", "--strict", "-R", &req, &pid],
        )?;
        let static_info = launchd::checked(
            self.state,
            "/usr/bin/codesign",
            &["-d", "--verbose=4", SERVICE],
        )?;
        let dynamic_info = launchd::checked(
            self.state,
            "/usr/bin/codesign",
            &["-d", "--verbose=4", &pid],
        )?;
        fn hash(text: &str) -> Option<&str> {
            text.lines().find_map(|line| line.strip_prefix("CDHash="))
        }
        ensure!(
            hash(&static_info).is_some() && hash(&static_info) == hash(&dynamic_info),
            "running code identity differs from installed service"
        );
        Ok(())
    }
}
impl<C: Control> Effects for NativeEffects<'_, C> {
    fn validate(&mut self, j: &Journal) -> Result<()> {
        self.journal = Some(j.clone());
        let app_id = self.app.identity()?;
        let expected = self.expected_app(app_id)?.clone();
        let incoming = self.state.child("incoming")?;
        let stage_expected = self
            .expected_app(incoming.child("Rieul.app")?.identity()?)?
            .clone();
        if !self.verified {
            // All slow notarization, copying and full signature checks occur
            // before requesting the idle drain. Only private copies are checked.
            self.state.discard_child("inspection")?;
            let inspection = self.state.create_dir("inspection", 0o700)?;
            ensure!(
                self.app.snapshot(&inspection)? == app_id,
                "installed app changed"
            );
            self.validate_private_app(&inspection, &expected)?;
            self.validate_private_app(&incoming, &stage_expected)?;
            self.state.discard_child("inspection")?;
            if !self.state.exists("service-stage")? {
                ensure!(
                    stage_expected.version == j.new.version,
                    "missing protected runtime staging after replacement"
                );
                stage_runtime(self.state, &j.nonce, &j.new.daemon_sha256, |stage| {
                    incoming
                        .child("Rieul.app")?
                        .child("Contents")?
                        .child("Library")?
                        .child("LaunchServices")?
                        .copy_file("rieul-macos-system", stage, "rieul-macos-system", 0o755)
                })?;
            }
            self.verified = true;
        }
        let binding: StageBinding = self
            .state
            .child("service-stage")?
            .load("transaction.json")?
            .ok_or_else(|| anyhow::anyhow!("missing runtime staging transaction"))?;
        ensure!(
            binding.nonce == j.nonce,
            "runtime staging belongs to another transaction"
        );
        let running = self.service_hash()?;
        let staged = verify::digest(
            self.state
                .child("service-stage")?
                .read_file("rieul-macos-system")?,
        )?;
        ensure!(
            (running == j.old.daemon_sha256 && staged == j.new.daemon_sha256)
                || (running == j.new.daemon_sha256 && staged == j.old.daemon_sha256),
            "unrecognized runtime digest"
        );
        Ok(())
    }
    fn database_schema(&mut self) -> Result<u32> {
        preparation::database_schema(&self.data)
    }
    fn installed(&mut self) -> Result<(Installed, Installed)> {
        let id = self.app.identity()?;
        let j = self.journal()?;
        let app = if id == (j.old.app_dev, j.old.app_ino) {
            Installed::Old
        } else if id == (j.new.app_dev, j.new.app_ino) {
            Installed::New
        } else {
            Installed::Unknown
        };
        let hash = self.service_hash()?;
        let service = if hash == j.old.daemon_sha256 && hash == j.new.daemon_sha256 {
            Installed::Both
        } else if hash == j.old.daemon_sha256 {
            Installed::Old
        } else if hash == j.new.daemon_sha256 {
            Installed::New
        } else {
            Installed::Unknown
        };
        Ok((app, service))
    }
    fn quiesce(&mut self) -> Result<()> {
        if let Err(error) = self.quiesce_inner() {
            self.state.remove("drain-request.json")?;
            let _ = self.restore_guis();
            return Err(error);
        }
        Ok(())
    }
    fn exchange_app(&mut self) -> Result<()> {
        let incoming = self.state.child("incoming")?;
        let old = self.app.identity()?;
        self.expected_app(old)?;
        let new = incoming.child("Rieul.app")?.identity()?;
        self.expected_app(new)?;
        self.app.exchange(&incoming, old, new)
    }
    fn exchange_service(&mut self) -> Result<()> {
        self.service.exchange(
            "rieul-macos-system",
            &self.state.child("service-stage")?,
            "rieul-macos-system",
        )
    }
    fn start(&mut self, identity: &Identity, nonce: &str) -> Result<()> {
        ensure!(
            self.service_hash()? == identity.daemon_sha256,
            "refusing unexpected root executable"
        );
        self.state.remove("ready.json")?;
        self.state.remove("drain-request.json")?;
        self.state.save(
            "start-request.json",
            &Request {
                nonce: nonce.into(),
                daemon_sha256: identity.daemon_sha256.clone(),
            },
        )?;
        self.control.start(Job::System)
    }
    fn ready(&mut self, identity: &Identity, nonce: &str) -> Result<bool> {
        let job = self.control.inspect(Job::System)?;
        let Some(pid) = job.and_then(|job| job.pid) else {
            return Ok(false);
        };
        if self
            .state
            .load::<super::runtime::Parked>("parked.json")?
            .is_some_and(|parked| parked.nonce == nonce && parked.pid == pid)
        {
            return Ok(false);
        }
        let deadline = Instant::now() + Duration::from_secs(45);
        let request = Request {
            nonce: nonce.into(),
            daemon_sha256: identity.daemon_sha256.clone(),
        };
        while Instant::now() < deadline {
            if let (Some(job), Some(receipt)) = (
                self.control.inspect(Job::System)?,
                self.state.load::<receipt::Receipt>("ready.json")?,
            ) {
                if let Some(pid) = job.pid {
                    if receipt::matches(&receipt, &request, pid, &self.service_hash()?) {
                        self.verify_running(pid, &identity.daemon_sha256)?;
                        if let Some(start) = self.stopped_at {
                            self.state.save("downtime.json",&serde_json::json!({"nonce":nonce,"stop_to_ready_ms":drain::monotonic_ms()?.saturating_sub(start)}))?;
                        }
                        return Ok(true);
                    }
                }
            }
            std::thread::sleep(Duration::from_millis(100));
        }
        Ok(false)
    }
    fn restore_guis(&mut self) -> Result<()> {
        self.barrier = None;
        restore_saved_guis(self.state, &mut self.control)
    }
}

/// Saved sessions are recovery obligations, not background-UID discovery.
/// Ambiguous domain errors propagate so transaction finalization retains them.
pub(super) fn restore_saved_guis(state: &Dir, control: &mut impl Control) -> Result<()> {
    let sessions: Sessions = state.load("gui-sessions.json")?.unwrap_or_default();
    for uid in sessions.uids {
        ensure!(uid > 0, "invalid GUI uid");
        if control.gui_domain(uid)? {
            control.start(Job::Gui(uid))?;
        }
    }
    Ok(())
}

#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct StageBinding {
    nonce: String,
}
/// A published stage is never a partial copy. Incomplete temporary state is
/// disposable; published state may contain the only rollback runtime.
fn stage_runtime(
    state: &Dir,
    nonce: &str,
    digest: &str,
    copy: impl FnOnce(&Dir) -> Result<()>,
) -> Result<()> {
    ensure!(
        !state.exists("service-stage")?,
        "published runtime already exists"
    );
    state.discard_child("service-stage-tmp")?;
    let stage = state.create_dir("service-stage-tmp", 0o700)?;
    copy(&stage)?;
    ensure!(
        verify::digest(stage.read_file("rieul-macos-system")?)? == digest,
        "incomplete runtime copy"
    );
    stage.read_file("rieul-macos-system")?.sync_all()?;
    stage.save(
        "transaction.json",
        &StageBinding {
            nonce: nonce.into(),
        },
    )?;
    stage.sync()?;
    state.publish_dir("service-stage-tmp", "service-stage")
}
#[cfg(test)]
mod stage_tests {
    use super::*;
    use std::{io::Write, os::unix::fs::PermissionsExt};
    #[test]
    fn interrupted_runtime_copy_retries_without_publishing_partial_or_overwriting_rollback() {
        let tmp = tempfile::tempdir().unwrap();
        std::fs::set_permissions(tmp.path(), std::fs::Permissions::from_mode(0o700)).unwrap();
        let state = Dir::open(
            &tmp.path().canonicalize().unwrap(),
            unsafe { libc::geteuid() },
            false,
        )
        .unwrap();
        let source = state.create_dir("source", 0o700).unwrap();
        source
            .create("runtime", 0o700)
            .unwrap()
            .write_all(b"complete runtime")
            .unwrap();
        let digest = verify::digest(source.read_file("runtime").unwrap()).unwrap();
        assert!(stage_runtime(&state, "first", &digest, |stage| {
            stage
                .create("rieul-macos-system", 0o700)?
                .write_all(b"partial")?;
            anyhow::bail!("injected copy interruption")
        })
        .is_err());
        assert!(!state.exists("service-stage").unwrap());
        assert!(stage_runtime(&state, "first", &digest, |stage| {
            stage
                .create("rieul-macos-system", 0o700)?
                .write_all(b"partial")?;
            Ok(())
        })
        .is_err());
        stage_runtime(&state, "first", &digest, |stage| {
            source.copy_file("runtime", stage, "rieul-macos-system", 0o700)
        })
        .unwrap();
        assert!(!state.exists("service-stage-tmp").unwrap());
        assert_eq!(
            state
                .child("service-stage")
                .unwrap()
                .load::<StageBinding>("transaction.json")
                .unwrap()
                .unwrap()
                .nonce,
            "first"
        );
        assert!(stage_runtime(&state, "second", &digest, |_| panic!(
            "must preserve rollback"
        ))
        .is_err());
        assert_eq!(
            verify::digest(
                state
                    .child("service-stage")
                    .unwrap()
                    .read_file("rieul-macos-system")
                    .unwrap()
            )
            .unwrap(),
            digest
        );
    }
}
