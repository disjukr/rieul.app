use wgo_daemon_core::rpc::{
    ProcessResourceInUseAccess, ProcessResourceInUseInfo, ProcessResourceInUseKind,
};
use wgo_daemon_core::traits::{BoxFutureResult, ProcessResourcesInUseService, ServiceError};

use crate::process_lsof::{ensure_process_exists, run_lsof, LsofEntry};

#[derive(Debug, Default, Clone, Copy)]
pub struct MacProcessResourcesInUseService;

impl ProcessResourcesInUseService for MacProcessResourcesInUseService {
    fn resources_in_use(&self, pid: u64) -> BoxFutureResult<'_, Vec<ProcessResourceInUseInfo>> {
        Box::pin(async move {
            tokio::task::spawn_blocking(move || snapshot_process_resources_in_use(pid))
                .await
                .map_err(|err| ServiceError::OperationFailed(err.to_string()))?
        })
    }
}

fn snapshot_process_resources_in_use(
    pid: u64,
) -> Result<Vec<ProcessResourceInUseInfo>, ServiceError> {
    let pid = ensure_process_exists(pid)?;
    let args = vec![
        "-nP".to_string(),
        "-p".to_string(),
        pid.to_string(),
        "-F".to_string(),
        "pcftn".to_string(),
    ];
    let mut rows = run_lsof(&args)?
        .into_iter()
        .filter_map(resource_row)
        .collect::<Vec<_>>();
    rows.sort_by(|a, b| {
        resource_kind_sort_key(a.kind)
            .cmp(&resource_kind_sort_key(b.kind))
            .then_with(|| a.name.cmp(&b.name))
            .then_with(|| a.resource_id.cmp(&b.resource_id))
    });
    Ok(rows)
}

fn resource_row(entry: LsofEntry) -> Option<ProcessResourceInUseInfo> {
    let fd = entry.fd?;
    if fd == "txt" || fd == "mem" {
        return None;
    }

    let file_type = entry.file_type.as_deref()?;
    if is_socket_type(file_type) {
        return None;
    }

    let kind = resource_kind(file_type);
    let (name, deleted) = entry.name.map(clean_deleted_suffix).unwrap_or((None, None));
    Some(ProcessResourceInUseInfo {
        resource_id: fd.clone(),
        kind,
        name,
        access: resource_access(&fd),
        deleted,
    })
}

fn resource_kind(file_type: &str) -> ProcessResourceInUseKind {
    match file_type {
        "REG" => ProcessResourceInUseKind::File,
        "DIR" => ProcessResourceInUseKind::Directory,
        "CHR" | "BLK" => ProcessResourceInUseKind::Device,
        "FIFO" => ProcessResourceInUseKind::NamedPipe,
        "PIPE" => ProcessResourceInUseKind::AnonymousPipe,
        _ => ProcessResourceInUseKind::Other,
    }
}

fn is_socket_type(file_type: &str) -> bool {
    matches!(file_type, "IPv4" | "IPv6" | "unix")
}

fn clean_deleted_suffix(name: String) -> (Option<String>, Option<bool>) {
    if let Some(path) = name.strip_suffix(" (deleted)") {
        (Some(path.to_string()), Some(true))
    } else {
        (Some(name), None)
    }
}

fn resource_access(fd: &str) -> Option<ProcessResourceInUseAccess> {
    if fd == "txt" {
        return Some(ProcessResourceInUseAccess {
            read: Some(true),
            write: Some(false),
            execute: Some(true),
        });
    }

    let read = fd.ends_with('r') || fd.ends_with('u');
    let write = fd.ends_with('w') || fd.ends_with('u');
    (read || write).then_some(ProcessResourceInUseAccess {
        read: Some(read),
        write: Some(write),
        execute: Some(false),
    })
}

fn resource_kind_sort_key(kind: ProcessResourceInUseKind) -> u8 {
    match kind {
        ProcessResourceInUseKind::File => 0,
        ProcessResourceInUseKind::Directory => 1,
        ProcessResourceInUseKind::Device => 2,
        ProcessResourceInUseKind::NamedPipe => 3,
        ProcessResourceInUseKind::AnonymousPipe => 4,
        ProcessResourceInUseKind::Other => 5,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::process_lsof::parse_lsof_entries;

    #[test]
    fn maps_lsof_entries_to_resources() {
        let entries = parse_lsof_entries(
            "fcwd\ntDIR\nn/tmp\nf0r\ntREG\nn/tmp/input\nf1w\ntPIPE\nn->0xabc\nf4\ntIPv4\nn127.0.0.1:1\nftxt\ntREG\nn/bin/zsh\n",
        )
        .unwrap();
        let rows = entries
            .into_iter()
            .filter_map(resource_row)
            .collect::<Vec<_>>();

        assert_eq!(rows.len(), 3);
        assert!(rows
            .iter()
            .any(|row| row.kind == ProcessResourceInUseKind::Directory));
        assert!(rows
            .iter()
            .any(|row| row.kind == ProcessResourceInUseKind::File));
        assert!(rows
            .iter()
            .any(|row| row.kind == ProcessResourceInUseKind::AnonymousPipe));
    }

    #[test]
    fn finds_current_process_resources() {
        let rows = snapshot_process_resources_in_use(std::process::id() as u64).unwrap();

        assert!(!rows.is_empty());
        assert!(rows
            .iter()
            .any(|row| row.kind == ProcessResourceInUseKind::Directory));
    }
}
