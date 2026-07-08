use std::process::Command;

use wgo_daemon_core::traits::ServiceError;

const LSOF: &str = "/usr/sbin/lsof";

#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct LsofEntry {
    pub fd: Option<String>,
    pub file_type: Option<String>,
    pub protocol: Option<String>,
    pub name: Option<String>,
    pub tcp_state: Option<String>,
}

pub fn ensure_process_exists(pid: u64) -> Result<u32, ServiceError> {
    let pid = i32::try_from(pid).map_err(|_| ServiceError::NotFound)?;
    let result = unsafe { libc::kill(pid, 0) };
    if result == 0 {
        return u32::try_from(pid).map_err(|_| ServiceError::NotFound);
    }

    match std::io::Error::last_os_error().raw_os_error() {
        Some(libc::ESRCH) => Err(ServiceError::NotFound),
        Some(libc::EPERM) => Err(ServiceError::PermissionDenied),
        Some(code) => Err(ServiceError::OperationFailed(format!(
            "kill({pid}, 0) failed: {code}"
        ))),
        None => Err(ServiceError::OperationFailed(format!(
            "kill({pid}, 0) failed"
        ))),
    }
}

pub fn run_lsof(args: &[String]) -> Result<Vec<LsofEntry>, ServiceError> {
    let output = Command::new(LSOF)
        .args(args)
        .output()
        .map_err(|err| ServiceError::OperationFailed(format!("run {LSOF}: {err}")))?;

    if !output.status.success() && output.stdout.is_empty() {
        let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
        if stderr.is_empty() {
            return Ok(Vec::new());
        }
        return Err(map_lsof_error(&stderr));
    }

    parse_lsof_entries(&String::from_utf8_lossy(&output.stdout))
}

pub fn parse_lsof_entries(text: &str) -> Result<Vec<LsofEntry>, ServiceError> {
    let mut entries = Vec::new();
    let mut current = LsofEntry::default();

    for line in text.lines().filter(|line| !line.is_empty()) {
        let (field, value) = line.split_at(1);
        match field {
            "p" | "c" => {}
            "f" => {
                if current.fd.is_some() {
                    entries.push(current);
                    current = LsofEntry::default();
                }
                current.fd = Some(value.to_string());
            }
            "t" => current.file_type = Some(value.to_string()),
            "P" => current.protocol = Some(value.to_ascii_uppercase()),
            "n" => current.name = Some(value.to_string()),
            "T" => {
                if let Some(state) = value.strip_prefix("ST=") {
                    current.tcp_state = Some(state.to_ascii_uppercase());
                }
            }
            _ => {}
        }
    }

    if current.fd.is_some() {
        entries.push(current);
    }

    Ok(entries)
}

fn map_lsof_error(message: &str) -> ServiceError {
    let lower = message.to_ascii_lowercase();
    if lower.contains("permission") || lower.contains("denied") {
        ServiceError::PermissionDenied
    } else if lower.contains("no such process") || lower.contains("not found") {
        ServiceError::NotFound
    } else {
        ServiceError::OperationFailed(message.to_string())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_file_entries() {
        let rows =
            parse_lsof_entries("p1\nczsh\nfcwd\ntDIR\nn/tmp\nf1\ntPIPE\nn->0xabc\n").unwrap();

        assert_eq!(rows.len(), 2);
        assert_eq!(rows[0].fd.as_deref(), Some("cwd"));
        assert_eq!(rows[0].file_type.as_deref(), Some("DIR"));
        assert_eq!(rows[0].name.as_deref(), Some("/tmp"));
        assert_eq!(rows[1].fd.as_deref(), Some("1"));
        assert_eq!(rows[1].file_type.as_deref(), Some("PIPE"));
    }

    #[test]
    fn parses_socket_protocol_and_state() {
        let rows =
            parse_lsof_entries("p1\nf3\ntIPv4\nPTCP\nn127.0.0.1:8080\nTST=LISTEN\n").unwrap();

        assert_eq!(rows.len(), 1);
        assert_eq!(rows[0].protocol.as_deref(), Some("TCP"));
        assert_eq!(rows[0].tcp_state.as_deref(), Some("LISTEN"));
    }
}
