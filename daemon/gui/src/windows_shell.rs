//! Windows callbacks only queue events. UI work occurs after returning to GPUI.
use anyhow::{Result, ensure};
use rieul_windows_close_guard::{
    rieul_install_close_guard, rieul_take_close_requests, rieul_uninstall_close_guard,
};
use std::{
    ptr::{null, null_mut},
    sync::atomic::{AtomicU32, Ordering},
};
use windows_sys::Win32::{
    Foundation::*,
    System::LibraryLoader::GetModuleHandleW,
    UI::{Shell::*, WindowsAndMessaging::*},
};
static EVENTS: AtomicU32 = AtomicU32::new(0);
static TASKBAR_CREATED: AtomicU32 = AtomicU32::new(0);
fn wide(value: &str) -> Vec<u16> {
    value.encode_utf16().chain(Some(0)).collect()
}
fn text<const N: usize>(target: &mut [u16; N], value: &str) {
    for (slot, value) in target.iter_mut().take(N - 1).zip(value.encode_utf16()) {
        *slot = value;
    }
}
unsafe extern "system" fn tray_proc(hwnd: HWND, message: u32, w: usize, l: isize) -> isize {
    let event = if message == WM_COMMAND {
        match w & 0xffff {
            1 => 4,
            2 => 8,
            _ => 0,
        }
    } else if message == TASKBAR_CREATED.load(Ordering::Relaxed) {
        16
    } else if message == WM_APP + 1 {
        match l as u32 & 0xffff {
            WM_LBUTTONUP | WM_LBUTTONDBLCLK | 0x400 | 0x401 | 0x405 => 2,
            WM_RBUTTONUP | WM_CONTEXTMENU => 32,
            _ => 0,
        }
    } else {
        return unsafe { DefWindowProcW(hwnd, message, w, l) };
    };
    EVENTS.fetch_or(event, Ordering::Release);
    0
}
struct Search {
    pid: u32,
    window: HWND,
}
unsafe extern "system" fn find_window(hwnd: HWND, data: LPARAM) -> windows_sys::core::BOOL {
    let search = unsafe { &mut *(data as *mut Search) };
    let mut pid = 0;
    let mut rect: RECT = unsafe { std::mem::zeroed() };
    unsafe {
        GetWindowThreadProcessId(hwnd, &mut pid);
    }
    if pid == search.pid
        && unsafe { GetWindowRect(hwnd, &mut rect) } != 0
        && rect.right - rect.left >= 300
        && rect.bottom - rect.top >= 200
    {
        search.window = hwnd;
        0
    } else {
        1
    }
}
pub struct Shell {
    window: HWND,
    tray: HWND,
    icon: HICON,
    class: Vec<u16>,
    instance: HINSTANCE,
}
impl Shell {
    pub fn updates(&self, _model: &rieul_gui::updates::Updates) {}
    pub fn confirm_update(&self, _title: &str, _force: bool) -> bool {
        false
    }

