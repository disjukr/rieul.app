#![cfg_attr(windows, windows_subsystem = "windows")]
mod shell;
mod view;
fn main() -> anyhow::Result<()> {
    let executable = std::env::current_exe()?;
    let verify = std::env::args().any(|arg| arg == "--verify-bundle");
    let root = rieul_gui::bundle::root(&executable)?;
    if verify || root.join("bundle.json").exists() {
        rieul_gui::bundle::verify(&executable)?;
        if verify {
            println!("verified native Rust GPUI payload v2");
            return Ok(());
        }
    } else if !cfg!(debug_assertions) {
        anyhow::bail!("packaged native GUI manifest is missing");
    }
    view::run()
}
