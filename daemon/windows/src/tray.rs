use anyhow::Result;
use std::path::PathBuf;

#[cfg(windows)]
pub fn run_pairing_tray(config_path: PathBuf) -> Result<()> {
    windows_tray::run(config_path)
}

#[cfg(not(windows))]
pub fn run_pairing_tray(_config_path: PathBuf) -> Result<()> {
    anyhow::bail!("Windows tray UI is only available on Windows");
}

#[cfg(windows)]
mod windows_tray {
    use std::ffi::c_void;
    use std::mem::size_of;
    use std::path::PathBuf;
    use std::sync::OnceLock;

    use anyhow::{anyhow, Result};
    use windows::core::{w, PCWSTR};
    use windows::Win32::Foundation::{HINSTANCE, HWND, LPARAM, LRESULT, POINT, WPARAM};
    use windows::Win32::System::LibraryLoader::GetModuleHandleW;
    use windows::Win32::UI::Shell::{
        Shell_NotifyIconW, NIF_ICON, NIF_INFO, NIF_MESSAGE, NIF_TIP, NIIF_INFO, NIM_ADD,
        NIM_DELETE, NIM_MODIFY, NIM_SETVERSION, NIN_SELECT, NOTIFYICONDATAW, NOTIFYICON_VERSION_4,
    };
    use windows::Win32::UI::WindowsAndMessaging::{
        AppendMenuW, CreateIconFromResourceEx, CreatePopupMenu, CreateWindowExW, DefWindowProcW,
        DestroyIcon, DestroyMenu, DestroyWindow, DispatchMessageW, GetCursorPos, GetMessageW,
        PostMessageW, PostQuitMessage, RegisterClassW, SetForegroundWindow, TrackPopupMenu,
        TranslateMessage, HICON, LR_DEFAULTCOLOR, MF_SEPARATOR, MF_STRING, MSG, TPM_LEFTALIGN,
        TPM_RETURNCMD, TPM_RIGHTBUTTON, WINDOW_EX_STYLE, WM_APP, WM_COMMAND, WM_CONTEXTMENU,
        WM_DESTROY, WNDCLASSW, WS_OVERLAPPED,
    };

    use crate::ipc::{spawn_pairing_notification_server, PairingNotification};
    use crate::pairing_ui::{
        create_and_show_pairing_window_owned, show_error_window, show_machine_info_window_owned,
        show_pairing_window, PairingWindowModel,
    };

    const CLASS_NAME: PCWSTR = w!("WgoWindowsUserTrayWindow");
    const WINDOW_TITLE: PCWSTR = w!("Whats Going On");
    const TRAY_MESSAGE: u32 = WM_APP + 1;
    const PAIRING_NOTIFICATION_MESSAGE: u32 = WM_APP + 2;
    const TRAY_ICON_ID: u32 = 1;
    const CMD_SHOW_MACHINE_INFO: usize = 1001;
    const CMD_SHOW_PAIRING: usize = 1002;
    const CMD_QUIT: usize = 1003;
    const NIN_KEYSELECT: u32 = 1025;
    const TRAY_ICON_BYTES: &[u8] = include_bytes!("../assets/tray.ico");
    const TRAY_ICON_SIZE: i32 = 32;
    const ICON_RESOURCE_VERSION: u32 = 0x0003_0000;

    struct TrayRuntime {
        config_path: PathBuf,
    }

    static TRAY_RUNTIME: OnceLock<TrayRuntime> = OnceLock::new();

    pub fn run(config_path: PathBuf) -> Result<()> {
        TRAY_RUNTIME
            .set(TrayRuntime { config_path })
            .map_err(|_| anyhow!("tray runtime was already initialized"))?;

        unsafe {
            let instance = current_instance()?;
            register_window_class(instance)?;
            let hwnd = create_message_window(instance)?;
            let icon = load_tray_icon()?;
            add_tray_icon(hwnd, icon)?;
            let hwnd_value = hwnd.0 as usize;
            spawn_pairing_notification_server(move |notification| {
                post_pairing_notification(hwnd_value, notification);
            });

            let message_result = run_message_loop();
            remove_tray_icon(hwnd);
            let _ = DestroyIcon(icon);
            let _ = DestroyWindow(hwnd);
            message_result
        }
    }

