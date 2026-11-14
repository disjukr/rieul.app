use std::net::SocketAddr;
use std::path::PathBuf;
#[cfg(target_os = "macos")]
use std::sync::Arc;

use anyhow::Result;
use clap::{Parser, Subcommand};
#[cfg(target_os = "macos")]
use rieul_daemon_core::config::{
    SystemConfig, client_credentials_path, load_or_generated_default, macos_system_config_path,
    save,
};
#[cfg(target_os = "macos")]
use rieul_daemon_host::server::run_system_server_with_readiness;
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
#[command(version = rieul_daemon_core::rpc::daemon_build_version())]
#[command(name = "rieul-macos-system")]
#[command(about = "macOS system daemon for rieul")]
struct Args {
    #[command(subcommand)]
    command: Command,
}

#[derive(Debug, Subcommand)]
enum Command {
    #[cfg(target_os = "macos")]
    #[command(hide = true)]
    InternalUpdateWorker,
    #[cfg(target_os = "macos")]
    #[command(hide = true)]
    LocalUpdate {
        #[arg(value_enum)]
        action: LocalUpdateAction,
    },
    #[cfg(target_os = "macos")]
    #[command(hide = true)]
    DesktopUser {
        #[arg(long)]
        config: Option<PathBuf>,
    },
    #[cfg(target_os = "macos")]
    #[command(hide = true)]
    MigrateUpdater,
    #[cfg(all(target_os = "macos", feature = "updater-device-repair"))]
    #[command(hide = true)]
    RepairPreparedDevice,
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

#[derive(Clone, Debug, clap::ValueEnum)]
enum LocalUpdateAction {
    ForceInstall,
    Subscribe,
    Check,
    Install,
    Restart,
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
        .with_writer(std::io::stderr)
        .with_env_filter(tracing_subscriber::EnvFilter::from_default_env())
        .init();

    match Args::parse().command {
        Command::LocalUpdate { action } => {
            use rieul_daemon_core::local_update::Operation;
            let operation = match action {
                LocalUpdateAction::Subscribe => Operation::Subscribe,
                LocalUpdateAction::Check => Operation::Check,
                LocalUpdateAction::Install => Operation::Install,
                LocalUpdateAction::ForceInstall => Operation::ForceInstall,
                LocalUpdateAction::Restart => Operation::Restart,
            };
            rieul_macos_daemon::local_update::helper(operation).await
        }
        Command::DesktopUser { config } => {
            rieul_macos_daemon::desktop_ipc::run(&config.unwrap_or_else(macos_system_config_path))
                .await
        }
        Command::MigrateUpdater => rieul_macos_daemon::root_update::prepare_migration(),
        #[cfg(feature = "updater-device-repair")]
        Command::RepairPreparedDevice => rieul_macos_daemon::root_update::repair_prepared_device(),
        Command::InternalUpdateWorker => rieul_macos_daemon::root_update::run_worker(),
        Command::Run { listen, config } => {
            let config_path = config.unwrap_or_else(macos_system_config_path);
            if config_path == macos_system_config_path()
                && listen.is_none()
                && rieul_macos_daemon::root_update::service_startup()?
            {
                std::future::pending::<()>().await;
            }
            let pairing_notifier = MacGuiPairingNotifier::from_config_path(&config_path);
            let ready = if config_path == macos_system_config_path() && listen.is_none() {
                rieul_macos_daemon::root_update::startup_callback()?
            } else {
                None
            };
            let desktop_backend = rieul_macos_daemon::desktop_ipc::proxy(&config_path);
            let updates = rieul_macos_daemon::root_update::update_service()?;
            let local_ready = Arc::new(std::sync::atomic::AtomicBool::new(false));
            let _local_updates = match &updates {
                Some(updater) => Some(
                    rieul_macos_daemon::local_update::start(updater.clone(), local_ready.clone())
                        .await?,
                ),
                None => None,
            };
            let ready: Option<Arc<dyn Fn() -> Result<()> + Send + Sync>> =
                Some(Arc::new(move || {
                    if let Some(callback) = &ready {
                        callback()?;
                    }
                    local_ready.store(true, std::sync::atomic::Ordering::Release);
                    Ok(())
                }));
            run_system_server_with_readiness(
                listen,
                config_path,
                Arc::new(MacFileService::default()),
                None,
                Some(Arc::new(MacProcessResourcesInUseService)),
                Some(Arc::new(MacProcessSocketsInUseService)),
                Some(Arc::new(MacProcessModulesService)),
                Some(Arc::new(pairing_notifier)),
                None,
                Some(desktop_backend),
                "macOS system daemon",
                ready,
                rieul_macos_daemon::root_update::maintenance_hooks()?,
                updates,
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
