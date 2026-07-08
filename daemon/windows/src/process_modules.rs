#[cfg(windows)]
mod platform {
    use std::mem::size_of;

    use rieul_daemon_core::rpc::{ProcessModuleInfo, ProcessModuleKind};
    use rieul_daemon_core::traits::{BoxFutureResult, ProcessModulesService, ServiceError};
    use windows::core::Error as WindowsError;
    use windows::Win32::Foundation::{CloseHandle, HANDLE};
    use windows::Win32::System::Diagnostics::ToolHelp::{
        CreateToolhelp32Snapshot, Module32FirstW, Module32NextW, MODULEENTRY32W, TH32CS_SNAPMODULE,
        TH32CS_SNAPMODULE32,
    };

    #[derive(Debug, Default, Clone, Copy)]
    pub struct WindowsProcessModulesService;

    impl ProcessModulesService for WindowsProcessModulesService {
        fn modules(&self, pid: u64) -> BoxFutureResult<'_, Vec<ProcessModuleInfo>> {
            Box::pin(async move {
                tokio::task::spawn_blocking(move || snapshot_process_modules(pid))
                    .await
                    .map_err(|err| ServiceError::OperationFailed(err.to_string()))?
            })
        }
    }

    fn snapshot_process_modules(pid: u64) -> Result<Vec<ProcessModuleInfo>, ServiceError> {
        let pid = u32::try_from(pid).map_err(|_| ServiceError::NotFound)?;
        let snapshot =
            unsafe { CreateToolhelp32Snapshot(TH32CS_SNAPMODULE | TH32CS_SNAPMODULE32, pid) }
                .map_err(map_snapshot_error)?;

        let result = read_modules(snapshot);
        unsafe {
            let _ = CloseHandle(snapshot);
        }
        result
    }

    fn read_modules(snapshot: HANDLE) -> Result<Vec<ProcessModuleInfo>, ServiceError> {
        let mut entry = MODULEENTRY32W {
            dwSize: size_of::<MODULEENTRY32W>() as u32,
            ..Default::default()
        };
        unsafe { Module32FirstW(snapshot, &mut entry) }.map_err(map_snapshot_error)?;

        let mut rows = Vec::new();
        loop {
            rows.push(module_entry_row(&entry));
            if unsafe { Module32NextW(snapshot, &mut entry) }.is_err() {
                break;
            }
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

    fn module_entry_row(entry: &MODULEENTRY32W) -> ProcessModuleInfo {
        let path = wide_array_string(&entry.szExePath);
        let name = wide_array_string(&entry.szModule)
            .or_else(|| path.as_deref().and_then(path_file_name))
            .unwrap_or_else(|| format_module_address(entry.modBaseAddr));
        let base_address = format_module_address(entry.modBaseAddr);
        ProcessModuleInfo {
            module_id: base_address.clone(),
            name,
            path: path.clone(),
            kind: module_kind(path.as_deref()),
            base_address: Some(base_address),
            size_bytes: Some(u64::from(entry.modBaseSize)),
            version: None,
        }
    }

    fn module_kind(path: Option<&str>) -> ProcessModuleKind {
        if path
            .and_then(|path| path.rsplit(['\\', '/']).next())
            .is_some_and(|name| name.to_ascii_lowercase().ends_with(".exe"))
        {
            ProcessModuleKind::Executable
        } else {
            ProcessModuleKind::DynamicLibrary
        }
    }

    fn format_module_address(address: *mut u8) -> String {
        format!("{:x}", address as usize)
    }

    fn wide_array_string(value: &[u16]) -> Option<String> {
        let len = value.iter().position(|ch| *ch == 0).unwrap_or(value.len());
        if len == 0 {
            return None;
        }
        Some(String::from_utf16_lossy(&value[..len]))
    }

    fn path_file_name(path: &str) -> Option<String> {
        path.rsplit(['\\', '/'])
            .find(|part| !part.is_empty())
            .map(str::to_string)
    }

    fn module_kind_sort_key(kind: ProcessModuleKind) -> u8 {
        match kind {
            ProcessModuleKind::Executable => 0,
            ProcessModuleKind::DynamicLibrary => 1,
            ProcessModuleKind::Unknown => 2,
        }
    }

    fn map_snapshot_error(err: WindowsError) -> ServiceError {
        let message = err.to_string();
        let lower = message.to_ascii_lowercase();
        if lower.contains("access") || lower.contains("denied") || lower.contains("permission") {
            ServiceError::PermissionDenied
        } else if lower.contains("not found") || lower.contains("cannot find") {
            ServiceError::NotFound
        } else {
            ServiceError::OperationFailed(message)
        }
    }

    #[cfg(test)]
    mod tests {
        use super::*;

        #[test]
        fn formats_base_address_without_prefix() {
            let address = 0x7ffb12340000usize as *mut u8;
            assert_eq!(format_module_address(address), "7ffb12340000");
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
}

#[cfg(windows)]
pub use platform::WindowsProcessModulesService;