    unsafe fn current_instance() -> Result<HINSTANCE> {
        let module = unsafe { GetModuleHandleW(None)? };
        Ok(HINSTANCE(module.0))
    }

    unsafe fn register_window_class(instance: HINSTANCE) -> Result<()> {
        let window_class = WNDCLASSW {
            lpfnWndProc: Some(window_proc),
            hInstance: instance,
            lpszClassName: CLASS_NAME,
            ..Default::default()
        };
        let atom = unsafe { RegisterClassW(&window_class) };
        if atom == 0 {
            return Err(windows::core::Error::from_thread().into());
        }
        Ok(())
    }

    unsafe fn create_message_window(instance: HINSTANCE) -> Result<HWND> {
        Ok(unsafe {
            CreateWindowExW(
                WINDOW_EX_STYLE::default(),
                CLASS_NAME,
                WINDOW_TITLE,
                WS_OVERLAPPED,
                0,
                0,
                0,
                0,
                None,
                None,
                Some(instance),
                None,
            )?
        })
    }

    unsafe fn add_tray_icon(hwnd: HWND, icon: HICON) -> Result<()> {
        let mut data = notify_icon_data(hwnd);
        data.uFlags = NIF_MESSAGE | NIF_ICON | NIF_TIP;
        data.uCallbackMessage = TRAY_MESSAGE;
        data.hIcon = icon;
        write_wide(&mut data.szTip, "Whats Going On");

        if !unsafe { Shell_NotifyIconW(NIM_ADD, &data) }.as_bool() {
            return Err(windows::core::Error::from_thread().into());
        }

        data.Anonymous.uVersion = NOTIFYICON_VERSION_4;
        if !unsafe { Shell_NotifyIconW(NIM_SETVERSION, &data) }.as_bool() {
            remove_tray_icon(hwnd);
            return Err(windows::core::Error::from_thread().into());
        }
        Ok(())
    }

    fn load_tray_icon() -> Result<HICON> {
        let image = select_ico_image(TRAY_ICON_BYTES, TRAY_ICON_SIZE as u16)?;
        unsafe {
            CreateIconFromResourceEx(
                image,
                true,
                ICON_RESOURCE_VERSION,
                TRAY_ICON_SIZE,
                TRAY_ICON_SIZE,
                LR_DEFAULTCOLOR,
            )
            .map_err(Into::into)
        }
    }

    fn select_ico_image(ico: &[u8], desired_size: u16) -> Result<&[u8]> {
        if read_u16_le(ico, 0)? != 0 || read_u16_le(ico, 2)? != 1 {
            return Err(anyhow!("invalid tray icon file"));
        }

        let count = read_u16_le(ico, 4)? as usize;
        let mut best: Option<(u16, &[u8])> = None;
        for index in 0..count {
            let entry_offset = 6 + index * 16;
            if entry_offset + 16 > ico.len() {
                return Err(anyhow!("invalid tray icon directory"));
            }

            let width = icon_dimension(ico[entry_offset]);
            let height = icon_dimension(ico[entry_offset + 1]);
            if width != height {
                continue;
            }

            let image_size = read_u32_le(ico, entry_offset + 8)? as usize;
            let image_offset = read_u32_le(ico, entry_offset + 12)? as usize;
            let image = ico
                .get(image_offset..image_offset + image_size)
                .ok_or_else(|| anyhow!("invalid tray icon image"))?;

            let should_replace = match best {
                None => true,
                Some((best_size, _)) if width >= desired_size && best_size < desired_size => true,
                Some((best_size, _)) if width >= desired_size && best_size >= desired_size => {
                    width < best_size
                }
                Some((best_size, _)) if width < desired_size && best_size < desired_size => {
                    width > best_size
                }
                _ => false,
            };

            if should_replace {
                best = Some((width, image));
            }
        }

        best.map(|(_, image)| image)
            .ok_or_else(|| anyhow!("tray icon file does not contain any square images"))
    }

