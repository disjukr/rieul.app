use std::future::Future;
use std::path::Path;
use std::pin::Pin;
use std::time::Duration;

use anyhow::{anyhow, bail, Context, Result};
use rieul_daemon_core::config::{profile_id_for_config_path, windows_program_data_config_path};
use rieul_daemon_core::ipc::{
    ConfirmPairingReq, ConfirmPairingRes, IpcProcError, ProcId, ShowPairingCodeReq,
    SnapshotWindowsRes,
};
use rieul_daemon_core::rpc::WindowDetail;
use rieul_daemon_core::socket_wire::{SocketReqResMessage, MAX_SOCKET_WIRE_SEQUENCE_SIZE};
use rieul_daemon_core::traits::{BoxFutureResult, ServiceError, WindowService};
pub use rieul_daemon_host::server::PairingConfirmationRequest;
use rieul_daemon_host::server::{PairingCodeNotification, PairingNotifier};
#[cfg(windows)]
use tokio::io::{AsyncRead, AsyncReadExt, AsyncWrite, AsyncWriteExt};
#[cfg(windows)]
use tokio::net::windows::named_pipe::{ClientOptions, NamedPipeClient};

#[cfg(windows)]
const IPC_MAX_BYTES: usize = MAX_SOCKET_WIRE_SEQUENCE_SIZE;
#[cfg(windows)]
const WINDOW_IPC_BUSY_RETRY_DELAY: Duration = Duration::from_millis(25);
#[cfg(windows)]
const WINDOW_IPC_BUSY_RETRY_COUNT: usize = 80;
#[cfg(windows)]
const ERROR_PIPE_BUSY: i32 = 231;
const DEFAULT_STREAM_ID: u64 = 1;

#[derive(Debug, Clone)]
pub struct UserDaemonRegistration {
    pub pipe_name: String,
    pub user_name: String,
    pub session_id: u32,
}

impl UserDaemonRegistration {
    pub fn active_user(user_name: impl Into<String>) -> Self {
        Self::active_user_for_profile(default_profile_id(), user_name)
    }

    pub fn active_user_for_profile(
        profile_id: impl Into<String>,
        user_name: impl Into<String>,
    ) -> Self {
        let profile_id = profile_id.into();
        Self {
            pipe_name: gui_pipe_name(&profile_id),
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
    Completed,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct UserGuiPairingNotifier {
    profile_id: String,
}

impl Default for UserGuiPairingNotifier {
    fn default() -> Self {
        Self::from_config_path(windows_program_data_config_path())
    }
}

impl UserGuiPairingNotifier {
    pub fn from_config_path(config_path: impl AsRef<Path>) -> Self {
        Self {
            profile_id: profile_id_for_config_path(config_path),
        }
    }
}

impl PairingNotifier for UserGuiPairingNotifier {
    fn confirm_pairing_request(
        &self,
        request: PairingConfirmationRequest,
    ) -> Pin<Box<dyn Future<Output = Result<()>> + Send + '_>> {
        let profile_id = self.profile_id.clone();
        Box::pin(async move {
            send_pairing_ipc_request(&profile_id, PairingIpcRequest::Confirm(request)).await
        })
    }

    fn notify_pairing_code(
        &self,
        notification: PairingCodeNotification,
    ) -> Pin<Box<dyn Future<Output = Result<()>> + Send + '_>> {
        let profile_id = self.profile_id.clone();
        Box::pin(async move {
            send_pairing_ipc_request(&profile_id, PairingIpcRequest::ShowCode(notification)).await
        })
    }

    fn notify_pairing_completed(&self) -> Pin<Box<dyn Future<Output = Result<()>> + Send + '_>> {
        let profile_id = self.profile_id.clone();
        Box::pin(async move {
            send_pairing_ipc_request(&profile_id, PairingIpcRequest::Completed).await
        })
    }
}

#[cfg(windows)]
async fn send_pairing_ipc_request(profile_id: &str, request: PairingIpcRequest) -> Result<()> {
    let (proc_id, payload) = encode_pairing_ipc_request(&request);
    let mut client = open_gui_pipe(profile_id).await?;
    let response = call_ipc_unary(&mut client, proc_id.as_u64(), payload).await?;

    match request {
        PairingIpcRequest::Confirm(_) => {
            let payload =
                response.ok_or_else(|| anyhow!("ConfirmPairing response is missing payload"))?;
            let response = ConfirmPairingRes::decode(&payload)
                .map_err(|err| anyhow!("ConfirmPairing response is malformed: {err}"))?;
            if response.accepted {
                Ok(())
            } else {
                Err(anyhow!("pairing confirmation was rejected"))
            }
        }
        PairingIpcRequest::ShowCode(_) | PairingIpcRequest::Completed => Ok(()),
    }
}

