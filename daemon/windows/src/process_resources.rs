#[cfg(windows)]
mod platform {
    use std::ffi::c_void;
    use std::mem::size_of;
    use std::sync::mpsc;
    use std::time::Duration;

    use rieul_daemon_core::rpc::{
        ProcessResourceInUseAccess, ProcessResourceInUseInfo, ProcessResourceInUseKind,
    };
    use rieul_daemon_core::traits::{BoxFutureResult, ProcessResourcesInUseService, ServiceError};
    use windows::core::{Error as WindowsError, PCWSTR};
    use windows::Wdk::Foundation::{
        NtQueryObject, ObjectTypeInformation, OBJECT_INFORMATION_CLASS,
    };
    use windows::Wdk::System::SystemInformation::{
        NtQuerySystemInformation, SYSTEM_INFORMATION_CLASS,
    };
    use windows::Win32::Foundation::{
        CloseHandle, DuplicateHandle, DUPLICATE_SAME_ACCESS, HANDLE, STATUS_INFO_LENGTH_MISMATCH,
        UNICODE_STRING,
    };
    use windows::Win32::Storage::FileSystem::{
        GetFileAttributesW, GetFileType, GetFinalPathNameByHandleW, FILE_ATTRIBUTE_DIRECTORY,
        FILE_TYPE_CHAR, FILE_TYPE_DISK, FILE_TYPE_PIPE, FILE_TYPE_UNKNOWN, VOLUME_NAME_DOS,
    };
    use windows::Win32::System::Threading::{GetCurrentProcess, OpenProcess, PROCESS_DUP_HANDLE};

    const SYSTEM_EXTENDED_HANDLE_INFORMATION: SYSTEM_INFORMATION_CLASS =
        SYSTEM_INFORMATION_CLASS(64);
    const OBJECT_NAME_INFORMATION: OBJECT_INFORMATION_CLASS = OBJECT_INFORMATION_CLASS(1);
    const OBJECT_NAME_QUERY_TIMEOUT: Duration = Duration::from_millis(75);

    #[derive(Debug, Default, Clone, Copy)]
    pub struct WindowsProcessResourcesInUseService;

