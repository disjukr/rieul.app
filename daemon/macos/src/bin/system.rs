use std::net::SocketAddr;
use std::path::PathBuf;
use std::sync::Arc;

use anyhow::Result;
use clap::{Parser, Subcommand};
use tracing::info;
use wgo_daemon_core::config::{
    client_credentials_path, load_or_generated_default, macos_system_config_path, save,
    SystemConfig,
};
use wgo_daemon_host::server::run_system_server;
use wgo_macos_daemon::fs::MacFileService;
use wgo_macos_daemon::ipc::MacUserPairingNotifier;
use wgo_macos_daemon::process_modules::MacProcessModulesService;
use wgo_macos_daemon::process_resources::MacProcessResourcesInUseService;
use wgo_macos_daemon::process_sockets::MacProcessSocketsInUseService;

#[derive(Debug, Parser)]
#[command(name = "wgo-macos-system")]
#[command(about = "macOS system daemon for whats-going-on")]
struct Args {
    #[command(subcommand)]
    command: Command,
}

#[derive(Debug, Subcommand)]
enum Command {
    Run {
        #[arg(long)]
        listen: Option<SocketAddr>,

        #[arg(long)]
        config: Option<PathBuf>,
    },
    Pair {
        #[arg(long)]
        listen: Option<SocketAddr>,

        #[arg(long)]
        config: Option<PathBuf>,

        #[arg(long)]
        url: Option<String>,
    },
    Service {
        #[command(subcommand)]
        command: ServiceCommand,
    },
}

#[derive(Debug, Subcommand)]
enum ServiceCommand {
    Install,
    Uninstall,
    Start,
    Stop,
}

#[tokio::main]
async fn main() -> Result<()> {
    tracing_subscriber::fmt()
        .with_env_filter(tracing_subscriber::EnvFilter::from_default_env())
        .init();

    match Args::parse().command {
        Command::Run { listen, config } => {
            run_system_server(
                listen,
                config.unwrap_or_else(macos_system_config_path),
                Arc::new(MacFileService::default()),
                None,
                Some(Arc::new(MacProcessResourcesInUseService)),
                Some(Arc::new(MacProcessSocketsInUseService)),
                Some(Arc::new(MacProcessModulesService)),
                Some(Arc::new(MacUserPairingNotifier)),
                "macOS system daemon",
            )
            .await
        }
        Command::Pair {
            listen,
            config,
            url,
        } => {
            let config_path = config.unwrap_or_else(macos_system_config_path);
            let mut config = load_or_generated_default(&config_path)?;
            let listen = match listen {
                Some(listen) => {
                    config.listen_addr = listen.to_string();
                    listen
                }
                None => config.listen_addr.parse()?,
            };
            save(&config_path, &config)?;
            let credentials_path = client_credentials_path(&config_path);
            let daemon_url = url.unwrap_or_else(|| default_pairing_url(&config, listen));
            println!("URL: {daemon_url}");
            println!("Config: {}", config_path.display());
            println!("Client credentials: {}", credentials_path.display());
            println!(
                "Start pairing from a client. Pairing codes are kept only in the running daemon process."
            );
            Ok(())
        }
        Command::Service { command } => {
            info!(
                ?command,
                "service management is scaffolded for the macOS backend"
            );
            println!("service command {command:?} is scaffolded; LaunchDaemon integration is next");
            Ok(())
        }
    }
}

fn default_pairing_url(config: &SystemConfig, listen: SocketAddr) -> String {
    let port = listen.port();
    if let Some(domain) = config
        .domain
        .as_deref()
        .map(str::trim)
        .filter(|domain| !domain.is_empty())
    {
        if port == 443 {
            return format!("https://{domain}");
        }
        return format!("https://{domain}:{port}");
    }
    if listen.ip().is_unspecified() {
        return format!("https://localhost:{port}");
    }
    format!("https://{listen}")
}
