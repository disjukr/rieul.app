#![cfg(windows)]

use std::ffi::c_void;
use std::sync::atomic::{AtomicIsize, AtomicU32, Ordering};

type Hwnd = *mut c_void;
type WndProc = unsafe extern "system" fn(Hwnd, u32, usize, isize) -> isize;

const GWLP_WNDPROC: i32 = -4;
const SW_HIDE: i32 = 0;
const WM_CLOSE: u32 = 0x0010;

static WINDOW: AtomicIsize = AtomicIsize::new(0);
static ORIGINAL_WINDOW_PROC: AtomicIsize = AtomicIsize::new(0);
static CLOSE_REQUESTS: AtomicU32 = AtomicU32::new(0);

#[link(name = "kernel32")]
extern "system" {
    fn GetLastError() -> u32;
}

#[link(name = "user32")]
extern "system" {
    fn CallWindowProcW(
        previous: WndProc,
        window: Hwnd,
        message: u32,
        w_param: usize,
        l_param: isize,
    ) -> isize;
    fn IsWindow(window: Hwnd) -> i32;
    fn SetWindowLongPtrW(window: Hwnd, index: i32, value: isize) -> isize;
    fn ShowWindow(window: Hwnd, command: i32) -> i32;
}

unsafe extern "system" fn close_to_hide_window_proc(
    window: Hwnd,
    message: u32,
    w_param: usize,
    l_param: isize,
) -> isize {
    if message == WM_CLOSE {
        unsafe { ShowWindow(window, SW_HIDE) };
        CLOSE_REQUESTS.fetch_add(1, Ordering::Release);
        return 0;
    }

    let previous = ORIGINAL_WINDOW_PROC.load(Ordering::Acquire);
    if previous == 0 {
        return 0;
    }
    let previous: WndProc = unsafe { std::mem::transmute(previous) };
    unsafe { CallWindowProcW(previous, window, message, w_param, l_param) }
}

#[no_mangle]
pub unsafe extern "C" fn rieul_install_close_guard(window: Hwnd) -> i32 {
    if window.is_null() {
        return 0;
    }

    let raw_window = window as isize;
    if WINDOW.load(Ordering::Acquire) == raw_window {
        return 1;
    }
    unsafe { rieul_uninstall_close_guard() };

    let previous =
        unsafe { SetWindowLongPtrW(window, GWLP_WNDPROC, close_to_hide_window_proc as isize) };
    if previous == 0 {
        let error = unsafe { GetLastError() }.max(1);
        return -(error as i32);
    }
    ORIGINAL_WINDOW_PROC.store(previous, Ordering::Release);
    WINDOW.store(raw_window, Ordering::Release);
    1
}

#[no_mangle]
pub extern "C" fn rieul_take_close_requests() -> u32 {
    CLOSE_REQUESTS.swap(0, Ordering::AcqRel)
}

#[no_mangle]
pub unsafe extern "C" fn rieul_uninstall_close_guard() {
    let window = WINDOW.swap(0, Ordering::AcqRel);
    let previous = ORIGINAL_WINDOW_PROC.swap(0, Ordering::AcqRel);
    if window == 0 || previous == 0 {
        return;
    }

    let window = window as Hwnd;
    if unsafe { IsWindow(window) } != 0 {
        unsafe { SetWindowLongPtrW(window, GWLP_WNDPROC, previous) };
    }
}
