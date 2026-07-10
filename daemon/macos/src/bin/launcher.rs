use anyhow::Result;
use clap::{Parser, Subcommand};
use rieul_daemon_core::config::macos_system_config_path;
use rieul_macos_daemon::installer::{ensure_installed_or_prompt, StartupAction};
#[cfg(unix)]
use std::os::unix::process::CommandExt;
use std::path::PathBuf;
use std::process::Command as ProcessCommand;

#[derive(Debug, Parser)]
#[command(name = "rieul-macos-launcher")]
#[command(about = "macOS installer and GUI launcher for rieul")]
struct Args {
    #[command(subcommand)]
    command: Command,
}

#[derive(Debug, Subcommand)]
enum Command {
    Run {
        #[arg(long)]
        config: Option<PathBuf>,
    },
}

fn main() -> Result<()> {
    tracing_subscriber::fmt()
        .with_env_filter(tracing_subscriber::EnvFilter::from_default_env())
        .init();

    match Args::parse().command {
        Command::Run { config } => {
            if ensure_installed_or_prompt()? == StartupAction::Exit {
                return Ok(());
            }
            let config_path = config.unwrap_or_else(macos_system_config_path);
            let gui_executable = std::env::var_os("RIEUL_GUI_EXECUTABLE")
                .map(PathBuf::from)
                .ok_or_else(|| anyhow::anyhow!("RIEUL_GUI_EXECUTABLE is not set"))?;
            exec_gui(gui_executable, config_path)
        }
    }
}

#[cfg(unix)]
fn exec_gui(gui_executable: PathBuf, config_path: PathBuf) -> Result<()> {
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
