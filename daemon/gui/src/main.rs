#![cfg_attr(windows, windows_subsystem = "windows")]
// Native integration is deliberately not connected to the production launcher
// until both platform shells and visual/lifecycle regression gates pass.
#[cfg(target_os = "macos")]
mod shell;
#[cfg(target_os = "macos")]
mod view;
#[cfg(target_os = "macos")]
fn main() -> anyhow::Result<()> {
    view::run()
}
#[cfg(not(target_os = "macos"))]
fn main() {
    eprintln!("The isolated GPUI prototype currently requires macOS; production GUI is unchanged.");
    std::process::exit(1);
}
