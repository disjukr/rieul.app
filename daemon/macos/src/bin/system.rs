use std::net::SocketAddr;
use std::path::PathBuf;
#[cfg(target_os = "macos")]
use std::sync::Arc;

use anyhow::Result;
use clap::{Parser, Subcommand};
#[cfg(target_os = "macos")]
use rieul_daemon_core::config::{
    client_credentials_path, load_or_generated_default, macos_system_config_path, save,
    SystemConfig,
};
#[cfg(target_os = "macos")]
use rieul_daemon_host::server::run_system_server;
#[cfg(target_os = "macos")]
use rieul_macos_daemon::fs::MacFileService;
#[cfg(target_os = "macos")]
use rieul_macos_daemon::ipc::MacGuiPairingNotifier;
#[cfg(target_os = "macos")]
use rieul_macos_daemon::process_modules::MacProcessModulesService;
#[cfg(target_os = "macos")]
use rieul_macos_daemon::process_resources::MacProcessResourcesInUseService;
#[cfg(target_os = "macos")]
use rieul_macos_daemon::process_sockets::MacProcessSocketsInUseService;
#[cfg(target_os = "macos")]
use tracing::info;

#[derive(Debug, Parser)]
#[command(name = "rieul-macos-system")]
#[command(about = "macOS system daemon for rieul")]
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
#[cfg(target_os = "macos")]
async fn main() -> Result<()> {
    tracing_subscriber::fmt()
        .with_env_filter(tracing_subscriber::EnvFilter::from_default_env())
        .init();

    match Args::parse().command {
        Command::Run { listen, config } => {
            let config_path = config.unwrap_or_else(macos_system_config_path);
            let pairing_notifier = MacGuiPairingNotifier::from_config_path(&config_path);
            run_system_server(
                listen,
                config_path,
                Arc::new(MacFileService::default()),
                None,
                Some(Arc::new(MacProcessResourcesInUseService)),
                Some(Arc::new(MacProcessSocketsInUseService)),
                Some(Arc::new(MacProcessModulesService)),
                Some(Arc::new(pairing_notifier)),
                None,
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

#[cfg(not(target_os = "macos"))]
fn main() -> Result<()> {
    anyhow::bail!("macOS system daemon is only available on macOS")
}

#[cfg(target_os = "macos")]
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
