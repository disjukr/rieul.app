#[cfg(all(target_os = "macos", not(target_arch = "aarch64")))]
compile_error!("Unsupported platform: Rieul macOS requires Apple Silicon (arm64); Intel Macs are not supported");

#[cfg(unix)]
mod architecture;
pub mod fs;
#[cfg(target_os = "macos")]
pub mod installer;
mod installer_ui;
#[cfg(unix)]
pub mod root_update;
#[cfg(any(target_os = "macos", test))]
pub mod update;
#[cfg(not(target_os = "macos"))]
pub mod installer {
    use anyhow::Result;

    #[derive(Debug, Clone, Copy, PartialEq, Eq)]
    pub enum StartupAction {
        Continue,
        Exit,
    }

    pub fn ensure_installed_or_prompt() -> Result<StartupAction> {
        Ok(StartupAction::Continue)
    }
}
#[cfg(unix)]
pub mod ipc;
#[cfg(target_os = "macos")]
mod process_lsof;
#[cfg(target_os = "macos")]
pub mod process_modules;
#[cfg(target_os = "macos")]
pub mod process_resources;
#[cfg(target_os = "macos")]
pub mod process_sockets;
