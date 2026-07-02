#[cfg(windows)]
mod platform {
    use std::ffi::c_void;
    use std::mem::size_of;

    use wgo_daemon_core::rpc::{WindowBounds, WindowDetail, WindowInfo, WindowState};
    use wgo_daemon_core::traits::ServiceError;
    use windows::core::BOOL;
    use windows::Win32::Foundation::{HWND, LPARAM, RECT};
    use windows::Win32::Graphics::Dwm::{DwmGetWindowAttribute, DWMWA_CLOAKED};
    use windows::Win32::UI::WindowsAndMessaging::{
        EnumWindows, GetForegroundWindow, GetWindowRect, GetWindowTextLengthW, GetWindowTextW,
        GetWindowThreadProcessId, IsIconic, IsWindowVisible, IsZoomed,
    };

    pub fn snapshot() -> Result<Vec<WindowDetail>, ServiceError> {
        let mut windows: Vec<WindowDetail> = Vec::new();
        unsafe {
            EnumWindows(
                Some(enum_window),
                LPARAM(&mut windows as *mut Vec<WindowDetail> as isize),
            )
            .map_err(|err| ServiceError::OperationFailed(err.to_string()))?;
        }
        windows.sort_by(|a, b| {
            process_sort_key(a.info.process_id)
                .cmp(&process_sort_key(b.info.process_id))
                .then_with(|| a.info.title.cmp(&b.info.title))
                .then_with(|| a.info.window_id.cmp(&b.info.window_id))
        });
        Ok(windows)
    }

    fn process_sort_key(pid: Option<u64>) -> (bool, u64) {
        match pid {
            Some(pid) => (false, pid),
            None => (true, 0),
        }
    }

    unsafe extern "system" fn enum_window(hwnd: HWND, lparam: LPARAM) -> BOOL {
        let windows = &mut *(lparam.0 as *mut Vec<WindowDetail>);
        if let Some(detail) = window_detail_from_hwnd(hwnd) {
            windows.push(detail);
        }
        BOOL(1)
    }

    fn window_detail_from_hwnd(hwnd: HWND) -> Option<WindowDetail> {
        if !is_visible(hwnd) || is_cloaked(hwnd) {
            return None;
        }
        let title = window_title(hwnd)?;
        if title.trim().is_empty() {
            return None;
        }

        Some(WindowDetail {
            info: WindowInfo {
                window_id: window_id(hwnd),
                title: Some(title),
                process_id: window_process_id(hwnd),
                focused: Some(is_focused(hwnd)),
            },
            state: WindowState {
                visible: Some(true),
                minimized: Some(unsafe { IsIconic(hwnd).as_bool() }),
                maximized: Some(unsafe { IsZoomed(hwnd).as_bool() }),
            },
            bounds: window_bounds(hwnd),
        })
    }

    fn window_id(hwnd: HWND) -> String {
        (hwnd.0 as usize).to_string()
    }

    fn is_visible(hwnd: HWND) -> bool {
        unsafe { IsWindowVisible(hwnd).as_bool() }
    }

    fn is_focused(hwnd: HWND) -> bool {
        unsafe { GetForegroundWindow() == hwnd }
    }

    fn window_process_id(hwnd: HWND) -> Option<u64> {
        let mut process_id = 0u32;
        unsafe {
            GetWindowThreadProcessId(hwnd, Some(&mut process_id));
        }
        (process_id != 0).then_some(u64::from(process_id))
    }

    fn window_title(hwnd: HWND) -> Option<String> {
        let len = unsafe { GetWindowTextLengthW(hwnd) };
        if len <= 0 {
            return None;
        }
        let mut buffer = vec![0u16; len as usize + 1];
        let copied = unsafe { GetWindowTextW(hwnd, &mut buffer) };
        if copied <= 0 {
            return None;
        }
        buffer.truncate(copied as usize);
        Some(String::from_utf16_lossy(&buffer))
    }

    fn window_bounds(hwnd: HWND) -> Option<WindowBounds> {
        let mut rect = RECT::default();
        unsafe {
            GetWindowRect(hwnd, &mut rect).ok()?;
        }
        let width = rect.right.saturating_sub(rect.left);
        let height = rect.bottom.saturating_sub(rect.top);
        Some(WindowBounds {
            x: i64::from(rect.left),
            y: i64::from(rect.top),
            width: u64::try_from(width).unwrap_or(0),
            height: u64::try_from(height).unwrap_or(0),
        })
    }

    fn is_cloaked(hwnd: HWND) -> bool {
        let mut cloaked = 0u32;
        let result = unsafe {
            DwmGetWindowAttribute(
                hwnd,
                DWMWA_CLOAKED,
                &mut cloaked as *mut u32 as *mut c_void,
                size_of::<u32>() as u32,
            )
        };
        result.is_ok() && cloaked != 0
    }
}

#[cfg(windows)]
pub use platform::snapshot;

#[cfg(not(windows))]
pub fn snapshot(
) -> Result<Vec<wgo_daemon_core::rpc::WindowDetail>, wgo_daemon_core::traits::ServiceError> {
    Err(wgo_daemon_core::traits::ServiceError::Unsupported)
}
