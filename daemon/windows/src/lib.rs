pub mod fs;
pub mod ipc;
pub mod process_modules;
pub mod process_resources;
pub mod process_sockets;
#[cfg(windows)]
pub mod service;
pub mod terminal_ipc;
pub mod user_process;
pub mod windows;

#[cfg(windows)]
pub mod desktop_native;

#[cfg(any(windows, test))]
pub mod desktop_pixels;

#[cfg(windows)]
pub mod desktop;
