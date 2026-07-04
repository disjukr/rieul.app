#[cfg(windows)]
mod platform {
    use std::ffi::c_void;
    use std::mem::size_of;
    use std::net::{Ipv4Addr, Ipv6Addr};

    use wgo_daemon_core::rpc::{ProcessSocketInUseInfo, ProcessSocketInUseKind, SocketEndpoint};
    use wgo_daemon_core::traits::{BoxFutureResult, ProcessSocketsInUseService, ServiceError};
    use windows::core::Error as WindowsError;
    use windows::Win32::Foundation::{CloseHandle, ERROR_INSUFFICIENT_BUFFER, NO_ERROR};
    use windows::Win32::NetworkManagement::IpHelper::{
        GetExtendedTcpTable, GetExtendedUdpTable, MIB_TCP6ROW_OWNER_PID, MIB_TCP6TABLE_OWNER_PID,
        MIB_TCPROW_OWNER_PID, MIB_TCPTABLE_OWNER_PID, MIB_TCP_STATE_LISTEN, MIB_UDP6ROW_OWNER_PID,
        MIB_UDP6TABLE_OWNER_PID, MIB_UDPROW_OWNER_PID, MIB_UDPTABLE_OWNER_PID,
        TCP_TABLE_OWNER_PID_ALL, UDP_TABLE_OWNER_PID,
    };
    use windows::Win32::Networking::WinSock::{AF_INET, AF_INET6};
    use windows::Win32::System::Threading::{OpenProcess, PROCESS_QUERY_LIMITED_INFORMATION};

    #[derive(Debug, Default, Clone, Copy)]
    pub struct WindowsProcessSocketsInUseService;

