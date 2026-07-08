use std::future::Future;
use std::pin::Pin;
use std::sync::Arc;
use std::time::Duration;

use anyhow::{anyhow, bail, Context, Result};
use rieul_daemon_core::rpc::WindowDetail;
use rieul_daemon_core::traits::{BoxFutureResult, ServiceError, WindowService};
pub use rieul_daemon_host::server::PairingConfirmationRequest;
use rieul_daemon_host::server::{PairingCodeNotification, PairingNotifier};
#[cfg(windows)]
use tokio::io::{AsyncReadExt, AsyncWriteExt};
#[cfg(windows)]
use tokio::net::windows::named_pipe::{
    ClientOptions, NamedPipeClient, NamedPipeServer, ServerOptions,
};

pub const GUI_PIPE_NAME: &str = r"\\.\pipe\rieul-gui-active";
pub const USER_PIPE_NAME: &str = r"\\.\pipe\rieul-user-active";
const PAIRING_IPC_VERSION: &str = "pairing.v2";
const WINDOW_IPC_VERSION: &str = "windows.v1";
#[cfg(windows)]
const PAIRING_IPC_MAX_BYTES: usize = 4096;
#[cfg(windows)]
const WINDOW_IPC_MAX_BYTES: usize = 16 * 1024 * 1024;
#[cfg(windows)]
const WINDOW_IPC_MAX_INSTANCES: usize = 32;
#[cfg(windows)]
const WINDOW_IPC_BUSY_RETRY_DELAY: Duration = Duration::from_millis(25);
#[cfg(windows)]
const WINDOW_IPC_BUSY_RETRY_COUNT: usize = 80;
#[cfg(windows)]
const ERROR_PIPE_BUSY: i32 = 231;

#[derive(Debug, Clone)]
pub struct UserDaemonRegistration {
    pub pipe_name: String,
    pub user_name: String,
    pub session_id: u32,
}

impl UserDaemonRegistration {
    pub fn active_user(user_name: impl Into<String>) -> Self {
        Self {
            pipe_name: GUI_PIPE_NAME.to_string(),
            user_name: user_name.into(),
            session_id: 0,
        }
    }
}

pub type PairingNotification = PairingCodeNotification;

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum PairingIpcRequest {
    Confirm(PairingConfirmationRequest),
    ShowCode(PairingNotification),
}

#[derive(Debug, Clone, Copy, Default)]
pub struct UserTrayPairingNotifier;

impl PairingNotifier for UserTrayPairingNotifier {
    fn confirm_pairing_request(
        &self,
        request: PairingConfirmationRequest,
    ) -> Pin<Box<dyn Future<Output = Result<()>> + Send + '_>> {
        Box::pin(async move { send_pairing_ipc_request(PairingIpcRequest::Confirm(request)).await })
    }

    fn notify_pairing_code(
        &self,
        notification: PairingCodeNotification,
    ) -> Pin<Box<dyn Future<Output = Result<()>> + Send + '_>> {
        Box::pin(async move {
            send_pairing_ipc_request(PairingIpcRequest::ShowCode(notification)).await
        })
    }
}

#[cfg(windows)]
async fn send_pairing_ipc_request(request: PairingIpcRequest) -> Result<()> {
    let mut client = ClientOptions::new()
        .open(GUI_PIPE_NAME)
        .with_context(|| format!("open gui daemon pipe {GUI_PIPE_NAME}"))?;
    client
        .write_all(encode_pairing_ipc_request(&request).as_bytes())
        .await
        .context("write pairing request to gui daemon pipe")?;
    client
        .flush()
        .await
        .context("flush pairing request to user daemon pipe")?;

    read_pairing_ipc_response(&mut client).await
}

#[cfg(not(windows))]
async fn send_pairing_ipc_request(_request: PairingIpcRequest) -> Result<()> {
    anyhow::bail!("Windows user tray pairing notification is only available on Windows");
}

#[cfg(windows)]
pub fn spawn_pairing_notification_server(
    handler: impl Fn(PairingIpcRequest) -> Result<()> + Send + Sync + 'static,
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
    _handler: impl Fn(PairingIpcRequest) -> Result<()> + Send + Sync + 'static,
) {
}

