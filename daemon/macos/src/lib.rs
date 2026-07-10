pub mod fs;
#[cfg(target_os = "macos")]
pub mod installer;
mod installer_ui;
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
