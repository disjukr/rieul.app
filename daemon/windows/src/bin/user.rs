#![cfg_attr(all(windows, not(debug_assertions)), windows_subsystem = "windows")]

use anyhow::Result;
use clap::{Parser, Subcommand};
use wgo_windows_daemon::window_agent::run_window_agent;

#[derive(Debug, Parser)]
#[command(name = "wgo-windows-user")]
#[command(about = "Windows user-session data agent for whats-going-on")]
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