#[cfg(windows)]
async fn run_pairing_notification_server(
    handler: Arc<dyn Fn(PairingIpcRequest) -> Result<()> + Send + Sync>,
) -> std::io::Result<()> {
    let mut server = ServerOptions::new()
        .first_pipe_instance(true)
        .create(GUI_PIPE_NAME)?;
    loop {
        server.connect().await?;
        let connected = server;
        server = ServerOptions::new().create(GUI_PIPE_NAME)?;
        let handler = handler.clone();
        tokio::spawn(async move {
            let mut pipe = connected;
            let request = match read_pairing_ipc_request(&mut pipe).await {
                Ok(request) => request,
                Err(err) => {
                    tracing::warn!(?err, "failed to read pairing notification pipe request");
                    return;
                }
            };
            let response = match tokio::task::spawn_blocking(move || handler(request)).await {
                Ok(Ok(())) => encode_pairing_ipc_ok_response(),
                Ok(Err(err)) => encode_pairing_ipc_error_response(&err.to_string()),
                Err(err) => encode_pairing_ipc_error_response(&err.to_string()),
            };
            if let Err(err) = pipe.write_all(response.as_bytes()).await {
                tracing::warn!(?err, "failed to write pairing notification pipe response");
                return;
            }
            if let Err(err) = pipe.shutdown().await {
                tracing::warn!(?err, "failed to finish pairing notification pipe response");
            }
        });
    }
}

#[derive(Debug, Clone, Copy, Default)]
pub struct UserSessionWindowService;

impl WindowService for UserSessionWindowService {
    fn windows(&self) -> BoxFutureResult<'_, Vec<WindowDetail>> {
        Box::pin(async { send_window_snapshot_request().await })
    }
}

#[cfg(windows)]
async fn send_window_snapshot_request() -> Result<Vec<WindowDetail>, ServiceError> {
    let mut client = open_window_snapshot_pipe().await?;
    client
        .write_all(format!("{WINDOW_IPC_VERSION}\nsnapshot\n").as_bytes())
        .await
        .map_err(|err| ServiceError::OperationFailed(err.to_string()))?;
    client
        .flush()
        .await
        .map_err(|err| ServiceError::OperationFailed(err.to_string()))?;
    read_window_ipc_response(&mut client).await
}

#[cfg(windows)]
async fn open_window_snapshot_pipe() -> Result<NamedPipeClient, ServiceError> {
    for attempt in 0..=WINDOW_IPC_BUSY_RETRY_COUNT {
        match ClientOptions::new().open(USER_PIPE_NAME) {
            Ok(client) => return Ok(client),
            Err(err)
                if err.raw_os_error() == Some(ERROR_PIPE_BUSY)
                    && attempt < WINDOW_IPC_BUSY_RETRY_COUNT =>
            {
                tokio::time::sleep(WINDOW_IPC_BUSY_RETRY_DELAY).await;
            }
            Err(err) => return Err(ServiceError::OperationFailed(err.to_string())),
        }
    }
    Err(ServiceError::OperationFailed(format!(
        "window snapshot pipe stayed busy: {USER_PIPE_NAME}"
    )))
}

#[cfg(not(windows))]
async fn send_window_snapshot_request() -> Result<Vec<WindowDetail>, ServiceError> {
    Err(ServiceError::Unsupported)
}

#[cfg(windows)]
pub async fn run_window_snapshot_server() -> Result<()> {
    let mut server = ServerOptions::new()
        .first_pipe_instance(true)
        .max_instances(WINDOW_IPC_MAX_INSTANCES)
        .create(USER_PIPE_NAME)
        .with_context(|| format!("create user window pipe {USER_PIPE_NAME}"))?;
    loop {
        server.connect().await?;
        let connected = server;
        server = ServerOptions::new()
            .max_instances(WINDOW_IPC_MAX_INSTANCES)
            .create(USER_PIPE_NAME)
            .with_context(|| format!("create user window pipe {USER_PIPE_NAME}"))?;
        tokio::spawn(async move {
            let mut pipe = connected;
            let response = match read_window_ipc_request(&mut pipe).await {
                Ok(()) => match tokio::task::spawn_blocking(crate::windows::snapshot).await {
                    Ok(Ok(details)) => encode_window_ipc_ok_response(&details),
                    Ok(Err(err)) => encode_window_ipc_error_response(&err.to_string()),
                    Err(err) => encode_window_ipc_error_response(&err.to_string()),
                },
                Err(err) => encode_window_ipc_error_response(&err.to_string()),
            };
            if let Err(err) = pipe.write_all(response.as_bytes()).await {
                tracing::warn!(?err, "failed to write window snapshot pipe response");
                return;
            }
            if let Err(err) = pipe.shutdown().await {
                tracing::warn!(?err, "failed to finish window snapshot pipe response");
            }
        });
    }
}

#[cfg(not(windows))]
pub async fn run_window_snapshot_server() -> Result<()> {
    bail!("Windows user window snapshot server is only available on Windows");
}