    impl ProcessResourcesInUseService for WindowsProcessResourcesInUseService {
        fn resources_in_use(&self, pid: u64) -> BoxFutureResult<'_, Vec<ProcessResourceInUseInfo>> {
            Box::pin(async move {
                tokio::task::spawn_blocking(move || snapshot_process_resources_in_use(pid))
                    .await
                    .map_err(|err| ServiceError::OperationFailed(err.to_string()))?
            })
        }
    }

    #[repr(C)]
    #[derive(Clone, Copy)]
    struct SystemHandleTableEntryInfoEx {
        object: *mut c_void,
        unique_process_id: usize,
        handle_value: usize,
        granted_access: u32,
        creator_back_trace_index: u16,
        object_type_index: u16,
        handle_attributes: u32,
        reserved: u32,
    }

    fn snapshot_process_resources_in_use(
        pid: u64,
    ) -> Result<Vec<ProcessResourceInUseInfo>, ServiceError> {
        let pid = u32::try_from(pid).map_err(|_| ServiceError::NotFound)?;
        let source_process = open_process_for_handles(pid)?;
        let handles = match query_system_handles() {
            Ok(handles) => handles,
            Err(err) => {
                unsafe {
                    let _ = CloseHandle(source_process);
                }
                return Err(err);
            }
        };

        let mut rows = Vec::new();
        for handle in handles
            .into_iter()
            .filter(|handle| handle.unique_process_id == pid as usize)
        {
            let Some(row) = process_handle_row(source_process, pid, handle) else {
                continue;
            };
            rows.push(row);
        }
        unsafe {
            let _ = CloseHandle(source_process);
        }
        rows.sort_by(|a, b| {
            resource_kind_sort_key(a.kind)
                .cmp(&resource_kind_sort_key(b.kind))
                .then_with(|| a.name.cmp(&b.name))
                .then_with(|| a.resource_id.cmp(&b.resource_id))
        });
        Ok(rows)
    }

    fn open_process_for_handles(pid: u32) -> Result<HANDLE, ServiceError> {
        let handle = unsafe { OpenProcess(PROCESS_DUP_HANDLE, false, pid) };
        handle.map_err(map_open_process_error)
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

    fn query_system_handles() -> Result<Vec<SystemHandleTableEntryInfoEx>, ServiceError> {
        let mut len = 1024 * 1024usize;
        loop {
            let mut buffer = vec![0u8; len];
            let mut returned = 0u32;
            let status = unsafe {
                NtQuerySystemInformation(
                    SYSTEM_EXTENDED_HANDLE_INFORMATION,
                    buffer.as_mut_ptr() as *mut c_void,
                    len as u32,
                    &mut returned,
                )
            };
            if status == STATUS_INFO_LENGTH_MISMATCH {
                len = (returned as usize).max(len * 2);
                continue;
            }
            if status.is_err() {
                return Err(ServiceError::OperationFailed(format!(
                    "NtQuerySystemInformation failed: 0x{:08x}",
                    status.0
                )));
            }

            let number_of_handles = unsafe { *(buffer.as_ptr() as *const usize) };
            let entries_offset = size_of::<usize>() * 2;
            let required = entries_offset
                + number_of_handles.saturating_mul(size_of::<SystemHandleTableEntryInfoEx>());
            if required > buffer.len() {
                len = required;
                continue;
            }
            let entries = unsafe {
                std::slice::from_raw_parts(
                    buffer.as_ptr().add(entries_offset) as *const SystemHandleTableEntryInfoEx,
                    number_of_handles,
                )
            };
            return Ok(entries.to_vec());
        }
    }

    fn process_handle_row(
        source_process: HANDLE,
        pid: u32,
        entry: SystemHandleTableEntryInfoEx,
    ) -> Option<ProcessResourceInUseInfo> {
        let duplicated = duplicate_process_handle(source_process, entry.handle_value)?;
        let type_name = query_object_type_name(duplicated).unwrap_or_default();
        let file_type = unsafe { GetFileType(duplicated) };
        let access = process_resource_access(entry.granted_access);
        let resource_id = format!("{pid}:{:x}", entry.handle_value);

        let row = match file_type {
            FILE_TYPE_DISK => disk_handle_row(duplicated, resource_id, access),
            FILE_TYPE_PIPE => pipe_handle_row(duplicated, resource_id, access),
            FILE_TYPE_CHAR => Some(ProcessResourceInUseInfo {
                resource_id,
                kind: ProcessResourceInUseKind::Device,
                name: query_object_name_with_timeout(duplicated),
                access,
                deleted: None,
            }),
            FILE_TYPE_UNKNOWN => unknown_handle_row(duplicated, resource_id, access, &type_name),
            _ if type_name.eq_ignore_ascii_case("File") => {
                unknown_handle_row(duplicated, resource_id, access, &type_name)
            }
            _ => None,
        };
        unsafe {
            let _ = CloseHandle(duplicated);
        }
        row
    }

    fn duplicate_process_handle(source_process: HANDLE, handle_value: usize) -> Option<HANDLE> {
        let mut duplicated = HANDLE::default();
        let result = unsafe {
            DuplicateHandle(
                source_process,
                HANDLE(handle_value as *mut c_void),
                GetCurrentProcess(),
                &mut duplicated,
                0,
                false,
                DUPLICATE_SAME_ACCESS,
            )
        };
        result.is_ok().then_some(duplicated)
    }

    fn disk_handle_row(
        handle: HANDLE,
        resource_id: String,
        access: Option<ProcessResourceInUseAccess>,
    ) -> Option<ProcessResourceInUseInfo> {
        let path =
            final_path_by_handle(handle).or_else(|| query_object_name_with_timeout(handle))?;
        let deleted = path_is_deleted(&path).then_some(true);
        Some(ProcessResourceInUseInfo {
            resource_id,
            kind: if is_directory_path(&path) {
                ProcessResourceInUseKind::Directory
            } else {
                ProcessResourceInUseKind::File
            },
            name: Some(path),
            access,
            deleted,
        })
    }

    fn pipe_handle_row(
        handle: HANDLE,
        resource_id: String,
        access: Option<ProcessResourceInUseAccess>,
    ) -> Option<ProcessResourceInUseInfo> {
        let name = query_object_name_with_timeout(handle);
        if name.as_deref().is_some_and(is_socket_object_name) {
            return None;
        }
        let kind = if name.as_deref().is_some_and(is_named_pipe_name) {
            ProcessResourceInUseKind::NamedPipe
        } else {
            ProcessResourceInUseKind::AnonymousPipe
        };
        Some(ProcessResourceInUseInfo {
            resource_id,
            kind,
            name,
            access,
            deleted: None,
        })
    }

    fn unknown_handle_row(
        handle: HANDLE,
        resource_id: String,
        access: Option<ProcessResourceInUseAccess>,
        type_name: &str,
    ) -> Option<ProcessResourceInUseInfo> {
        if !type_name.is_empty() && !type_name.eq_ignore_ascii_case("File") {
            return None;
        }
        let name = query_object_name_with_timeout(handle);
        if name.as_deref().is_some_and(is_socket_object_name) {
            return None;
        }
        let kind = if name.as_deref().is_some_and(is_named_pipe_name) {
            ProcessResourceInUseKind::NamedPipe
        } else {
            ProcessResourceInUseKind::Other
        };
        Some(ProcessResourceInUseInfo {
            resource_id,
            kind,
            name,
            access,
            deleted: None,
        })
    }

    fn final_path_by_handle(handle: HANDLE) -> Option<String> {
        let mut buffer = vec![0u16; 32768];
        let len = unsafe { GetFinalPathNameByHandleW(handle, &mut buffer, VOLUME_NAME_DOS) };
        if len == 0 {
            return None;
        }
        let len = usize::try_from(len).ok()?;
        if len > buffer.len() {
            return None;
        }
        buffer.truncate(len);
        Some(normalize_final_path(&String::from_utf16_lossy(&buffer)))
    }

    fn normalize_final_path(path: &str) -> String {
        path.strip_prefix(r"\\?\")
            .or_else(|| path.strip_prefix(r"\??\"))
            .unwrap_or(path)
            .to_string()
    }

    fn query_object_type_name(handle: HANDLE) -> Option<String> {
        query_object_unicode_string(handle, ObjectTypeInformation)
    }

    fn query_object_name(handle: HANDLE) -> Option<String> {
        query_object_unicode_string(handle, OBJECT_NAME_INFORMATION)
    }

    fn query_object_name_with_timeout(handle: HANDLE) -> Option<String> {
        let duplicated = duplicate_current_process_handle(handle)?;
        let raw_handle = duplicated.0 as isize;
        let (tx, rx) = mpsc::channel();
        std::thread::spawn(move || {
            let handle = HANDLE(raw_handle as *mut c_void);
            let result = query_object_name(handle);
            unsafe {
                let _ = CloseHandle(handle);
            }
            let _ = tx.send(result);
        });
        rx.recv_timeout(OBJECT_NAME_QUERY_TIMEOUT).ok().flatten()
    }

    fn duplicate_current_process_handle(handle: HANDLE) -> Option<HANDLE> {
        let mut duplicated = HANDLE::default();
        let result = unsafe {
            DuplicateHandle(
                GetCurrentProcess(),
                handle,
                GetCurrentProcess(),
                &mut duplicated,
                0,
                false,
                DUPLICATE_SAME_ACCESS,
            )
        };
        result.is_ok().then_some(duplicated)
    }

    fn query_object_unicode_string(
        handle: HANDLE,
        class: OBJECT_INFORMATION_CLASS,
    ) -> Option<String> {
        let mut len = 0u32;
        let status = unsafe { NtQueryObject(Some(handle), class, None, 0, Some(&mut len)) };
        if status != STATUS_INFO_LENGTH_MISMATCH && len == 0 {
            return None;
        }
        let mut buffer = vec![0u8; len.max(1024) as usize];
        let status = unsafe {
            NtQueryObject(
                Some(handle),
                class,
                Some(buffer.as_mut_ptr() as *mut c_void),
                buffer.len() as u32,
                Some(&mut len),
            )
        };
        if status.is_err() {
            return None;
        }
        let unicode = unsafe { &*(buffer.as_ptr() as *const UNICODE_STRING) };
        unicode_string_to_string(unicode)
    }

    fn unicode_string_to_string(value: &UNICODE_STRING) -> Option<String> {
        if value.Length == 0 || value.Buffer.is_null() {
            return None;
        }
        let len = usize::from(value.Length) / 2;
        let slice = unsafe { std::slice::from_raw_parts(value.Buffer.0, len) };
        Some(String::from_utf16_lossy(slice))
    }

    fn is_socket_object_name(name: &str) -> bool {
        let lower = name.to_ascii_lowercase();
        lower.starts_with(r"\device\afd")
            || lower.starts_with(r"\device\tcp")
            || lower.starts_with(r"\device\udp")
            || lower.starts_with(r"\device\rawip")
    }

    fn is_named_pipe_name(name: &str) -> bool {
        name.to_ascii_lowercase().contains(r"\namedpipe\")
    }

    fn is_directory_path(path: &str) -> bool {
        let wide = path_to_wide(path);
        let attributes = unsafe { GetFileAttributesW(PCWSTR(wide.as_ptr())) };
        attributes != u32::MAX && (attributes & FILE_ATTRIBUTE_DIRECTORY.0) != 0
    }

    fn path_is_deleted(path: &str) -> bool {
        let wide = path_to_wide(path);
        let attributes = unsafe { GetFileAttributesW(PCWSTR(wide.as_ptr())) };
        attributes == u32::MAX
    }

    fn path_to_wide(path: &str) -> Vec<u16> {
        path.encode_utf16().chain(std::iter::once(0)).collect()
    }

    fn process_resource_access(granted_access: u32) -> Option<ProcessResourceInUseAccess> {
        const GENERIC_READ: u32 = 0x8000_0000;
        const GENERIC_WRITE: u32 = 0x4000_0000;
        const GENERIC_EXECUTE: u32 = 0x2000_0000;
        const FILE_READ_DATA: u32 = 0x0000_0001;
        const FILE_WRITE_DATA: u32 = 0x0000_0002;
        const FILE_APPEND_DATA: u32 = 0x0000_0004;
        const FILE_EXECUTE: u32 = 0x0000_0020;

        let read = (granted_access & (GENERIC_READ | FILE_READ_DATA)) != 0;
        let write = (granted_access & (GENERIC_WRITE | FILE_WRITE_DATA | FILE_APPEND_DATA)) != 0;
        let execute = (granted_access & (GENERIC_EXECUTE | FILE_EXECUTE)) != 0;
        (read || write || execute).then_some(ProcessResourceInUseAccess {
            read: read.then_some(true),
            write: write.then_some(true),
            execute: execute.then_some(true),
        })
    }

    fn resource_kind_sort_key(kind: ProcessResourceInUseKind) -> u8 {
        match kind {
            ProcessResourceInUseKind::File => 0,
            ProcessResourceInUseKind::Directory => 1,
            ProcessResourceInUseKind::NamedPipe => 2,
            ProcessResourceInUseKind::AnonymousPipe => 3,
            ProcessResourceInUseKind::Device => 4,
            ProcessResourceInUseKind::Other => 5,
        }
    }
}

#[cfg(windows)]
pub use platform::WindowsProcessResourcesInUseService;
