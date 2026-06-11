use std::future::Future;
use std::pin::Pin;
use std::sync::Arc;

use anyhow::{Context, Result};
#[cfg(windows)]
use tokio::io::{AsyncReadExt, AsyncWriteExt};
#[cfg(windows)]
use tokio::net::windows::named_pipe::{ClientOptions, ServerOptions};
use wgo_daemon_host::server::{PairingCodeNotification, PairingNotifier};

pub const USER_PIPE_NAME: &str = r"\\.\pipe\wgo-user-active";
const PAIRING_NOTIFICATION_VERSION: &str = "pairing.v1";

#[derive(Debug, Clone)]
pub struct UserDaemonRegistration {
    pub pipe_name: String,
    pub user_name: String,
    pub session_id: u32,
}

impl UserDaemonRegistration {
    pub fn active_user(user_name: impl Into<String>) -> Self {
        Self {
            pipe_name: USER_PIPE_NAME.to_string(),
            user_name: user_name.into(),
            session_id: 0,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PairingNotification {
    pub daemon_url: String,
    pub pairing_code: String,
    pub expires_in_seconds: i64,
}

#[derive(Debug, Clone, Copy, Default)]
pub struct UserTrayPairingNotifier;

impl PairingNotifier for UserTrayPairingNotifier {
    fn notify_pairing_code(
        &self,
        notification: PairingCodeNotification,
    ) -> Pin<Box<dyn Future<Output = Result<()>> + Send + '_>> {
        Box::pin(async move { send_pairing_notification(notification).await })
    }
}

#[cfg(windows)]
async fn send_pairing_notification(notification: PairingCodeNotification) -> Result<()> {
    let mut client = ClientOptions::new()
        .open(USER_PIPE_NAME)
        .with_context(|| format!("open user daemon pipe {USER_PIPE_NAME}"))?;
    client
        .write_all(encode_pairing_notification(&notification).as_bytes())
        .await
        .context("write pairing notification to user daemon pipe")?;
    client
        .shutdown()
        .await
        .context("finish pairing notification pipe write")?;
    Ok(())
}

#[cfg(not(windows))]
async fn send_pairing_notification(_notification: PairingCodeNotification) -> Result<()> {
    anyhow::bail!("Windows user tray pairing notification is only available on Windows");
}

#[cfg(windows)]
pub fn spawn_pairing_notification_server(
    handler: impl Fn(PairingNotification) + Send + Sync + 'static,
) {
    let handler = Arc::new(handler);
    std::thread::spawn(move || {
        let runtime = match tokio::runtime::Builder::new_current_thread()
            .enable_io()
            .build()
        {
            Ok(runtime) => runtime,
            Err(err) => {
                tracing::warn!(?err, "failed to create pairing notification runtime");
                return;
            }
        };
        if let Err(err) = runtime.block_on(run_pairing_notification_server(handler)) {
            tracing::warn!(?err, "pairing notification pipe server stopped");
        }
    });
}

#[cfg(not(windows))]
pub fn spawn_pairing_notification_server(
    _handler: impl Fn(PairingNotification) + Send + Sync + 'static,
) {
}

#[cfg(windows)]
async fn run_pairing_notification_server(
    handler: Arc<dyn Fn(PairingNotification) + Send + Sync>,
) -> std::io::Result<()> {
    let mut server = ServerOptions::new()
        .first_pipe_instance(true)
        .create(USER_PIPE_NAME)?;
    loop {
        server.connect().await?;
        let connected = server;
        server = ServerOptions::new().create(USER_PIPE_NAME)?;
        let handler = handler.clone();
        tokio::spawn(async move {
            let mut pipe = connected;
            let mut bytes = Vec::new();
            if let Err(err) = pipe.read_to_end(&mut bytes).await {
                tracing::warn!(?err, "failed to read pairing notification pipe");
                return;
            }
            let text = match String::from_utf8(bytes) {
                Ok(text) => text,
                Err(err) => {
                    tracing::warn!(?err, "pairing notification pipe payload is not UTF-8");
                    return;
                }
            };
            let Some(notification) = decode_pairing_notification(&text) else {
                tracing::warn!("pairing notification pipe payload is malformed");
                return;
            };
            std::thread::spawn(move || handler(notification));
        });
    }
}

fn encode_pairing_notification(notification: &PairingCodeNotification) -> String {
    format!(
        "{PAIRING_NOTIFICATION_VERSION}\n{}\n{}\n{}\n",
        notification.daemon_url, notification.pairing_code, notification.expires_in_seconds
    )
}

fn decode_pairing_notification(text: &str) -> Option<PairingNotification> {
    let mut lines = text.lines();
    if lines.next()? != PAIRING_NOTIFICATION_VERSION {
        return None;
    }
    let daemon_url = lines.next()?.to_string();
    let pairing_code = lines.next()?.to_string();
    let expires_in_seconds = lines.next()?.parse().ok()?;
    Some(PairingNotification {
        daemon_url,
        pairing_code,
        expires_in_seconds,
    })
}
