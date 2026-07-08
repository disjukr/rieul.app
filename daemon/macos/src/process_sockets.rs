use wgo_daemon_core::rpc::{ProcessSocketInUseInfo, ProcessSocketInUseKind, SocketEndpoint};
use wgo_daemon_core::traits::{BoxFutureResult, ProcessSocketsInUseService, ServiceError};

use crate::process_lsof::{ensure_process_exists, run_lsof, LsofEntry};

#[derive(Debug, Default, Clone, Copy)]
pub struct MacProcessSocketsInUseService;

impl ProcessSocketsInUseService for MacProcessSocketsInUseService {
    fn sockets_in_use(&self, pid: u64) -> BoxFutureResult<'_, Vec<ProcessSocketInUseInfo>> {
        Box::pin(async move {
            tokio::task::spawn_blocking(move || snapshot_process_sockets_in_use(pid))
                .await
                .map_err(|err| ServiceError::OperationFailed(err.to_string()))?
        })
    }
}

fn snapshot_process_sockets_in_use(pid: u64) -> Result<Vec<ProcessSocketInUseInfo>, ServiceError> {
    let pid = ensure_process_exists(pid)?;
    let mut rows = Vec::new();
    rows.extend(socket_rows(&[
        "-nP".to_string(),
        "-a".to_string(),
        "-p".to_string(),
        pid.to_string(),
        "-iTCP".to_string(),
        "-iUDP".to_string(),
        "-F".to_string(),
        "pcftnPT".to_string(),
    ])?);
    rows.extend(socket_rows(&[
        "-nP".to_string(),
        "-a".to_string(),
        "-p".to_string(),
        pid.to_string(),
        "-U".to_string(),
        "-F".to_string(),
        "pcftnPT".to_string(),
    ])?);
    rows.sort_by(|a, b| {
        socket_kind_sort_key(&a.kind)
            .cmp(&socket_kind_sort_key(&b.kind))
            .then_with(|| {
                endpoint_sort_key(&a.local_endpoint).cmp(&endpoint_sort_key(&b.local_endpoint))
            })
            .then_with(|| {
                endpoint_sort_key(&a.remote_endpoint).cmp(&endpoint_sort_key(&b.remote_endpoint))
            })
            .then_with(|| a.listening.cmp(&b.listening))
            .then_with(|| a.socket_id.cmp(&b.socket_id))
    });
    Ok(rows)
}

fn socket_rows(args: &[String]) -> Result<Vec<ProcessSocketInUseInfo>, ServiceError> {
    Ok(run_lsof(args)?.into_iter().filter_map(socket_row).collect())
}

fn socket_row(entry: LsofEntry) -> Option<ProcessSocketInUseInfo> {
    match entry.file_type.as_deref()? {
        "IPv4" | "IPv6" => ip_socket_row(entry),
        "unix" => unix_socket_row(entry.fd?, entry.name),
        _ => None,
    }
}

fn ip_socket_row(entry: LsofEntry) -> Option<ProcessSocketInUseInfo> {
    let fd = entry.fd?;
    let name = entry.name?;
    let (local, remote) = split_socket_name(&name);
    let local_endpoint = parse_ip_endpoint(local)?;
    let remote_endpoint = remote.and_then(parse_ip_endpoint);
    let kind = match entry.protocol.as_deref() {
        Some("TCP") => ProcessSocketInUseKind::Tcp,
        Some("UDP") => ProcessSocketInUseKind::Udp,
        _ => ProcessSocketInUseKind::Unknown,
    };
    let listening = match kind {
        ProcessSocketInUseKind::Tcp => Some(entry.tcp_state.as_deref() == Some("LISTEN")),
        ProcessSocketInUseKind::Udp => Some(remote_endpoint.is_none()),
        _ => None,
    };

    Some(ProcessSocketInUseInfo {
        socket_id: fd,
        kind,
        local_endpoint: Some(local_endpoint),
        remote_endpoint,
        listening,
    })
}

fn unix_socket_row(fd: String, name: Option<String>) -> Option<ProcessSocketInUseInfo> {
    let endpoint = name.as_deref().map(unix_endpoint);
    Some(ProcessSocketInUseInfo {
        socket_id: fd,
        kind: ProcessSocketInUseKind::Unix,
        local_endpoint: endpoint,
        remote_endpoint: None,
        listening: None,
    })
}