#[cfg(not(windows))]
async fn send_pairing_ipc_request(_profile_id: &str, _request: PairingIpcRequest) -> Result<()> {
    anyhow::bail!("Windows GUI pairing notification is only available on Windows");
}

#[cfg(windows)]
fn encode_pairing_ipc_request(request: &PairingIpcRequest) -> (ProcId, Option<Vec<u8>>) {
    match request {
        PairingIpcRequest::Confirm(request) => (
            ProcId::ConfirmPairing,
            Some(
                ConfirmPairingReq {
                    daemon_url: request.daemon_url.clone(),
                    confirmation_code: request.confirmation_code.clone(),
                    client_label: request.client_label.clone(),
                }
                .encode(),
            ),
        ),
        PairingIpcRequest::ShowCode(notification) => (
            ProcId::ShowPairingCode,
            Some(
                ShowPairingCodeReq {
                    daemon_url: notification.daemon_url.clone(),
                    pairing_code: notification.pairing_code.clone(),
                    expires_in_seconds: u64::try_from(notification.expires_in_seconds).unwrap_or(0),
                }
                .encode(),
            ),
        ),
        PairingIpcRequest::Completed => (ProcId::PairingCompleted, None),
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct UserSessionWindowService {
    profile_id: String,
}

impl Default for UserSessionWindowService {
    fn default() -> Self {
        Self::from_config_path(windows_program_data_config_path())
    }
}

impl UserSessionWindowService {
    pub fn from_config_path(config_path: impl AsRef<Path>) -> Self {
        Self {
            profile_id: profile_id_for_config_path(config_path),
        }
    }
}

impl WindowService for UserSessionWindowService {
    fn windows(&self) -> BoxFutureResult<'_, Vec<WindowDetail>> {
        let profile_id = self.profile_id.clone();
        Box::pin(async move { send_window_snapshot_request(&profile_id).await })
    }
}

#[cfg(windows)]
async fn send_window_snapshot_request(profile_id: &str) -> Result<Vec<WindowDetail>, ServiceError> {
    let mut client = open_window_snapshot_pipe(profile_id).await?;
    let payload = call_ipc_unary(&mut client, ProcId::SnapshotWindows.as_u64(), None)
        .await
        .map_err(|err| ServiceError::OperationFailed(err.to_string()))?
        .ok_or_else(|| {
            ServiceError::OperationFailed("SnapshotWindows response is missing payload".to_string())
        })?;
    let response = SnapshotWindowsRes::decode(&payload)
        .map_err(|err| ServiceError::OperationFailed(err.to_string()))?;
    Ok(response.windows.into_iter().map(Into::into).collect())
}

#[cfg(windows)]
async fn open_window_snapshot_pipe(profile_id: &str) -> Result<NamedPipeClient, ServiceError> {
    let session_id = crate::terminal_ipc::active_console_session_id()
        .map_err(|err| ServiceError::OperationFailed(err.to_string()))?;
    let pipe_name = crate::terminal_ipc::user_pipe_name(profile_id, session_id);
    for attempt in 0..=WINDOW_IPC_BUSY_RETRY_COUNT {
        match ClientOptions::new().open(&pipe_name) {
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
        "window snapshot pipe stayed busy: {pipe_name}"
    )))
}

#[cfg(not(windows))]
async fn send_window_snapshot_request(
    _profile_id: &str,
) -> Result<Vec<WindowDetail>, ServiceError> {
    Err(ServiceError::Unsupported)
}

#[cfg(windows)]
pub async fn run_user_ipc_server(profile_id: impl Into<String>) -> Result<()> {
    let profile_id = profile_id.into();
    let shell_integration_dir = std::env::var_os("LOCALAPPDATA")
        .map(std::path::PathBuf::from)
        .unwrap_or_else(std::env::temp_dir)
        .join("Rieul")
        .join(&profile_id)
        .join("shell-integration");
    crate::terminal_ipc::run_user_ipc_server(profile_id, shell_integration_dir).await
}

#[cfg(not(windows))]
pub async fn run_user_ipc_server(_profile_id: impl Into<String>) -> Result<()> {
    bail!("Windows user IPC server is only available on Windows");
}

pub fn default_profile_id() -> String {
    profile_id_for_config_path(windows_program_data_config_path())
}

pub fn gui_pipe_name(profile_id: &str) -> String {
    format!(r"\\.\pipe\rieul-gui-profile-{profile_id}")
}

#[cfg(windows)]
async fn open_gui_pipe(profile_id: &str) -> Result<NamedPipeClient> {
    let pipe_name = gui_pipe_name(profile_id);
    for attempt in 0..=WINDOW_IPC_BUSY_RETRY_COUNT {
        match ClientOptions::new().open(&pipe_name) {
            Ok(client) => return Ok(client),
            Err(err)
                if err.raw_os_error() == Some(ERROR_PIPE_BUSY)
                    && attempt < WINDOW_IPC_BUSY_RETRY_COUNT =>
            {
                tokio::time::sleep(WINDOW_IPC_BUSY_RETRY_DELAY).await;
            }
            Err(err) => {
                return Err(err).with_context(|| {
                    format!("connect GUI daemon pipe {pipe_name}; start the GUI process first")
                });
            }
        }
    }
    bail!("GUI daemon pipe stayed busy: {pipe_name}")
}

