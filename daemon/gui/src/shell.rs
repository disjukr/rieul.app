// The existing AppKit lifecycle bridge is statically linked, without Bun FFI.
#[cfg(target_os = "macos")]
mod macos {
    use std::ffi::CString;
    unsafe extern "C" {
        fn rieul_macos_init(icon: *const std::ffi::c_char) -> i32;
        fn rieul_macos_show(visible: i32) -> i32;
        fn rieul_macos_visible() -> i32;
        fn rieul_macos_close() -> i32;
        fn rieul_macos_take_events() -> u32;
        fn rieul_macos_notify(title: *const std::ffi::c_char, body: *const std::ffi::c_char)
        -> u32;
        fn rieul_macos_notification_result(token: u32) -> i32;
        fn rieul_macos_updates(
            label: *const std::ffi::c_char,
            detail: *const std::ffi::c_char,
            check: i32,
            install: i32,
            restart: i32,
        );
        fn rieul_macos_confirm_update(restart: i32) -> i32;
        fn rieul_macos_destroy() -> i32;
    }
    pub struct Shell;
    impl Shell {
        pub fn new(icon: &str) -> anyhow::Result<Self> {
            let icon = CString::new(icon)?;
            anyhow::ensure!(
                unsafe { rieul_macos_init(icon.as_ptr()) } == 1,
                "AppKit tray/window initialization failed"
            );
            Ok(Self)
        }
        pub fn visible(&self, visible: bool) {
            unsafe {
                rieul_macos_show(i32::from(visible));
            }
        }
        pub fn is_visible(&self) -> bool {
            unsafe { rieul_macos_visible() != 0 }
        }
        pub fn close(&self) {
            unsafe {
                rieul_macos_close();
            }
        }
        pub fn updates(&self, model: &rieul_gui::updates::Updates) {
            let label = CString::new(model.label()).unwrap();
            let detail = CString::new(model.detail().unwrap_or("").replace('\0', "")).unwrap();
            unsafe {
                rieul_macos_updates(
                    label.as_ptr(),
                    detail.as_ptr(),
                    model.can_check().into(),
                    model.can_install().into(),
                    model.can_restart().into(),
                );
            }
        }
        pub fn confirm_update(&self, restart: bool) -> bool {
            unsafe { rieul_macos_confirm_update(restart.into()) != 0 }
        }
        pub fn events(&self) -> u32 {
            unsafe { rieul_macos_take_events() }
        }
        pub fn notify(&self, title: &str, body: &str) -> u32 {
            let (Ok(title), Ok(body)) = (CString::new(title), CString::new(body)) else {
                return 0;
            };
            unsafe { rieul_macos_notify(title.as_ptr(), body.as_ptr()) }
        }
        pub fn notification_result(&self, token: u32) -> i32 {
            unsafe { rieul_macos_notification_result(token) }
        }
    }
    impl Drop for Shell {
        fn drop(&mut self) {
            unsafe {
                rieul_macos_destroy();
            }
        }
    }
}
#[cfg(target_os = "macos")]
pub use macos::Shell;
#[cfg(windows)]
#[path = "windows_shell.rs"]
mod windows;
#[cfg(windows)]
pub use windows::Shell;
