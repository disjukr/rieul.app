use super::{
    launchd::{Control, Job},
    store::Dir,
    SERVICE, STATE,
};
use anyhow::{ensure, Result};
use rieul_daemon_host::maintenance::{DrainRequest, DrainState, MaintenanceHooks};
use serde::{Deserialize, Serialize};
use std::{
    path::Path,
    sync::Arc,
    time::{Duration, Instant},
};
#[derive(Debug)]
pub(super) struct Deferred(pub String);
impl std::fmt::Display for Deferred {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "update deferred: {}", self.0)
    }
}
impl std::error::Error for Deferred {}
fn deferred(reason: impl Into<String>) -> anyhow::Error {
    Deferred(reason.into()).into()
}
#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub(super) struct Intent {
    pub nonce: String,
    pub commit: bool,
    #[serde(default)]
    pub manual: bool,
}
#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub(super) struct Response {
    pub nonce: String,
    pub pid: u32,
    pub state: String,
    pub remaining_ms: u64,
    pub monotonic_ms: u64,
    pub reason: String,
}
pub(super) fn monotonic_ms() -> Result<u64> {
    let mut time = std::mem::MaybeUninit::<libc::timespec>::uninit();
    ensure!(
        unsafe { libc::clock_gettime(libc::CLOCK_MONOTONIC, time.as_mut_ptr()) } == 0,
        "monotonic clock failed"
    );
    let time = unsafe { time.assume_init() };
    Ok(time.tv_sec as u64 * 1000 + time.tv_nsec as u64 / 1_000_000)
}
fn nonce_valid(nonce: &str) -> bool {
    nonce.len() == 64
        && nonce
            .bytes()
            .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
}
#[cfg(target_os = "macos")]
pub fn hooks() -> Result<Option<Arc<MaintenanceHooks>>> {
    if unsafe { libc::geteuid() } != 0
        || std::env::current_exe()? != Path::new(SERVICE)
        || !Path::new(STATE).exists()
    {
        return Ok(None);
    }
    Ok(Some(Arc::new(MaintenanceHooks {
        request: Arc::new(|| {
            let state = Dir::open(Path::new(STATE), 0, true)?;
            state.require_private()?;
            let request: Option<Intent> = state.load("drain-request.json")?;
            request
                .map(|r| {
                    ensure!(nonce_valid(&r.nonce), "invalid drain nonce");
                    Ok(DrainRequest {
                        nonce: r.nonce,
                        commit: r.commit,
                        manual: r.manual,
                    })
                })
                .transpose()
        }),
        report: Arc::new(|nonce, status| {
            let state = Dir::open(Path::new(STATE), 0, true)?;
            let (name, remaining_ms, reason) = match status {
                DrainState::Granted { remaining_ms } => ("granted", remaining_ms, String::new()),
                DrainState::Exiting => ("exiting", 0, String::new()),
                DrainState::Expired => ("expired", 0, "drain lease expired".into()),
                DrainState::Busy(work) => (
                    "busy",
                    0,
                    format!(
                        "connections={}, terminals={}, commands={}, agents={}",
                        work.connections, work.terminals, work.commands, work.agents
                    ),
                ),
            };
            state.save(
                "drain-response.json",
                &Response {
                    nonce: nonce.to_owned(),
                    pid: std::process::id(),
                    state: name.into(),
                    remaining_ms,
                    monotonic_ms: monotonic_ms()?,
                    reason,
                },
            )
        }),
    })))
}
/// A worker only bootouts after the serving process acknowledges an idle exit.
/// No timeout/busy/error path grants authority to kill an active daemon.
pub(super) fn request_exit(
    state: &Dir,
    control: &mut impl Control,
    nonce: &str,
    manual: bool,
) -> Result<()> {
    ensure!(nonce_valid(nonce), "invalid drain nonce");
    let Some(job) = control.inspect(Job::System)? else {
        return Ok(());
    };
    let Some(pid) = job.pid else { return Ok(()) };
    #[cfg(target_os = "macos")]
    if let Some(parked) = state.load::<super::runtime::Parked>("parked.json")? {
        if parked.nonce == nonce && parked.pid == pid {
            let service = Dir::open(Path::new(SERVICE).parent().unwrap(), 0, true)?;
            ensure!(
                super::verify::digest(service.read_file("rieul-macos-system")?)?
                    == parked.daemon_sha256,
                "parked runtime changed"
            );
            super::launchd::checked(
                state,
                "/usr/bin/codesign",
                &[
                    "--verify",
                    "--strict",
                    "-R",
                    &super::verify::requirement(super::DAEMON_ID),
                    &pid.to_string(),
                ],
            )?;
            return Ok(());
        }
    }

    use std::io::Read;
    let mut random = [0u8; 32];
    std::fs::File::open("/dev/urandom")?.read_exact(&mut random)?;
    let attempt: String = random.iter().map(|b| format!("{b:02x}")).collect();
    let nonce = attempt.as_str();
    state.remove("drain-response.json")?;
    state.save(
        "drain-request.json",
        &Intent {
            nonce: nonce.into(),
            commit: false,
            manual,
        },
    )?;
    let deadline = Instant::now() + Duration::from_secs(8);
    let mut committed = false;
    loop {
        if let Some(response) = state.load::<Response>("drain-response.json")? {
            if response.nonce == nonce && response.pid == pid {
                match response.state.as_str() {
                    "busy" => return Err(deferred(response.reason)),
                    "expired" => return Err(deferred("drain lease expired")),
                    "granted" if !committed => {
                        let age = monotonic_ms()?.saturating_sub(response.monotonic_ms);
                        if age >= 1000 || response.remaining_ms <= age + 5000 {
                            return Err(deferred("stale drain grant"));
                        }
                        state.save(
                            "drain-request.json",
                            &Intent {
                                nonce: nonce.into(),
                                commit: true,
                                manual,
                            },
                        )?;
                        committed = true;
                    }
                    "exiting" if committed => return Ok(()),
                    _ => {}
                }
            }
        }
        if Instant::now() >= deadline {
            return Err(deferred("no drain acknowledgement"));
        }
        std::thread::sleep(Duration::from_millis(50));
    }
}