    fn icon_dimension(value: u8) -> u16 {
        if value == 0 {
            256
        } else {
            value as u16
        }
    }

    fn read_u16_le(input: &[u8], offset: usize) -> Result<u16> {
        let bytes = input
            .get(offset..offset + 2)
            .ok_or_else(|| anyhow!("invalid tray icon file"))?;
        Ok(u16::from_le_bytes([bytes[0], bytes[1]]))
    }

    fn read_u32_le(input: &[u8], offset: usize) -> Result<u32> {
        let bytes = input
            .get(offset..offset + 4)
            .ok_or_else(|| anyhow!("invalid tray icon file"))?;
        Ok(u32::from_le_bytes([bytes[0], bytes[1], bytes[2], bytes[3]]))
    }

    fn remove_tray_icon(hwnd: HWND) {
        let data = notify_icon_data(hwnd);
        unsafe {
            let _ = Shell_NotifyIconW(NIM_DELETE, &data);
        }
    }

    fn notify_icon_data(hwnd: HWND) -> NOTIFYICONDATAW {
        NOTIFYICONDATAW {
            cbSize: size_of::<NOTIFYICONDATAW>() as u32,
            hWnd: hwnd,
            uID: TRAY_ICON_ID,
            ..Default::default()
        }
    }

    unsafe fn run_message_loop() -> Result<()> {
        let mut message = MSG::default();
        while unsafe { GetMessageW(&mut message, None, 0, 0) }.as_bool() {
            unsafe {
                let _ = TranslateMessage(&message);
                DispatchMessageW(&message);
            }
        }
        Ok(())
    }

    unsafe extern "system" fn window_proc(
        hwnd: HWND,
        message: u32,
        wparam: WPARAM,
        lparam: LPARAM,
    ) -> LRESULT {
        match message {
            TRAY_MESSAGE => {
                let event = tray_event(lparam);
                match event {
                    NIN_SELECT | NIN_KEYSELECT => show_machine_info(hwnd),
                    WM_CONTEXTMENU => show_context_menu(hwnd),
                    _ => {}
                }
                LRESULT(0)
            }
            PAIRING_NOTIFICATION_MESSAGE => {
                if wparam.0 == 0 {
                    return LRESULT(0);
                }
                let notification = unsafe { Box::from_raw(wparam.0 as *mut PairingNotification) };
                if let Err(err) = show_pairing_notification(hwnd, &notification) {
                    let _ = show_pairing_window(&PairingWindowModel {
                        daemon_url: notification.daemon_url.clone(),
                        pairing_code: notification.pairing_code.clone(),
                        expires_in_seconds: notification.expires_in_seconds,
                    });
                    let _ = show_error_window(&format!(
                        "Failed to show pairing notification:\n\n{err}"
                    ));
                }
                LRESULT(0)
            }
            WM_COMMAND => {
                match low_word(wparam.0) as usize {
                    CMD_SHOW_MACHINE_INFO => show_machine_info(hwnd),
                    CMD_SHOW_PAIRING => show_pairing_code(hwnd),
                    CMD_QUIT => {
                        let _ = unsafe { DestroyWindow(hwnd) };
                    }
                    _ => {}
                }
                LRESULT(0)
            }
            WM_DESTROY => {
                remove_tray_icon(hwnd);
                unsafe { PostQuitMessage(0) };
                LRESULT(0)
            }
            _ => unsafe { DefWindowProcW(hwnd, message, wparam, lparam) },
        }
    }