    pub fn new(icon: &str) -> Result<Self> {
        unsafe {
            let mut search = Search {
                pid: std::process::id(),
                window: null_mut(),
            };
            EnumWindows(Some(find_window), &mut search as *mut _ as isize);
            ensure!(!search.window.is_null(), "GPUI native window not found");
            ensure!(
                rieul_install_close_guard(search.window) > 0,
                "close guard installation failed"
            );
            let mut shell = Self {
                window: search.window,
                tray: null_mut(),
                icon: null_mut(),
                class: wide(&format!("RieulGPUITray-{}", std::process::id())),
                instance: GetModuleHandleW(null()),
            };
            let mut class: WNDCLASSW = std::mem::zeroed();
            class.lpfnWndProc = Some(tray_proc);
            class.hInstance = shell.instance;
            class.lpszClassName = shell.class.as_ptr();
            TASKBAR_CREATED.store(
                RegisterWindowMessageW(wide("TaskbarCreated").as_ptr()),
                Ordering::Relaxed,
            );
            ensure!(
                RegisterClassW(&class) != 0,
                "RegisterClassW failed: {}",
                std::io::Error::last_os_error()
            );
            shell.tray = CreateWindowExW(
                0,
                shell.class.as_ptr(),
                wide("Rieul tray").as_ptr(),
                0,
                0,
                0,
                0,
                0,
                null_mut(),
                null_mut(),
                shell.instance,
                null(),
            );
            ensure!(!shell.tray.is_null(), "CreateWindowExW failed");
            shell.icon = LoadImageW(
                null_mut(),
                wide(icon).as_ptr(),
                IMAGE_ICON,
                32,
                32,
                LR_LOADFROMFILE,
            ) as HICON;
            ensure!(!shell.icon.is_null(), "LoadImageW failed");
            SendMessageW(
                shell.window,
                WM_SETICON,
                ICON_BIG as usize,
                shell.icon as isize,
            );
            SendMessageW(
                shell.window,
                WM_SETICON,
                ICON_SMALL as usize,
                shell.icon as isize,
            );
            ensure!(shell.add_icon(), "Shell_NotifyIconW failed");
            EVENTS.store(0, Ordering::Release);
            ShowWindow(shell.window, SW_HIDE);
            Ok(shell)
        }
    }
    fn data(&self) -> NOTIFYICONDATAW {
        let mut data: NOTIFYICONDATAW = unsafe { std::mem::zeroed() };
        data.cbSize = std::mem::size_of_val(&data) as u32;
        data.hWnd = self.tray;
        data.uID = 1;
        data
    }
    fn add_icon(&self) -> bool {
        unsafe {
            let mut data = self.data();
            data.uFlags = NIF_MESSAGE | NIF_ICON | NIF_TIP;
            data.uCallbackMessage = WM_APP + 1;
            data.hIcon = self.icon;
            text(&mut data.szTip, "Rieul");
            if Shell_NotifyIconW(NIM_ADD, &data) == 0 {
                return false;
            }
            data.Anonymous.uVersion = NOTIFYICON_VERSION_4;
            Shell_NotifyIconW(NIM_SETVERSION, &data);
            true
        }
    }
    pub fn visible(&self, visible: bool) {
        unsafe {
            ShowWindow(self.window, if visible { SW_SHOW } else { SW_HIDE });
            if visible {
                SetForegroundWindow(self.window);
            }
        }
    }
    pub fn is_visible(&self) -> bool {
        unsafe { IsWindowVisible(self.window) != 0 }
    }
    pub fn close(&self) {
        unsafe {
            PostMessageW(self.window, WM_CLOSE, 0, 0);
        }
    }
    pub fn events(&self) -> u32 {
        let mut events = EVENTS.swap(0, Ordering::AcqRel);
        if rieul_take_close_requests() != 0 {
            events |= 1;
        }
        if events & 16 != 0 {
            self.add_icon();
        }
        if events & 32 != 0 {
            unsafe {
                let menu = CreatePopupMenu();
                if !menu.is_null() {
                    AppendMenuW(menu, MF_STRING, 1, wide("Daemon info").as_ptr());
                    AppendMenuW(
                        menu,
                        MF_STRING | MF_GRAYED,
                        0,
                        wide("Local updates and restart unsupported").as_ptr(),
                    );
                    AppendMenuW(menu, MF_SEPARATOR, 0, null());
                    AppendMenuW(menu, MF_STRING, 2, wide("Quit").as_ptr());
                    let mut point: POINT = std::mem::zeroed();
                    GetCursorPos(&mut point);
                    SetForegroundWindow(self.tray);
                    let command = TrackPopupMenu(
                        menu,
                        TPM_RETURNCMD | TPM_RIGHTBUTTON,
                        point.x,
                        point.y,
                        0,
                        self.tray,
                        null(),
                    );
                    PostMessageW(self.tray, WM_NULL, 0, 0);
                    DestroyMenu(menu);
                    events |= match command {
                        1 => 4,
                        2 => 8,
                        _ => 0,
                    };
                }
            }
        }
        events & 15
    }
    pub fn notify(&self, title: &str, body: &str) -> u32 {
        let mut data = self.data();
        data.uFlags = NIF_INFO | NIF_REALTIME;
        data.dwInfoFlags = NIIF_INFO;
        text(&mut data.szInfoTitle, title);
        text(&mut data.szInfo, body);
        if unsafe { Shell_NotifyIconW(NIM_MODIFY, &data) } != 0 {
            1
        } else {
            0
        }
    }
    pub fn notification_result(&self, token: u32) -> i32 {
        if token == 1 { 1 } else { -1 }
    }
    pub fn open_config(path: &str) -> Result<()> {
        let result = unsafe {
            ShellExecuteW(
                null_mut(),
                wide("open").as_ptr(),
                wide(path).as_ptr(),
                null(),
                null(),
                SW_SHOWNORMAL,
            )
        } as isize;
        ensure!(result > 32, "Open config failed ({result})");
        Ok(())
    }
}
impl Drop for Shell {
    fn drop(&mut self) {
        unsafe {
            rieul_uninstall_close_guard();
            if !self.tray.is_null() {
                Shell_NotifyIconW(NIM_DELETE, &self.data());
                DestroyWindow(self.tray);
            }
            if !self.icon.is_null() {
                SendMessageW(self.window, WM_SETICON, ICON_BIG as usize, 0);
                SendMessageW(self.window, WM_SETICON, ICON_SMALL as usize, 0);
                DestroyIcon(self.icon);
            }
            UnregisterClassW(self.class.as_ptr(), self.instance);
        }
    }
}