#[cfg(windows)]
async fn call_ipc_unary<T>(
    stream: &mut T,
    proc_id: u64,
    payload: Option<Vec<u8>>,
) -> Result<Option<Vec<u8>>>
where
    T: AsyncRead + AsyncWrite + Unpin,
{
    let stream_id = DEFAULT_STREAM_ID;
    let bytes = SocketReqResMessage::encode_sequence(&[
        SocketReqResMessage::RequestUnary {
            proc_id,
            payload,
            stream_id,
        },
        SocketReqResMessage::RequestStreamEnd { stream_id },
    ]);
    stream
        .write_all(&bytes)
        .await
        .context("write IPC request")?;
    stream.flush().await.context("flush IPC request")?;

    read_ipc_unary_response(stream, stream_id).await
}

#[cfg(windows)]
async fn read_ipc_unary_response<R>(
    reader: &mut R,
    expected_stream_id: u64,
) -> Result<Option<Vec<u8>>>
where
    R: AsyncRead + Unpin,
{
    let mut messages = SocketWireMessageReader::new(IPC_MAX_BYTES);
    let mut response: Option<Result<Option<Vec<u8>>>> = None;
    loop {
        let message = messages.read_next(reader).await?;
        if message.stream_id() != expected_stream_id {
            bail!("IPC response stream id mismatch");
        }
        match message {
            SocketReqResMessage::ResponseUnaryOk { payload, .. } => {
                response = Some(Ok(payload));
            }
            SocketReqResMessage::ResponseUnaryError { error, .. } => {
                let message = IpcProcError::decode(&error)
                    .map(|error| error.message().to_string())
                    .unwrap_or_else(|err| {
                        format!("IPC request failed with malformed error: {err}")
                    });
                response = Some(Err(anyhow!(message)));
            }
            SocketReqResMessage::ResponseStreamEnd { .. } => {
                return response.ok_or_else(|| anyhow!("IPC stream ended before response"))?;
            }
            other => bail!("unexpected IPC response message {other:?}"),
        }
    }
}

#[cfg(windows)]
struct SocketWireMessageReader {
    bytes: Vec<u8>,
    max_bytes: usize,
}

#[cfg(windows)]
impl SocketWireMessageReader {
    fn new(max_bytes: usize) -> Self {
        Self {
            bytes: Vec::new(),
            max_bytes,
        }
    }

    async fn read_next<R>(&mut self, reader: &mut R) -> Result<SocketReqResMessage>
    where
        R: AsyncRead + Unpin,
    {
        let mut buffer = [0; 8192];
        loop {
            if let Some((message, used)) = SocketReqResMessage::decode_prefix(&self.bytes)
                .map_err(|err| anyhow!("decode IPC socket-wire message: {err}"))?
            {
                self.bytes.drain(..used);
                return Ok(message);
            }

            let count = reader.read(&mut buffer).await.context("read IPC stream")?;
            if count == 0 {
                bail!("IPC stream closed before a complete socket-wire message was received");
            }
            self.bytes.extend_from_slice(&buffer[..count]);
            if self.bytes.len() > self.max_bytes {
                bail!("IPC stream exceeds {} bytes", self.max_bytes);
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn pipe_names_are_profile_scoped() {
        assert_eq!(
            gui_pipe_name("abc123"),
            r"\\.\pipe\rieul-gui-profile-abc123"
        );
        assert_eq!(
            crate::terminal_ipc::user_pipe_name("abc123", 7),
            r"\\.\pipe\rieul-user-profile-abc123-session-7"
        );
    }

    #[test]
    fn pairing_request_payload_uses_ipc_schema() {
        let (proc_id, payload) =
            encode_pairing_ipc_request(&PairingIpcRequest::ShowCode(PairingNotification {
                daemon_url: "https://localhost:9012".to_string(),
                pairing_code: "123456".to_string(),
                expires_in_seconds: 30,
            }));

        assert_eq!(proc_id, ProcId::ShowPairingCode);
        let payload = ShowPairingCodeReq::decode(&payload.unwrap()).unwrap();
        assert_eq!(payload.pairing_code, "123456");
    }

    #[test]
    fn pairing_completed_request_has_no_payload() {
        let (proc_id, payload) = encode_pairing_ipc_request(&PairingIpcRequest::Completed);

        assert_eq!(proc_id, ProcId::PairingCompleted);
        assert_eq!(payload, None);
    }
}
