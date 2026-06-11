use anyhow::Result;
use clap::{Parser, Subcommand};
use std::path::PathBuf;
use wgo_daemon_core::config::windows_program_data_config_path;
use wgo_windows_daemon::pairing_ui::create_and_show_pairing_window;
use wgo_windows_daemon::tray::run_pairing_tray;

#[derive(Debug, Parser)]
#[command(name = "wgo-windows-user")]
#[command(about = "Windows user tray daemon for whats-going-on")]
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
    PairingWindow {
        #[arg(long)]
        daemon_url: Option<String>,

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
            run_pairing_tray(config.unwrap_or_else(windows_program_data_config_path))
        }
        Command::PairingWindow { daemon_url, config } => {
            let config_path = config.unwrap_or_else(windows_program_data_config_path);
            create_and_show_pairing_window(&config_path, daemon_url.as_deref())
        }
    }
}
