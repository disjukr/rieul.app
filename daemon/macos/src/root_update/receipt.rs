//! Readiness is emitted by the actual daemon after DB and transport startup.
use super::{preparation, store::Dir, verify, DATABASE_SCHEMA, SERVICE, STATE};
use anyhow::{ensure, Result};
use serde::{Deserialize, Serialize};
use std::path::Path;

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub(super) struct Request {
    pub nonce: String,
    pub daemon_sha256: String,
}
#[derive(Debug, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub(super) struct Receipt {
    pub request: Request,
    pub pid: u32,
    pub database_schema: u32,
}
impl Request {
    pub fn validate(&self) -> Result<()> {
        for value in [&self.nonce, &self.daemon_sha256] {
            ensure!(
                value.len() == 64
                    && value
                        .bytes()
                        .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b)),
                "invalid readiness binding"
            );
        }
        Ok(())
    }
}
/// Capture once before opening the DB, never read a new request at callback
/// time: an already-running old process must not acknowledge a later start.
pub(super) fn capture(state: &Dir, own_hash: &str) -> Result<Option<Request>> {
    let request: Option<Request> = state.load("start-request.json")?;
    if let Some(request) = &request {
        request.validate()?;
        ensure!(
            request.daemon_sha256 == own_hash,
            "wrong daemon for start request"
        );
    }
    Ok(request)
}
pub(super) fn write(state: &Dir, request: Request, pid: u32, schema: u32) -> Result<()> {
    request.validate()?;
    ensure!(
        pid > 1 && schema == DATABASE_SCHEMA,
        "invalid ready process/schema"
    );
    ensure!(
        state.load::<Request>("start-request.json")?.as_ref() == Some(&request),
        "start request changed before readiness"
    );
    state.save(
        "ready.json",
        &Receipt {
            request,
            pid,
            database_schema: schema,
        },
    )
}
pub(super) fn matches(
    receipt: &Receipt,
    request: &Request,
    launchd_pid: u32,
    observed_hash: &str,
) -> bool {
    receipt.request == *request
        && receipt.pid == launchd_pid
        && launchd_pid > 1
        && receipt.database_schema == DATABASE_SCHEMA
        && observed_hash == request.daemon_sha256
}
#[cfg(target_os = "macos")]
pub fn startup_callback() -> Result<Option<std::sync::Arc<dyn Fn() -> Result<()> + Send + Sync>>> {
    if unsafe { libc::geteuid() } != 0 || std::env::current_exe()? != Path::new(SERVICE) {
        return Ok(None);
    }
    if !Path::new(STATE).exists() {
        return Ok(None);
    }
    let state = Dir::open(Path::new(STATE), 0, true)?;
    state.require_private()?;
    let service = Dir::open(Path::new(SERVICE).parent().unwrap(), 0, true)?;
    let own_hash = verify::digest(service.read_file("rieul-macos-system")?)?;
    let Some(request) = capture(&state, &own_hash)? else {
        return Ok(None);
    };
    Ok(Some(std::sync::Arc::new(move || {
        let state = Dir::open(Path::new(STATE), 0, true)?;
        let data = Dir::open(Path::new("/Library/Application Support/rieul"), 0, true)?;
        write(
            &state,
            request.clone(),
            std::process::id(),
            preparation::database_schema(&data)?,
        )
    })))
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn rejects_stale_nonce_pid_digest_and_schema() {
        let request = Request {
            nonce: "a".repeat(64),
            daemon_sha256: "b".repeat(64),
        };
        let mut receipt = Receipt {
            request: request.clone(),
            pid: 42,
            database_schema: 2,
        };
        assert!(matches(&receipt, &request, 42, &"b".repeat(64)));
        assert!(!matches(&receipt, &request, 43, &"b".repeat(64)));
        assert!(!matches(&receipt, &request, 42, &"c".repeat(64)));
        receipt.request.nonce = "d".repeat(64);
        assert!(!matches(&receipt, &request, 42, &"b".repeat(64)));
        receipt.request = request.clone();
        receipt.database_schema = 3;
        assert!(!matches(&receipt, &request, 42, &"b".repeat(64)));
    }
}
