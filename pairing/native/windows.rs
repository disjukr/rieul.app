// Rieul's own close guard, shared with the pairing bridge.
#[path = "../../daemon/windows-close-guard/src/lib.rs"]
mod close_guard;
use std::ffi::c_void;
type Hwnd = *mut c_void;
#[link(name = "user32")]
extern "system" {
    fn EnumWindows(callback: unsafe extern "system" fn(Hwnd, isize) -> i32, data: isize) -> i32;
    fn GetWindowThreadProcessId(window: Hwnd, pid: *mut u32) -> u32;
    fn GetWindowRect(window: Hwnd, rect: *mut i32) -> i32;
    fn ShowWindow(window: Hwnd, command: i32) -> i32;
    fn SetForegroundWindow(window: Hwnd) -> i32;
    fn IsWindowVisible(window: Hwnd) -> i32;
    fn PostMessageW(window: Hwnd, message: u32, wparam: usize, lparam: isize) -> i32;
}
struct Search { pid: u32, window: Hwnd }
unsafe extern "system" fn find(window: Hwnd, data: isize) -> i32 {
    let search = unsafe { &mut *(data as *mut Search) };
    let mut pid = 0;
    unsafe { GetWindowThreadProcessId(window, &mut pid) };
    if pid != search.pid { return 1; }
    let mut rect = [0; 4];
    if unsafe { GetWindowRect(window, rect.as_mut_ptr()) } != 0 && rect[2] - rect[0] >= 300 && rect[3] - rect[1] >= 200 {
        search.window = window;
        return 0;
    }
    1
}
#[no_mangle]
pub unsafe extern "C" fn rieul_pairing_window(pid: u32) -> Hwnd {
    let mut search = Search { pid, window: std::ptr::null_mut() };
    unsafe { EnumWindows(find, &mut search as *mut Search as isize) };
    search.window
}
#[no_mangle]
pub unsafe extern "C" fn rieul_pairing_visible(window: Hwnd) -> i32 { unsafe { IsWindowVisible(window) } }
#[no_mangle]
pub unsafe extern "C" fn rieul_pairing_show(window: Hwnd, visible: i32) {
    unsafe { ShowWindow(window, if visible == 0 { 0 } else { 5 }) };
    if visible != 0 { unsafe { SetForegroundWindow(window) }; }
}
// Also used by disposable native QA to exercise the actual WM_CLOSE subclass.
#[no_mangle]
pub unsafe extern "C" fn rieul_pairing_close(window: Hwnd) { unsafe { PostMessageW(window, 0x10, 0, 0) }; }

// Windows owns this callback and may invoke it reentrantly from user32 calls.
// Do not enter the JS engine here; the UI polls these actions on its event loop.
use std::sync::atomic::{AtomicU32, Ordering};
static TRAY_EVENTS: AtomicU32 = AtomicU32::new(0);
static TASKBAR_CREATED: AtomicU32 = AtomicU32::new(0);
#[link(name = "user32")]
extern "system" {
    fn DefWindowProcW(window: Hwnd, message: u32, wparam: usize, lparam: isize) -> isize;
}
unsafe extern "system" fn tray_window_proc(window: Hwnd, message: u32, wparam: usize, lparam: isize) -> isize {
    let event = if message == 0x111 {
        match wparam & 0xffff { 1 => 2, 2 => 4, _ => 0 }
    } else if message == TASKBAR_CREATED.load(Ordering::Relaxed) {
        8
    } else if message == 0x8001 {
        match lparam & 0xffff {
            0x202 | 0x203 | 0x400 | 0x401 | 0x405 => 1,
            0x205 | 0x7b => 16,
            _ => 0,
        }
    } else {
        return unsafe { DefWindowProcW(window, message, wparam, lparam) };
    };
    TRAY_EVENTS.fetch_or(event, Ordering::Release);
    0
}
#[no_mangle]
pub extern "C" fn rieul_tray_window_proc(taskbar_created: u32) -> *const c_void {
    TASKBAR_CREATED.store(taskbar_created, Ordering::Relaxed);
    TRAY_EVENTS.store(0, Ordering::Release);
    tray_window_proc as *const c_void
}
#[no_mangle]
pub extern "C" fn rieul_take_tray_events() -> u32 {
    TRAY_EVENTS.swap(0, Ordering::AcqRel)
}