    impl ProcessSocketsInUseService for WindowsProcessSocketsInUseService {
        fn sockets_in_use(&self, pid: u64) -> BoxFutureResult<'_, Vec<ProcessSocketInUseInfo>> {
            Box::pin(async move {
                tokio::task::spawn_blocking(move || snapshot_process_sockets_in_use(pid))
                    .await
                    .map_err(|err| ServiceError::OperationFailed(err.to_string()))?
            })
        }
    }

    fn snapshot_process_sockets_in_use(
        pid: u64,
    ) -> Result<Vec<ProcessSocketInUseInfo>, ServiceError> {
        let pid = u32::try_from(pid).map_err(|_| ServiceError::NotFound)?;
        ensure_process_exists(pid)?;

        let mut rows = Vec::new();
        rows.extend(tcp4_rows(pid)?);
        rows.extend(tcp6_rows(pid)?);
        rows.extend(udp4_rows(pid)?);
        rows.extend(udp6_rows(pid)?);
        rows.sort_by(|a, b| {
            socket_kind_sort_key(&a.kind)
                .cmp(&socket_kind_sort_key(&b.kind))
                .then_with(|| {
                    endpoint_sort_key(&a.local_endpoint).cmp(&endpoint_sort_key(&b.local_endpoint))
                })
                .then_with(|| {
                    endpoint_sort_key(&a.remote_endpoint)
                        .cmp(&endpoint_sort_key(&b.remote_endpoint))
                })
                .then_with(|| a.listening.cmp(&b.listening))
                .then_with(|| a.socket_id.cmp(&b.socket_id))
        });
        merge_equivalent_socket_rows(&mut rows);
        assign_unique_socket_ids(&mut rows);
        Ok(rows)
    }

    fn ensure_process_exists(pid: u32) -> Result<(), ServiceError> {
        let handle = unsafe { OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, false, pid) };
        match handle {
            Ok(handle) => {
                unsafe {
                    let _ = CloseHandle(handle);
                }
                Ok(())
            }
            Err(err) => Err(map_open_process_error(err)),
        }
    }

    fn map_open_process_error(err: WindowsError) -> ServiceError {
        let message = err.to_string();
        let lower = message.to_ascii_lowercase();
        if lower.contains("access") || lower.contains("denied") || lower.contains("permission") {
            ServiceError::PermissionDenied
        } else {
            ServiceError::NotFound
        }
    }

    fn tcp4_rows(pid: u32) -> Result<Vec<ProcessSocketInUseInfo>, ServiceError> {
        let buffer = query_tcp_table(AF_INET.0.into())?;
        let table = buffer.as_ptr() as *const MIB_TCPTABLE_OWNER_PID;
        let count = unsafe { (*table).dwNumEntries as usize };
        let rows = unsafe { std::slice::from_raw_parts((*table).table.as_ptr(), count) };
        Ok(rows
            .iter()
            .filter(|row| row.dwOwningPid == pid)
            .map(tcp4_row)
            .collect())
    }

    fn tcp6_rows(pid: u32) -> Result<Vec<ProcessSocketInUseInfo>, ServiceError> {
        let buffer = query_tcp_table(AF_INET6.0.into())?;
        let table = buffer.as_ptr() as *const MIB_TCP6TABLE_OWNER_PID;
        let count = unsafe { (*table).dwNumEntries as usize };
        let rows = unsafe { std::slice::from_raw_parts((*table).table.as_ptr(), count) };
        Ok(rows
            .iter()
            .filter(|row| row.dwOwningPid == pid)
            .map(tcp6_row)
            .collect())
    }

    fn udp4_rows(pid: u32) -> Result<Vec<ProcessSocketInUseInfo>, ServiceError> {
        let buffer = query_udp_table(AF_INET.0.into())?;
        let table = buffer.as_ptr() as *const MIB_UDPTABLE_OWNER_PID;
        let count = unsafe { (*table).dwNumEntries as usize };
        let rows = unsafe { std::slice::from_raw_parts((*table).table.as_ptr(), count) };
        Ok(rows
            .iter()
            .filter(|row| row.dwOwningPid == pid)
            .map(udp4_row)
            .collect())
    }

    fn udp6_rows(pid: u32) -> Result<Vec<ProcessSocketInUseInfo>, ServiceError> {
        let buffer = query_udp_table(AF_INET6.0.into())?;
        let table = buffer.as_ptr() as *const MIB_UDP6TABLE_OWNER_PID;
        let count = unsafe { (*table).dwNumEntries as usize };
        let rows = unsafe { std::slice::from_raw_parts((*table).table.as_ptr(), count) };
        Ok(rows
            .iter()
            .filter(|row| row.dwOwningPid == pid)
            .map(udp6_row)
            .collect())
    }

    fn query_tcp_table(address_family: u32) -> Result<Vec<u8>, ServiceError> {
        let mut size = 0u32;
        let first = unsafe {
            GetExtendedTcpTable(
                None,
                &mut size,
                false,
                address_family,
                TCP_TABLE_OWNER_PID_ALL,
                0,
            )
        };
        if first != ERROR_INSUFFICIENT_BUFFER.0 && first != NO_ERROR.0 {
            return Err(windows_error("GetExtendedTcpTable", first));
        }
        let mut buffer = vec![0u8; size.max(size_of::<MIB_TCPTABLE_OWNER_PID>() as u32) as usize];
        let result = unsafe {
            GetExtendedTcpTable(
                Some(buffer.as_mut_ptr() as *mut c_void),
                &mut size,
                false,
                address_family,
                TCP_TABLE_OWNER_PID_ALL,
                0,
            )
        };
        if result == NO_ERROR.0 {
            Ok(buffer)
        } else {
            Err(windows_error("GetExtendedTcpTable", result))
        }
    }

    fn query_udp_table(address_family: u32) -> Result<Vec<u8>, ServiceError> {
        let mut size = 0u32;
        let first = unsafe {
            GetExtendedUdpTable(
                None,
                &mut size,
                false,
                address_family,
                UDP_TABLE_OWNER_PID,
                0,
            )
        };
        if first != ERROR_INSUFFICIENT_BUFFER.0 && first != NO_ERROR.0 {
            return Err(windows_error("GetExtendedUdpTable", first));
        }
        let mut buffer = vec![0u8; size.max(size_of::<MIB_UDPTABLE_OWNER_PID>() as u32) as usize];
        let result = unsafe {
            GetExtendedUdpTable(
                Some(buffer.as_mut_ptr() as *mut c_void),
                &mut size,
                false,
                address_family,
                UDP_TABLE_OWNER_PID,
                0,
            )
        };
        if result == NO_ERROR.0 {
            Ok(buffer)
        } else {
            Err(windows_error("GetExtendedUdpTable", result))
        }
    }

    fn windows_error(api: &str, code: u32) -> ServiceError {
        ServiceError::OperationFailed(format!("{api} failed: {code}"))
    }

    fn tcp4_row(row: &MIB_TCPROW_OWNER_PID) -> ProcessSocketInUseInfo {
        let local = ipv4_endpoint(row.dwLocalAddr, row.dwLocalPort);
        let remote = Some(ipv4_endpoint(row.dwRemoteAddr, row.dwRemotePort))
            .filter(|endpoint| !is_unspecified_ip_endpoint(endpoint));
        let listening = Some(row.dwState == MIB_TCP_STATE_LISTEN.0 as u32);
        ProcessSocketInUseInfo {
            socket_id: socket_id("tcp4", &local, &remote),
            kind: ProcessSocketInUseKind::Tcp,
            local_endpoint: Some(local),
            remote_endpoint: remote,
            listening,
        }
    }

    fn tcp6_row(row: &MIB_TCP6ROW_OWNER_PID) -> ProcessSocketInUseInfo {
        let local = ipv6_endpoint(row.ucLocalAddr, row.dwLocalPort);
        let remote = Some(ipv6_endpoint(row.ucRemoteAddr, row.dwRemotePort))
            .filter(|endpoint| !is_unspecified_ip_endpoint(endpoint));
        let listening = Some(row.dwState == MIB_TCP_STATE_LISTEN.0 as u32);
        ProcessSocketInUseInfo {
            socket_id: socket_id("tcp6", &local, &remote),
            kind: ProcessSocketInUseKind::Tcp,
            local_endpoint: Some(local),
            remote_endpoint: remote,
            listening,
        }
    }

    fn udp4_row(row: &MIB_UDPROW_OWNER_PID) -> ProcessSocketInUseInfo {
        let local = ipv4_endpoint(row.dwLocalAddr, row.dwLocalPort);
        ProcessSocketInUseInfo {
            socket_id: socket_id("udp4", &local, &None),
            kind: ProcessSocketInUseKind::Udp,
            local_endpoint: Some(local),
            remote_endpoint: None,
            listening: Some(true),
        }
    }

    fn udp6_row(row: &MIB_UDP6ROW_OWNER_PID) -> ProcessSocketInUseInfo {
        let local = ipv6_endpoint(row.ucLocalAddr, row.dwLocalPort);
        ProcessSocketInUseInfo {
            socket_id: socket_id("udp6", &local, &None),
            kind: ProcessSocketInUseKind::Udp,
            local_endpoint: Some(local),
            remote_endpoint: None,
            listening: Some(true),
        }
    }

    fn ipv4_endpoint(address: u32, port: u32) -> SocketEndpoint {
        SocketEndpoint::Ip {
            address: Ipv4Addr::from(u32::from_be(address)).to_string(),
            port: Some(port_from_network_order(port)),
        }
    }

    fn ipv6_endpoint(address: [u8; 16], port: u32) -> SocketEndpoint {
        SocketEndpoint::Ip {
            address: Ipv6Addr::from(address).to_string(),
            port: Some(port_from_network_order(port)),
        }
    }

    fn port_from_network_order(port: u32) -> u64 {
        u64::from(u16::from_be(port as u16))
    }

    fn is_unspecified_ip_endpoint(endpoint: &SocketEndpoint) -> bool {
        match endpoint {
            SocketEndpoint::Ip { address, port } => {
                port.unwrap_or_default() == 0 && (address == "0.0.0.0" || address == "::")
            }
            SocketEndpoint::Unix { .. } => false,
        }
    }

    fn socket_id(prefix: &str, local: &SocketEndpoint, remote: &Option<SocketEndpoint>) -> String {
        match remote {
            Some(remote) => format!(
                "{prefix}:{}->{}",
                endpoint_sort_key(&Some(local.clone())),
                endpoint_sort_key(&Some(remote.clone()))
            ),
            None => format!("{prefix}:{}", endpoint_sort_key(&Some(local.clone()))),
        }
    }

    fn assign_unique_socket_ids(rows: &mut [ProcessSocketInUseInfo]) {
        let mut counts = std::collections::BTreeMap::<String, usize>::new();
        for row in rows {
            let base = row.socket_id.clone();
            let count = counts.entry(base.clone()).or_default();
            if *count > 0 {
                row.socket_id = format!("{base}#{}", *count + 1);
            }
            *count += 1;
        }
    }

    fn merge_equivalent_socket_rows(rows: &mut Vec<ProcessSocketInUseInfo>) {
        rows.dedup_by(|a, b| socket_row_key(a) == socket_row_key(b));
    }

    fn socket_row_key(row: &ProcessSocketInUseInfo) -> String {
        format!(
            "{}|{}|{}|{}",
            socket_kind_sort_key(&row.kind),
            endpoint_sort_key(&row.local_endpoint),
            endpoint_sort_key(&row.remote_endpoint),
            match row.listening {
                Some(true) => "listening",
                Some(false) => "not-listening",
                None => "unknown",
            },
        )
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

        #[test]
        fn finds_tcp_listener_owned_by_current_process() {
            let listener = TcpListener::bind(("127.0.0.1", 0)).unwrap();
            let port = listener.local_addr().unwrap().port() as u64;

            let rows = snapshot_process_sockets_in_use(std::process::id() as u64).unwrap();

            assert!(rows.iter().any(|row| {
                matches!(row.kind, ProcessSocketInUseKind::Tcp)
                    && row.listening == Some(true)
                    && matches!(
                            &row.local_endpoint,
                            Some(SocketEndpoint::Ip { port: Some(local_port), .. })
                                if *local_port == port
                    )
            }));
        }

        #[test]
        fn merges_equivalent_socket_rows() {
            let endpoint = SocketEndpoint::Ip {
                address: "0.0.0.0".to_string(),
                port: Some(5353),
            };
            let mut rows = vec![
                ProcessSocketInUseInfo {
                    socket_id: socket_id("udp4", &endpoint, &None),
                    kind: ProcessSocketInUseKind::Udp,
                    local_endpoint: Some(endpoint.clone()),
                    remote_endpoint: None,
                    listening: Some(true),
                },
                ProcessSocketInUseInfo {
                    socket_id: socket_id("udp4", &endpoint, &None),
                    kind: ProcessSocketInUseKind::Udp,
                    local_endpoint: Some(endpoint),
                    remote_endpoint: None,
                    listening: Some(true),
                },
            ];

            merge_equivalent_socket_rows(&mut rows);

            assert_eq!(rows.len(), 1);
            assert_eq!(rows[0].socket_id, "udp4:0.0.0.0:5353");
        }
    }
}

#[cfg(windows)]
pub use platform::WindowsProcessSocketsInUseService;
