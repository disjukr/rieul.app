use anyhow::{anyhow, Context, Result};
use clap::{Parser, Subcommand};
use rieul_daemon_core::config::macos_system_config_path;
use rieul_macos_daemon::installer::{ensure_installed_or_prompt, StartupAction};
#[cfg(unix)]
use std::os::unix::process::CommandExt;
use std::path::PathBuf;
#[cfg(unix)]
use std::{os::unix::fs::MetadataExt, path::Path};
use std::process::Command as ProcessCommand;

#[derive(Debug, Parser)]
#[command(version = rieul_daemon_core::rpc::daemon_build_version())]
#[command(name = "rieul-macos-launcher")]
#[command(about = "macOS Rieul Desktop installer and daemon GUI launcher")]
struct Args {
    #[command(subcommand)]
    command: Option<Command>,
}

#[derive(Debug, Subcommand)]
enum Command {
    /// Inspect the installed app's update migration requirements without changing it.
    #[cfg(target_os = "macos")]
    UpdateStatus,
    Run {
        #[arg(long)]
        config: Option<PathBuf>,
    },
}

fn main() -> Result<()> {
    tracing_subscriber::fmt()
        .with_env_filter(tracing_subscriber::EnvFilter::from_default_env())
        .init();

    let command = Args::parse()
        .command
        .unwrap_or(Command::Run { config: None });
    match command {
        #[cfg(target_os = "macos")]
        Command::UpdateStatus => {
            let status = rieul_macos_daemon::update::installed_update_status()
                .context("inspect installed Rieul update status (no changes made)")?;
            println!("Automatic updates: unavailable");
            for blocker in status.blockers {
                println!("- {blocker}");
            }
            Ok(())
        }
        Command::Run { config } => {
            if ensure_installed_or_prompt()? == StartupAction::Exit {
                return Ok(());
            }
            let config_path = config.unwrap_or_else(macos_system_config_path);
            let gui_executable = gui_executable_path()?;
            exec_gui(gui_executable, config_path)
        }
    }
}

fn gui_executable_path() -> Result<PathBuf> {
    if let Some(path) = std::env::var_os("RIEUL_GUI_EXECUTABLE") {
        return Ok(PathBuf::from(path));
    }

    let launcher = std::env::current_exe().context("resolve launcher executable path")?;
    let directory = launcher
        .parent()
        .ok_or_else(|| anyhow!("launcher executable has no parent directory"))?;
    let executable = directory.join("rieul-gui");
    if executable.is_file() {
        Ok(executable)
    } else {
        Err(anyhow!(
            "bundled GUI executable is missing: {}",
            executable.display()
        ))
    }
}

#[cfg(unix)]
fn exec_gui(gui_executable: PathBuf, config_path: PathBuf) -> Result<()> {
    let bundled = can_yield_installed_gui(&gui_executable, &config_path);
    if let Some(_guard) = rieul_macos_daemon::root_update::gui_update_guard()? {
        return tokio::runtime::Builder::new_current_thread().enable_all().build()?.block_on(async {
            let mut term=tokio::signal::unix::signal(tokio::signal::unix::SignalKind::terminate())?;
            let mut interrupt=tokio::signal::unix::signal(tokio::signal::unix::SignalKind::interrupt())?;
            let mut child=tokio::process::Command::new(&gui_executable).arg("--config").arg(&config_path).kill_on_drop(true).spawn()?;
            tokio::select! {
                status=child.wait()=>{anyhow::ensure!(status?.success(),"GUI exited unsuccessfully");return Ok(());},
                _=term.recv()=>{},
                _=interrupt.recv()=>{},
                _=wait_for_forced_gui_handoff(), if bundled => {},
            }
            if let Some(pid)=child.id(){unsafe{libc::kill(pid as i32,libc::SIGTERM);}}
            match tokio::time::timeout(std::time::Duration::from_secs(10), child.wait()).await {
                Ok(status) => { status?; }
                Err(_) => child.kill().await?,
            }
            Ok(())
        });
    }
    let error = ProcessCommand::new(&gui_executable)
        .arg("--config")
        .arg(config_path)
        .exec();
    Err(error.into())
}

#[cfg(unix)]
fn can_yield_installed_gui(gui_executable: &Path, config_path: &Path) -> bool {
    const MACOS: &str = "/Applications/Rieul.app/Contents/MacOS";
    let launcher = Path::new(MACOS).join("rieul-macos-launcher");
    let gui = Path::new(MACOS).join("rieul-gui");
    let trusted = |p: &Path| {
        p.canonicalize().is_ok_and(|canonical| canonical == p)
            && p.metadata().is_ok_and(|m| m.is_file() && m.uid() == 0 && m.mode() & 0o022 == 0)
    };
    std::env::var_os("RIEUL_GUI_EXECUTABLE").is_none()
        && config_path == macos_system_config_path()
        && gui_executable == gui
        && std::env::current_exe().is_ok_and(|exe| exe == launcher)
        && trusted(&launcher)
        && trusted(&gui)
}

#[cfg(unix)]
async fn wait_for_forced_gui_handoff() {
    let mut tick = tokio::time::interval(std::time::Duration::from_millis(250));
    loop {
        tick.tick().await;
        if rieul_macos_daemon::root_update::gui_force_update_requested().unwrap_or(false) {
            return;
        }
    }
}

#[cfg(not(unix))]
fn exec_gui(_gui_executable: PathBuf, _config_path: PathBuf) -> Result<()> {
    anyhow::bail!("the macOS GUI bootstrap is only available on Unix")
}
