#![cfg_attr(all(windows, not(debug_assertions)), windows_subsystem = "windows")]

use anyhow::Result;
use clap::{Parser, Subcommand};
use rieul_daemon_core::config::windows_program_data_config_path;
use rieul_windows_daemon::user_process::run_user_process;
use std::path::PathBuf;

#[derive(Debug, Parser)]
#[command(name = "rieul-windows-user")]
#[command(about = "Windows user-session process for rieul")]
struct Args {
    #[command(subcommand)]
    command: Option<Command>,
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

    match Args::parse()
        .command
        .unwrap_or(Command::Run { config: None })
    {
        Command::Run { config } => {
            run_user_process(config.unwrap_or_else(windows_program_data_config_path))
        }
    }
}
