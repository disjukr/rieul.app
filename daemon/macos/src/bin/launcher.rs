use anyhow::{anyhow, Context, Result};
use clap::{Parser, Subcommand};
use rieul_daemon_core::config::macos_system_config_path;
use rieul_macos_daemon::installer::{ensure_installed_or_prompt, StartupAction};
#[cfg(unix)]
use std::os::unix::process::CommandExt;
use std::path::PathBuf;
use std::process::Command as ProcessCommand;

#[derive(Debug, Parser)]
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
            #[cfg(target_os = "macos")]
            if config.is_none() {
                if let Some(controller) = configured_update_controller()? {
                    // The controller owns the GUI child and Sparkle lifecycle.
                    // Never fall back to the legacy installer after a failed
                    // updater launch or migration: that could recreate root jobs.
                    return Err(ProcessCommand::new(controller).arg("run").exec().into());
                }
            }
            if ensure_installed_or_prompt()? == StartupAction::Exit {
                return Ok(());
            }
            let config_path = config.unwrap_or_else(macos_system_config_path);
            let gui_executable = gui_executable_path()?;
            exec_gui(gui_executable, config_path)
        }
    }
}

#[cfg(target_os = "macos")]
fn configured_update_controller() -> Result<Option<PathBuf>> {
    let executable = std::env::current_exe().context("resolve launcher executable")?;
    let app = PathBuf::from("/Applications/Rieul.app");
    if executable != app.join("Contents/MacOS/rieul-macos-launcher") {
        return Ok(None);
    }
    let configuration = ProcessCommand::new("/usr/libexec/PlistBuddy")
        .args(["-c", "Print :RieulUpdaterEnabled"])
        .arg(app.join("Contents/Info.plist"))
        .output()
        .context("read signed updater configuration")?;
    if !configuration.status.success()
        || String::from_utf8_lossy(&configuration.stdout).trim() != "true"
    {
        return Ok(None);
    }
    let controller = app.join("Contents/MacOS/rieul-update-controller");
    if !controller.is_file() {
        return Err(anyhow!(
            "enabled updater controller is missing; repair installation"
        ));
    }
    Ok(Some(controller))
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