    fn post_pairing_notification(hwnd_value: usize, notification: PairingNotification) {
        let raw = Box::into_raw(Box::new(notification));
        let hwnd = HWND(hwnd_value as *mut c_void);
        if let Err(err) = unsafe {
            PostMessageW(
                Some(hwnd),
                PAIRING_NOTIFICATION_MESSAGE,
                WPARAM(raw as usize),
                LPARAM(0),
            )
        } {
            unsafe {
                drop(Box::from_raw(raw));
            }
            let _ = show_error_window(&format!("Failed to queue pairing notification:\n\n{err}"));
        }
    }

    fn show_context_menu(hwnd: HWND) {
        if let Err(err) = unsafe { show_context_menu_inner(hwnd) } {
            let _ = show_error_window(&format!("Failed to open tray menu:\n\n{err}"));
        }
    }

    unsafe fn show_context_menu_inner(hwnd: HWND) -> Result<()> {
        let menu = unsafe { CreatePopupMenu()? };
        unsafe {
            AppendMenuW(menu, MF_STRING, CMD_SHOW_MACHINE_INFO, w!("Machine info"))?;
            AppendMenuW(menu, MF_STRING, CMD_SHOW_PAIRING, w!("Show pairing code"))?;
            AppendMenuW(menu, MF_SEPARATOR, 0, PCWSTR::null())?;
            AppendMenuW(menu, MF_STRING, CMD_QUIT, w!("Quit"))?;
        }

        let mut point = POINT::default();
        unsafe { GetCursorPos(&mut point)? };
        unsafe {
            let _ = SetForegroundWindow(hwnd);
        }
        let command = unsafe {
            TrackPopupMenu(
                menu,
                TPM_LEFTALIGN | TPM_RIGHTBUTTON | TPM_RETURNCMD,
                point.x,
                point.y,
                None,
                hwnd,
                None,
            )
        };
        unsafe { DestroyMenu(menu)? };

        if command.0 != 0 {
            unsafe {
                PostMessageW(
                    Some(hwnd),
                    WM_COMMAND,
                    WPARAM(command.0 as usize),
                    LPARAM(0),
                )?;
            }
        }
        Ok(())
    }

    fn show_machine_info(hwnd: HWND) {
        let Some(runtime) = TRAY_RUNTIME.get() else {
            let _ = show_error_window("Tray runtime is not initialized.");
            return;
        };
        if let Err(err) = show_machine_info_window_owned(&runtime.config_path, hwnd) {
            let _ = show_error_window(&format!("Failed to show machine info:\n\n{err}"));
        }
    }

    fn show_pairing_code(hwnd: HWND) {
        let Some(runtime) = TRAY_RUNTIME.get() else {
            let _ = show_error_window("Tray runtime is not initialized.");
            return;
        };
        if let Err(err) = create_and_show_pairing_window_owned(&runtime.config_path, None, hwnd) {
            let _ = show_error_window(&format!("Failed to create pairing code:\n\n{err}"));
        }
    }

    fn show_pairing_notification(hwnd: HWND, notification: &PairingNotification) -> Result<()> {
        let mut data = notify_icon_data(hwnd);
        data.uFlags = NIF_INFO;
        data.dwInfoFlags = NIIF_INFO;
        data.Anonymous.uTimeout = 10_000;
        write_wide(&mut data.szInfoTitle, "Pairing requested");
        write_wide(
            &mut data.szInfo,
            &format!(
                "Code: {}\nExpires in {} seconds",
                notification.pairing_code, notification.expires_in_seconds
            ),
        );

        if !unsafe { Shell_NotifyIconW(NIM_MODIFY, &data) }.as_bool() {
            return Err(windows::core::Error::from_thread().into());
        }
        Ok(())
    }

    fn low_word(value: usize) -> u16 {
        (value & 0xffff) as u16
    }

    fn tray_event(lparam: LPARAM) -> u32 {
        low_word(lparam.0 as usize) as u32
    }

    fn write_wide<const N: usize>(buffer: &mut [u16; N], value: &str) {
        for (slot, unit) in buffer
            .iter_mut()
            .zip(value.encode_utf16().chain(std::iter::once(0)))
        {
            *slot = unit;
        }
    }
}
