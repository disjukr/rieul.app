use std::collections::BTreeSet;
use std::path::Path;

use wgo_daemon_core::rpc::{ProcessModuleInfo, ProcessModuleKind};
use wgo_daemon_core::traits::{BoxFutureResult, ProcessModulesService, ServiceError};

use crate::process_lsof::{ensure_process_exists, run_lsof, LsofEntry};

#[derive(Debug, Default, Clone, Copy)]
pub struct MacProcessModulesService;

impl ProcessModulesService for MacProcessModulesService {
    fn modules(&self, pid: u64) -> BoxFutureResult<'_, Vec<ProcessModuleInfo>> {
        Box::pin(async move {
            tokio::task::spawn_blocking(move || snapshot_process_modules(pid))
                .await
                .map_err(|err| ServiceError::OperationFailed(err.to_string()))?
        })
    }
}

fn snapshot_process_modules(pid: u64) -> Result<Vec<ProcessModuleInfo>, ServiceError> {
    let pid = ensure_process_exists(pid)?;
    let args = vec![
        "-nP".to_string(),
        "-p".to_string(),
        pid.to_string(),
        "-F".to_string(),
        "pcftn".to_string(),
    ];
    let mut seen_paths = BTreeSet::new();
    let mut first_module = true;
    let mut rows = Vec::new();
    for entry in run_lsof(&args)? {
        let Some(row) = module_row(entry, first_module, &mut seen_paths) else {
            continue;
        };
        first_module = false;
        rows.push(row);
    }
    rows.sort_by(|a, b| {
        module_kind_sort_key(a.kind)
            .cmp(&module_kind_sort_key(b.kind))
            .then_with(|| a.name.cmp(&b.name))
            .then_with(|| a.path.cmp(&b.path))
            .then_with(|| a.module_id.cmp(&b.module_id))
    });
    Ok(rows)
}

fn module_row(
    entry: LsofEntry,
    first_module: bool,
    seen_paths: &mut BTreeSet<String>,
) -> Option<ProcessModuleInfo> {
    if entry.fd.as_deref() != Some("txt") || entry.file_type.as_deref() != Some("REG") {
        return None;
    }
    let path = entry.name?;
    if !seen_paths.insert(path.clone()) {
        return None;
    }

    let name = path_file_name(&path).unwrap_or_else(|| path.clone());
    let size_bytes = std::fs::metadata(&path).ok().map(|metadata| metadata.len());
    Some(ProcessModuleInfo {
        module_id: path.clone(),
        name,
        path: Some(path.clone()),
        kind: module_kind(&path, first_module),
        base_address: None,
        size_bytes,
        version: None,
    })
}

fn module_kind(path: &str, first_module: bool) -> ProcessModuleKind {
    if first_module {
        ProcessModuleKind::Executable
    } else if is_dynamic_library_path(path) {
        ProcessModuleKind::DynamicLibrary
    } else {
        ProcessModuleKind::Unknown
    }
}

fn is_dynamic_library_path(path: &str) -> bool {
    let lower = path.to_ascii_lowercase();
    lower.ends_with(".dylib")
        || lower.ends_with(".so")
        || lower.contains(".framework/")
        || lower.starts_with("/usr/lib/")
        || lower.starts_with("/system/library/")
}

fn path_file_name(path: &str) -> Option<String> {
    Path::new(path)
        .file_name()
        .and_then(|name| name.to_str())
        .filter(|name| !name.is_empty())
        .map(str::to_string)
}

fn module_kind_sort_key(kind: ProcessModuleKind) -> u8 {
    match kind {
        ProcessModuleKind::Executable => 0,
        ProcessModuleKind::DynamicLibrary => 1,
        ProcessModuleKind::Unknown => 2,
    }
}

#[cfg(test)]
mod tests {
    use std::collections::BTreeSet;

    use super::*;
    use crate::process_lsof::parse_lsof_entries;

    #[test]
    fn maps_txt_entries_to_modules() {
        let entries =
            parse_lsof_entries("ftxt\ntREG\nn/bin/zsh\nftxt\ntREG\nn/usr/lib/dyld\n").unwrap();
        let mut seen_paths = BTreeSet::new();
        let rows = entries
            .into_iter()
            .enumerate()
            .filter_map(|(index, entry)| module_row(entry, index == 0, &mut seen_paths))
            .collect::<Vec<_>>();

        assert_eq!(rows.len(), 2);
        assert_eq!(rows[0].kind, ProcessModuleKind::Executable);
        assert_eq!(rows[1].kind, ProcessModuleKind::DynamicLibrary);
    }

    #[test]
    fn finds_current_process_modules() {
        let rows = snapshot_process_modules(std::process::id() as u64).unwrap();

        assert!(!rows.is_empty());
        assert!(rows
            .iter()
            .any(|row| row.kind == ProcessModuleKind::Executable));
    }
}
