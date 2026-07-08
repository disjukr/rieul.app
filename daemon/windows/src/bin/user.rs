#![cfg_attr(all(windows, not(debug_assertions)), windows_subsystem = "windows")]

use anyhow::Result;
use clap::{Parser, Subcommand};
use rieul_windows_daemon::window_agent::run_window_agent;

#[derive(Debug, Parser)]
#[command(name = "rieul-windows-user")]
#[command(about = "Windows user-session data agent for rieul")]
struct Args {
    #[command(subcommand)]
    command: Option<Command>,
}

#[derive(Debug, Subcommand)]
enum Command {
    Run,
}

fn main() -> Result<()> {
    tracing_subscriber::fmt()
        .with_env_filter(tracing_subscriber::EnvFilter::from_default_env())
        .init();

    match Args::parse().command.unwrap_or(Command::Run) {
        Command::Run => run_window_agent(),
    }
}