#[cfg(windows)]
async fn read_window_ipc_request(pipe: &mut NamedPipeServer) -> Result<()> {
    let mut bytes = Vec::new();
    let mut buffer = [0; 256];
    loop {
        let count = pipe
            .read(&mut buffer)
            .await
            .context("read window snapshot request from user daemon pipe")?;
        if count == 0 {
            bail!("window snapshot pipe closed before a complete request was received");
        }
        bytes.extend_from_slice(&buffer[..count]);
        if bytes.len() > WINDOW_IPC_MAX_BYTES {
            bail!("window snapshot request exceeds {WINDOW_IPC_MAX_BYTES} bytes");
        }
        let text = std::str::from_utf8(&bytes).context("window snapshot request is not UTF-8")?;
        if !text.ends_with('\n') {
            continue;
        }
        let mut lines = text.lines();
        if lines.next() != Some(WINDOW_IPC_VERSION) || lines.next() != Some("snapshot") {
            bail!("window snapshot request is malformed");
        }
        return Ok(());
    }
}

#[cfg(windows)]
async fn read_window_ipc_response(
    client: &mut NamedPipeClient,
) -> Result<Vec<WindowDetail>, ServiceError> {
    let mut bytes = Vec::new();
    let mut buffer = [0; 8192];
    loop {
        let count = client
            .read(&mut buffer)
            .await
            .map_err(|err| ServiceError::OperationFailed(err.to_string()))?;
        if count == 0 {
            return Err(ServiceError::OperationFailed(
                "window snapshot response pipe closed before a complete response was received"
                    .to_string(),
            ));
        }
        bytes.extend_from_slice(&buffer[..count]);
        if bytes.len() > WINDOW_IPC_MAX_BYTES {
            return Err(ServiceError::OperationFailed(format!(
                "window snapshot response exceeds {WINDOW_IPC_MAX_BYTES} bytes"
            )));
        }
        let text = std::str::from_utf8(&bytes)
            .map_err(|err| ServiceError::OperationFailed(err.to_string()))?;
        if let Some(response) = decode_window_ipc_response(text) {
            return response;
        }
    }
}

fn encode_window_ipc_ok_response(details: &[WindowDetail]) -> String {
    let mut text = format!("{WINDOW_IPC_VERSION}\nok\n{}\n", details.len());
    for detail in details {
        text.push_str(&hex_encode(&detail.encode()));
        text.push('\n');
    }
    text
}

fn encode_window_ipc_error_response(message: &str) -> String {
    format!(
        "{WINDOW_IPC_VERSION}\nerror\n{}\n",
        message.replace('\n', " ")
    )
}

fn decode_window_ipc_response(text: &str) -> Option<Result<Vec<WindowDetail>, ServiceError>> {
    if !text.ends_with('\n') {
        return None;
    }
    let mut lines = text.lines();
    if lines.next() != Some(WINDOW_IPC_VERSION) {
        return Some(Err(ServiceError::OperationFailed(
            "window snapshot response has an unknown version".to_string(),
        )));
    }
    match lines.next()? {
        "ok" => {
            let count = match lines.next().and_then(|line| line.parse::<usize>().ok()) {
                Some(count) => count,
                None => {
                    return Some(Err(ServiceError::OperationFailed(
                        "window snapshot response is malformed".to_string(),
                    )));
                }
            };
            let payloads = lines.by_ref().take(count).collect::<Vec<_>>();
            if payloads.len() != count {
                return None;
            }
            Some(
                payloads
                    .into_iter()
                    .map(|line| {
                        let bytes = hex_decode(line)?;
                        WindowDetail::decode(&bytes)
                            .map_err(|err| ServiceError::OperationFailed(err.to_string()))
                    })
                    .collect(),
            )
        }
        "error" => Some(Err(ServiceError::OperationFailed(
            lines
                .next()
                .unwrap_or("window snapshot request was rejected")
                .to_string(),
        ))),
        _ => Some(Err(ServiceError::OperationFailed(
            "window snapshot response is malformed".to_string(),
        ))),
    }
}

fn hex_encode(bytes: &[u8]) -> String {
    const DIGITS: &[u8; 16] = b"0123456789abcdef";
    let mut text = String::with_capacity(bytes.len() * 2);
    for byte in bytes {
        text.push(DIGITS[(byte >> 4) as usize] as char);
        text.push(DIGITS[(byte & 0x0f) as usize] as char);
    }
    text
}

fn hex_decode(text: &str) -> Result<Vec<u8>, ServiceError> {
    if text.len() % 2 != 0 {
        return Err(ServiceError::OperationFailed(
            "hex payload has odd length".to_string(),
        ));
    }
    let mut bytes = Vec::with_capacity(text.len() / 2);
    let raw = text.as_bytes();
    for index in (0..raw.len()).step_by(2) {
        let high = hex_nibble(raw[index])?;
        let low = hex_nibble(raw[index + 1])?;
        bytes.push((high << 4) | low);
    }
    Ok(bytes)
}

