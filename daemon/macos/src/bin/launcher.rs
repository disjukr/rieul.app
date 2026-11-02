use anyhow::{anyhow, Context, Result};
use clap::{Parser, Subcommand};
use rieul_daemon_core::config::macos_system_config_path;
use rieul_macos_daemon::installer::{ensure_installed_or_prompt, StartupAction};
#[cfg(unix)]
use std::os::unix::process::CommandExt;
use std::path::PathBuf;
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
    if let Some(_guard) = rieul_macos_daemon::root_update::gui_update_guard()? {
        return tokio::runtime::Builder::new_current_thread().enable_all().build()?.block_on(async {
            let mut term=tokio::signal::unix::signal(tokio::signal::unix::SignalKind::terminate())?;
            let mut interrupt=tokio::signal::unix::signal(tokio::signal::unix::SignalKind::interrupt())?;
            let mut child=tokio::process::Command::new(&gui_executable).arg("--config").arg(&config_path).kill_on_drop(true).spawn()?;
            tokio::select! {
                status=child.wait()=>{anyhow::ensure!(status?.success(),"GUI exited unsuccessfully");return Ok(());},
                _=term.recv()=>{},
                _=interrupt.recv()=>{},
            }
            if let Some(pid)=child.id(){unsafe{libc::kill(pid as i32,libc::SIGTERM);}}
            if tokio::time::timeout(std::time::Duration::from_secs(10),child.wait()).await.is_err(){child.kill().await?;}
            Ok(())
        });
    }
    let error = ProcessCommand::new(&gui_executable)
        .arg("--config")
        .arg(config_path)
        .exec();
    Err(error.into())
}

#[cfg(not(unix))]
fn exec_gui(_gui_executable: PathBuf, _config_path: PathBuf) -> Result<()> {
    anyhow::bail!("the macOS GUI bootstrap is only available on Unix")
}
