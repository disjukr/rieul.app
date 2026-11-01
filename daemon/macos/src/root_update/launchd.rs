//! Fixed service identities; only numeric GUI session IDs vary. No RPC-facing
//! command/path interface. Native methods are never invoked by fixture tests.
use super::{store::Dir, SERVICE, STATE};
use anyhow::{bail, ensure, Result};
use serde::{Deserialize, Serialize};
use std::{
    collections::BTreeSet,
    io::Read,
    process::{Child, Command, Stdio},
    time::{Duration, Instant},
};
pub(super) const SYSTEM_LABEL: &str = "app.rieul.daemon";
pub(super) const WORKER_LABEL: &str = "app.rieul.update-worker";
pub(super) const SYSTEM_PLIST: &str = "/Library/LaunchDaemons/app.rieul.daemon.plist";
pub(super) const GUI_PLIST: &str = "/Library/LaunchAgents/app.rieul.gui.plist";
pub(super) const LAUNCHER: &str = "/Applications/Rieul.app/Contents/MacOS/rieul-macos-launcher";
pub(super) const WORKER: &str = "/Library/Application Support/rieul/updates/worker";
#[derive(Clone, Copy, Debug, Eq, PartialEq, Deserialize, Serialize)]
pub(super) enum Job {
    System,
    LegacySystem,
    Worker,
    Gui(u32),
}
impl Job {
    pub fn target(self) -> Result<String> {
        Ok(match self {
            Self::System | Self::LegacySystem => format!("system/{SYSTEM_LABEL}"),
            Self::Worker => format!("system/{WORKER_LABEL}"),
            Self::Gui(uid) => {
                ensure!(uid > 0, "root GUI session unsupported");
                format!("gui/{uid}/app.rieul.gui")
            }
        })
    }
    fn expected(self) -> (&'static str, Vec<&'static str>) {
        match self {
            Self::System => (SYSTEM_PLIST, vec![SERVICE, "run"]),
            Self::LegacySystem => (
                SYSTEM_PLIST,
                vec![
                    "/Applications/Rieul.app/Contents/Library/LaunchServices/rieul-macos-system",
                    "run",
                ],
            ),
            Self::Worker => ("", vec![WORKER, "internal-update-worker"]),
            Self::Gui(_) => (GUI_PLIST, vec![LAUNCHER]),
        }
    }
}
#[derive(Clone, Debug)]
pub(super) struct JobState {
    pub pid: Option<u32>,
}
pub(super) trait Control {
    fn sessions(&mut self) -> Result<Vec<u32>>;
    fn gui_domain(&mut self, uid: u32) -> Result<bool> {
        Ok(self.sessions()?.contains(&uid))
    }
    fn inspect(&mut self, job: Job) -> Result<Option<JobState>>;
    fn stop(&mut self, job: Job) -> Result<()>;
    fn start(&mut self, job: Job) -> Result<()>;
    fn submit_worker(&mut self) -> Result<()>;
}
struct KillOnDrop(Child);
impl Drop for KillOnDrop {
    fn drop(&mut self) {
        let _ = self.0.kill();
        let _ = self.0.wait();
    }
}
/// Numeric status distinguishes an absent launchd job from authorization or
/// transport failures. Output and time are bounded and children always reaped.
pub(super) fn run(state: &Dir, tool: &str, args: &[&str]) -> Result<(i32, String)> {
    static NEXT: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(1);
    let name = format!(
        "native-{}-{}.log",
        std::process::id(),
        NEXT.fetch_add(1, std::sync::atomic::Ordering::Relaxed)
    );
    struct RemoveLog<'a>(&'a Dir, String);
    impl Drop for RemoveLog<'_> {
        fn drop(&mut self) {
            let _ = self.0.remove(&self.1);
        }
    }
    state.remove(&name)?;
    let _cleanup = RemoveLog(state, name.clone());
    let log = state.create(&name, 0o600)?;
    let mut child = KillOnDrop(
        Command::new(tool)
            .args(args)
            .env_clear()
            .env("PATH", "/usr/bin:/bin:/usr/sbin:/sbin")
            .env("LC_ALL", "C")
            .current_dir("/")
            .stdin(Stdio::null())
            .stdout(log.try_clone()?)
            .stderr(log)
            .spawn()?,
    );
    let deadline = Instant::now() + Duration::from_secs(45);
    let code = loop {
        if let Some(status) = child.0.try_wait()? {
            break status.code().unwrap_or(-1);
        }
        ensure!(
            Instant::now() < deadline && state.read_file(&name)?.metadata()?.len() <= 65536,
            "native operation exceeded bounds"
        );
        std::thread::sleep(Duration::from_millis(25));
    };
    let mut bytes = Vec::new();
    state
        .read_file(&name)?
        .take(65537)
        .read_to_end(&mut bytes)?;
    ensure!(bytes.len() <= 65536, "native output exceeds limit");
    Ok((code, String::from_utf8(bytes)?))
}
pub(super) fn checked(state: &Dir, tool: &str, args: &[&str]) -> Result<String> {
    let (code, text) = run(state, tool, args)?;
    ensure!(code == 0, "native operation failed ({tool}, status {code})");
    Ok(text)
}
fn parse_job(job: Job, text: &str) -> Result<JobState> {
    let (expected_path, args) = job.expected();
    let mut path = None;
    let mut program = None;
    let mut actual_args = Vec::new();
    let mut in_args = false;
    let mut pid = None;
    for line in text.lines() {
        if line == "\targuments = {" {
            ensure!(!in_args && actual_args.is_empty(), "duplicate arguments");
            in_args = true;
            continue;
        }
        if in_args {
            if line == "\t}" {
                in_args = false;
            } else {
                ensure!(
                    line.starts_with("\t\t") && !line[2..].contains('\t'),
                    "unexpected launchd argument format"
                );
                actual_args.push(line[2..].to_owned());
            }
            continue;
        }
        if let Some(value) = line.strip_prefix("\tpath = ") {
            ensure!(path.replace(value).is_none(), "duplicate path");
        }
        if let Some(value) = line.strip_prefix("\tprogram = ") {
            ensure!(program.replace(value).is_none(), "duplicate program");
        }
        if let Some(value) = line.strip_prefix("\tpid = ") {
            ensure!(pid.is_none(), "duplicate PID");
            let parsed: u32 = value.parse()?;
            ensure!(parsed > 1, "invalid service PID");
            pid = Some(parsed);
        }
    }
    ensure!(
        !in_args && actual_args == args && program == args.first().copied(),
        "unexpected launchd executable or arguments"
    );
    if !expected_path.is_empty() {
        ensure!(path == Some(expected_path), "unexpected launchd plist");
    }
    Ok(JobState { pid })
}
pub(super) struct Native<'a> {
    pub state: &'a Dir,
}
impl Control for Native<'_> {
    fn gui_domain(&mut self, uid: u32) -> Result<bool> {
        let (code, text) = run(
            self.state,
            "/bin/launchctl",
            &["print", &Job::Gui(uid).target()?],
        )?;
        if code == 113 && text.contains("Could not find domain") {
            return Ok(false);
        }
        if code == 0 || (code == 113 && text.contains("Could not find service")) {
            return Ok(true);
        }
        bail!("cannot inspect GUI domain")
    }

    fn sessions(&mut self) -> Result<Vec<u32>> {
        let text = checked(self.state, "/bin/ps", &["-axo", "uid="])?;
        let mut ids = BTreeSet::new();
        for line in text.lines() {
            let uid: u32 = line.trim().parse()?;
            if uid != 0 {
                ids.insert(uid);
            }
        }
        ensure!(ids.len() <= 256, "too many user domains");
        Ok(ids.into_iter().collect())
    }
    fn inspect(&mut self, job: Job) -> Result<Option<JobState>> {
        let target = job.target()?;
        let (code, text) = run(self.state, "/bin/launchctl", &["print", &target])?;
        if code == 113
            && (text.contains("Could not find service") || text.contains("Could not find domain"))
        {
            return Ok(None);
        }
        ensure!(code == 0, "cannot inspect launchd job ({code})");
        Ok(Some(parse_job(job, &text)?))
    }
    fn stop(&mut self, job: Job) -> Result<()> {
        if self.inspect(job)?.is_none() {
            return Ok(());
        }
        let target = job.target()?;
        checked(self.state, "/bin/launchctl", &["bootout", &target])?;
        let deadline = Instant::now() + Duration::from_secs(30);
        while self.inspect(job)?.is_some() {
            ensure!(Instant::now() < deadline, "service did not stop");
            std::thread::sleep(Duration::from_millis(100));
        }
        Ok(())
    }
    fn start(&mut self, job: Job) -> Result<()> {
        if self.inspect(job)?.is_some() {
            return Ok(());
        }
        let domain = match job {
            Job::System | Job::LegacySystem => "system".to_string(),
            Job::Gui(uid) => format!("gui/{uid}"),
            Job::Worker => bail!("worker must use fixed submit"),
        };
        let (path, _) = job.expected();
        checked(self.state, "/bin/launchctl", &["bootstrap", &domain, path])?;
        checked(self.state, "/bin/launchctl", &["kickstart", &job.target()?])?;
        Ok(())
    }
    fn submit_worker(&mut self) -> Result<()> {
        if let Some(job) = self.inspect(Job::Worker)? {
            if job.pid.is_some() {
                return Ok(());
            }
            self.stop(Job::Worker)?;
        }
        ensure!(WORKER == format!("{STATE}/worker"), "worker path mismatch");
        checked(
            self.state,
            "/bin/launchctl",
            &[
                "submit",
                "-l",
                WORKER_LABEL,
                "--",
                WORKER,
                "internal-update-worker",
            ],
        )?;
        Ok(())
    }
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn native_output_uses_unique_log_and_cleans_up() {
        use std::{io::Write, os::unix::fs::PermissionsExt};
        let tmp = tempfile::tempdir().unwrap();
        std::fs::set_permissions(tmp.path(), std::fs::Permissions::from_mode(0o700)).unwrap();
        let dir = Dir::open(
            &tmp.path().canonicalize().unwrap(),
            unsafe { libc::geteuid() },
            false,
        )
        .unwrap();
        dir.create("native.log", 0o600)
            .unwrap()
            .write_all(b"stale output")
            .unwrap();
        assert_eq!(
            run(&dir, "/usr/bin/printf", &["fresh output"]).unwrap(),
            (0, "fresh output".into())
        );
        assert_eq!(
            run(&dir, "/usr/bin/false", &[]).unwrap(),
            (1, String::new())
        );
        assert!(run(&dir, "/nonexistent-updater-test-command", &[]).is_err());
        let names: Vec<_> = std::fs::read_dir(tmp.path())
            .unwrap()
            .map(|e| e.unwrap().file_name())
            .collect();
        assert_eq!(names, vec![std::ffi::OsString::from("native.log")]);
    }
    #[test]
    fn parses_only_fixed_job_and_top_level_pid() {
        let text=format!("system/app.rieul.daemon = {{\n\tpath = {SYSTEM_PLIST}\n\tprogram = {SERVICE}\n\targuments = {{\n\t\t{SERVICE}\n\t\trun\n\t}}\n\tpid = 42\n\tresource = {{\n\t\tpid = 999\n\t}}\n}}");
        assert_eq!(parse_job(Job::System, &text).unwrap().pid, Some(42));
        assert!(parse_job(Job::System, &text.replace("\t\trun", "\t\tpair")).is_err());
        assert!(parse_job(Job::System, &text.replace(SERVICE, "/tmp/evil")).is_err());
        assert!(Job::Gui(0).target().is_err());
    }
}