fn split_socket_name(name: &str) -> (&str, Option<&str>) {
    match name.split_once("->") {
        Some((local, remote)) => (local, Some(remote)),
        None => (name, None),
    }
}

fn parse_ip_endpoint(value: &str) -> Option<SocketEndpoint> {
    let value = value.trim();
    if value.is_empty() {
        return None;
    }

    let (address, port) = if let Some(rest) = value.strip_prefix('[') {
        let (address, rest) = rest.split_once("]:")?;
        (address.to_string(), rest.parse::<u64>().ok())
    } else if let Some((address, port)) = value.rsplit_once(':') {
        (normalize_address(address), port.parse::<u64>().ok())
    } else {
        (normalize_address(value), None)
    };

    Some(SocketEndpoint::Ip { address, port })
}

fn normalize_address(address: &str) -> String {
    match address {
        "*" => "0.0.0.0".to_string(),
        value => value.to_string(),
    }
}

fn unix_endpoint(name: &str) -> SocketEndpoint {
    if name.starts_with('/') {
        SocketEndpoint::Unix {
            path: Some(name.to_string()),
            name: None,
        }
    } else {
        SocketEndpoint::Unix {
            path: None,
            name: Some(name.to_string()),
        }
    }
}

fn endpoint_sort_key(endpoint: &Option<SocketEndpoint>) -> String {
    match endpoint {
        Some(SocketEndpoint::Ip { address, port }) => {
            format!("{address}:{}", port.unwrap_or_default())
        }
        Some(SocketEndpoint::Unix { path, name }) => path
            .as_deref()
            .or(name.as_deref())
            .unwrap_or_default()
            .to_string(),
        None => String::new(),
    }
}

fn socket_kind_sort_key(kind: &ProcessSocketInUseKind) -> u8 {
    match kind {
        ProcessSocketInUseKind::Tcp => 0,
        ProcessSocketInUseKind::Udp => 1,
        ProcessSocketInUseKind::Unix => 2,
        ProcessSocketInUseKind::Raw => 3,
        ProcessSocketInUseKind::Unknown => 4,
    }
}

#[cfg(test)]
mod tests {
    use std::net::TcpListener;

    use super::*;
    use crate::process_lsof::parse_lsof_entries;

    #[test]
    fn maps_tcp_listener() {
        let entries = parse_lsof_entries("f3\ntIPv4\nPTCP\nn127.0.0.1:8080\nTST=LISTEN\n").unwrap();
        let row = socket_row(entries.into_iter().next().unwrap()).unwrap();

        assert_eq!(row.kind, ProcessSocketInUseKind::Tcp);
        assert_eq!(row.listening, Some(true));
        assert_eq!(
            row.local_endpoint,
            Some(SocketEndpoint::Ip {
                address: "127.0.0.1".to_string(),
                port: Some(8080)
            })
        );
    }

    #[test]
    fn maps_established_tcp_socket() {
        let entries = parse_lsof_entries(
            "f4\ntIPv4\nPTCP\nn127.0.0.1:50000->127.0.0.1:8080\nTST=ESTABLISHED\n",
        )
        .unwrap();
        let row = socket_row(entries.into_iter().next().unwrap()).unwrap();

        assert_eq!(row.kind, ProcessSocketInUseKind::Tcp);
        assert_eq!(row.listening, Some(false));
        assert!(row.remote_endpoint.is_some());
    }

    #[test]
    fn maps_unix_socket() {
        let entries = parse_lsof_entries("f3\ntunix\nn->0xabc\n").unwrap();
        let row = socket_row(entries.into_iter().next().unwrap()).unwrap();

        assert_eq!(row.kind, ProcessSocketInUseKind::Unix);
        assert_eq!(
            row.local_endpoint,
            Some(SocketEndpoint::Unix {
                path: None,
                name: Some("->0xabc".to_string())
            })
        );
    }

    #[test]
    fn finds_tcp_listener_owned_by_current_process() {
        let listener = TcpListener::bind(("127.0.0.1", 0)).unwrap();
        let port = listener.local_addr().unwrap().port() as u64;

        let rows = snapshot_process_sockets_in_use(std::process::id() as u64).unwrap();

        assert!(rows.iter().any(|row| {
            row.kind == ProcessSocketInUseKind::Tcp
                && row.listening == Some(true)
                && row.local_endpoint
                    == Some(SocketEndpoint::Ip {
                        address: "127.0.0.1".to_string(),
                        port: Some(port),
                    })
        }));
    }
}
