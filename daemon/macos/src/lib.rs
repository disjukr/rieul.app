pub mod fs;
#[cfg(unix)]
pub mod ipc;
pub mod pairing_ui;
#[cfg(target_os = "macos")]
pub mod tray;
#[cfg(not(target_os = "macos"))]
pub mod tray {
    use std::path::PathBuf;

    use anyhow::Result;

    pub fn run_pairing_tray(_config_path: PathBuf) -> Result<()> {
        anyhow::bail!("macOS tray UI is only available on macOS")
    }
}
