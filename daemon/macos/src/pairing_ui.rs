use anyhow::Result;

#[derive(Debug, Clone)]
pub struct PairingWindowModel {
    pub daemon_url: String,
    pub pairing_code: String,
    pub expires_in_seconds: i64,
}

pub fn show_pairing_window(model: &PairingWindowModel) -> Result<()> {
    let message = format!(
        "URL: {}\n\nPairing code: {}\nExpires in: {} seconds",
        model.daemon_url, model.pairing_code, model.expires_in_seconds
    );
    show_message_box("wgo pairing", &message)
}

#[cfg(windows)]
fn show_message_box(title: &str, message: &str) -> Result<()> {
    use windows::core::HSTRING;
    use windows::Win32::UI::WindowsAndMessaging::{MessageBoxW, MB_ICONINFORMATION, MB_OK};

    unsafe {
        MessageBoxW(
            None,
            &HSTRING::from(message),
            &HSTRING::from(title),
            MB_OK | MB_ICONINFORMATION,
        );
    }
    Ok(())
}

#[cfg(not(windows))]
fn show_message_box(title: &str, message: &str) -> Result<()> {
    println!("{title}\n{message}");
    Ok(())
}