fn hex_nibble(byte: u8) -> Result<u8, ServiceError> {
    match byte {
        b'0'..=b'9' => Ok(byte - b'0'),
        b'a'..=b'f' => Ok(byte - b'a' + 10),
        b'A'..=b'F' => Ok(byte - b'A' + 10),
        _ => Err(ServiceError::OperationFailed(
            "hex payload contains a non-hex byte".to_string(),
        )),
    }
}

#[cfg(windows)]
async fn read_pairing_ipc_request(pipe: &mut NamedPipeServer) -> Result<PairingIpcRequest> {
    let mut bytes = Vec::new();
    let mut buffer = [0; 256];
    loop {
        let count = pipe
            .read(&mut buffer)
            .await
            .context("read pairing request from user daemon pipe")?;
        if count == 0 {
            bail!("pairing request pipe closed before a complete request was received");
        }
        bytes.extend_from_slice(&buffer[..count]);
        if bytes.len() > PAIRING_IPC_MAX_BYTES {
            bail!("pairing request exceeds {PAIRING_IPC_MAX_BYTES} bytes");
        }
        let text = std::str::from_utf8(&bytes).context("pairing request is not UTF-8")?;
        if let Some(request) = decode_pairing_ipc_request(text) {
            return Ok(request);
        }
    }
}

#[cfg(windows)]
async fn read_pairing_ipc_response(client: &mut NamedPipeClient) -> Result<()> {
    let mut bytes = Vec::new();
    let mut buffer = [0; 256];
    loop {
        let count = client
            .read(&mut buffer)
            .await
            .context("read pairing response from user daemon pipe")?;
        if count == 0 {
            bail!("pairing response pipe closed before a complete response was received");
        }
        bytes.extend_from_slice(&buffer[..count]);
        if bytes.len() > PAIRING_IPC_MAX_BYTES {
            bail!("pairing response exceeds {PAIRING_IPC_MAX_BYTES} bytes");
        }
        let text = std::str::from_utf8(&bytes).context("pairing response is not UTF-8")?;
        if let Some(response) = decode_pairing_ipc_response(text) {
            return response;
        }
    }
}

fn encode_pairing_ipc_request(request: &PairingIpcRequest) -> String {
    match request {
        PairingIpcRequest::Confirm(request) => {
            format!(
                "{PAIRING_IPC_VERSION}\nconfirm\n{}\n{}\n{}\n",
                ipc_line(&request.daemon_url),
                ipc_line(&request.confirmation_code),
                ipc_line(&request.client_label)
            )
        }
        PairingIpcRequest::ShowCode(notification) => {
            format!(
                "{PAIRING_IPC_VERSION}\ncode\n{}\n{}\n{}\n",
                ipc_line(&notification.daemon_url),
                ipc_line(&notification.pairing_code),
                notification.expires_in_seconds
            )
        }
    }
}

fn ipc_line(value: &str) -> String {
    value.replace(['\r', '\n'], " ")
}

fn decode_pairing_ipc_request(text: &str) -> Option<PairingIpcRequest> {
    if !text.ends_with('\n') {
        return None;
    }
    let mut lines = text.lines();
    if lines.next()? != PAIRING_IPC_VERSION {
        return None;
    }
    match lines.next()? {
        "confirm" => Some(PairingIpcRequest::Confirm(PairingConfirmationRequest {
            daemon_url: lines.next()?.to_string(),
            confirmation_code: lines.next()?.to_string(),
            client_label: lines.next()?.to_string(),
        })),
        "code" => Some(PairingIpcRequest::ShowCode(PairingNotification {
            daemon_url: lines.next()?.to_string(),
            pairing_code: lines.next()?.to_string(),
            expires_in_seconds: lines.next()?.parse().ok()?,
        })),
        _ => None,
    }
}

fn encode_pairing_ipc_ok_response() -> String {
    format!("{PAIRING_IPC_VERSION}\nok\n")
}

fn encode_pairing_ipc_error_response(message: &str) -> String {
    format!(
        "{PAIRING_IPC_VERSION}\nerror\n{}\n",
        message.replace('\n', " ")
    )
}

fn decode_pairing_ipc_response(text: &str) -> Option<Result<()>> {
    if !text.ends_with('\n') {
        return None;
    }
    let mut lines = text.lines();
    if lines.next() != Some(PAIRING_IPC_VERSION) {
        return Some(Err(anyhow!("pairing response has an unknown version")));
    }
    match lines.next()? {
        "ok" => Some(Ok(())),
        "error" => Some(Err(anyhow!(lines
            .next()
            .unwrap_or("pairing request was rejected")
            .to_string()))),
        _ => Some(Err(anyhow!("pairing response is malformed"))),
    }
}
