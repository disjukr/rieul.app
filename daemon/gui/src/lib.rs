#[cfg(all(target_os = "macos", not(target_arch = "aarch64")))]
compile_error!(
    "Unsupported platform: Rieul macOS requires Apple Silicon (arm64); Intel Macs are not supported"
);

pub mod bundle;
pub mod controller;
pub mod transport;

pub mod desktop_helper;

pub mod updates;

pub mod update_transport;
