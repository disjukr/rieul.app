use std::future::Future;
use std::path::{Path, PathBuf};
use std::pin::Pin;

use anyhow::{anyhow, bail, Context, Result};
use rieul_daemon_core::config::{macos_system_config_path, profile_id_for_config_path};
use rieul_daemon_core::ipc::{
    ConfirmPairingReq, ConfirmPairingRes, IpcProcError, ProcId, ShowPairingCodeReq,
};
use rieul_daemon_core::socket_wire::{SocketReqResMessage, MAX_SOCKET_WIRE_SEQUENCE_SIZE};
pub use rieul_daemon_host::server::PairingConfirmationRequest;
use rieul_daemon_host::server::{PairingCodeNotification, PairingNotifier};
use tokio::io::{AsyncRead, AsyncReadExt, AsyncWrite, AsyncWriteExt};
use tokio::net::UnixStream;

const DEFAULT_STREAM_ID: u64 = 1;

#[derive(Debug, Clone, PartialEq, Eq)]
enum GuiIpcRequest {
    Confirm(PairingConfirmationRequest),
    ShowCode(PairingCodeNotification),
    Completed,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct MacGuiPairingNotifier {
    profile_id: String,
}

impl Default for MacGuiPairingNotifier {
    fn default() -> Self {
        Self::from_config_path(macos_system_config_path())
    }
}

impl MacGuiPairingNotifier {
    pub fn from_config_path(config_path: impl AsRef<Path>) -> Self {
        Self {
            profile_id: profile_id_for_config_path(config_path),
        }
    }
}

impl PairingNotifier for MacGuiPairingNotifier {
    fn confirm_pairing_request(
        &self,
        request: PairingConfirmationRequest,
    ) -> Pin<Box<dyn Future<Output = Result<()>> + Send + '_>> {
        let profile_id = self.profile_id.clone();
        Box::pin(
            async move { send_gui_ipc_request(&profile_id, GuiIpcRequest::Confirm(request)).await },
        )
    }

    fn notify_pairing_code(
        &self,
        notification: PairingCodeNotification,
    ) -> Pin<Box<dyn Future<Output = Result<()>> + Send + '_>> {
        let profile_id = self.profile_id.clone();
        Box::pin(async move {
            send_gui_ipc_request(&profile_id, GuiIpcRequest::ShowCode(notification)).await
        })
    }

    fn notify_pairing_completed(&self) -> Pin<Box<dyn Future<Output = Result<()>> + Send + '_>> {
        let profile_id = self.profile_id.clone();
        Box::pin(async move { send_gui_ipc_request(&profile_id, GuiIpcRequest::Completed).await })
    }
}

async fn send_gui_ipc_request(profile_id: &str, request: GuiIpcRequest) -> Result<()> {
    let socket_path = active_gui_socket_path(profile_id);
    let (proc_id, payload) = encode_gui_ipc_request(&request);
    let mut stream = UnixStream::connect(&socket_path)
        .await
        .with_context(|| format!("connect GUI socket {}", socket_path.display()))?;
    let response = call_ipc_unary(&mut stream, proc_id.as_u64(), payload).await?;

    match request {
        GuiIpcRequest::Confirm(_) => {
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
        GuiIpcRequest::ShowCode(_) | GuiIpcRequest::Completed => Ok(()),
    }
}

fn encode_gui_ipc_request(request: &GuiIpcRequest) -> (ProcId, Option<Vec<u8>>) {
    match request {
        GuiIpcRequest::Confirm(request) => (
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
        GuiIpcRequest::ShowCode(notification) => (
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
        GuiIpcRequest::Completed => (ProcId::PairingCompleted, None),
    }
}

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

async fn read_ipc_unary_response<R>(
    reader: &mut R,
    expected_stream_id: u64,
) -> Result<Option<Vec<u8>>>
where
    R: AsyncRead + Unpin,
{
    let mut messages = SocketWireMessageReader::new(MAX_SOCKET_WIRE_SEQUENCE_SIZE);
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

struct SocketWireMessageReader {
    bytes: Vec<u8>,
    max_bytes: usize,
}

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

fn active_gui_socket_path(profile_id: &str) -> PathBuf {
    if let Some(uid) = std::env::var_os("SUDO_UID").filter(|uid| !uid.is_empty()) {
        return socket_path_for_uid(profile_id, uid.to_string_lossy());
    }
    #[cfg(target_os = "macos")]
    if let Some(uid) = console_user_uid() {
        return socket_path_for_uid(profile_id, uid);
    }
    current_gui_socket_path(profile_id)
}

#[cfg(target_os = "macos")]
fn console_user_uid() -> Option<String> {
    let output = std::process::Command::new("stat")
        .args(["-f", "%u", "/dev/console"])
        .output()
        .ok()?;
    if !output.status.success() {
        return None;
    }
    String::from_utf8(output.stdout)
        .ok()
        .map(|uid| uid.trim().to_string())
        .filter(|uid| !uid.is_empty() && uid != "0")
}

fn current_gui_socket_path(profile_id: &str) -> PathBuf {
    let uid = std::process::Command::new("id")
        .arg("-u")
        .output()
        .ok()
        .and_then(|output| String::from_utf8(output.stdout).ok())
        .map(|uid| uid.trim().to_string())
        .filter(|uid| !uid.is_empty())
        .unwrap_or_else(|| "unknown".to_string());
    socket_path_for_uid(profile_id, uid)
}

fn socket_path_for_uid(profile_id: &str, uid: impl AsRef<str>) -> PathBuf {
    PathBuf::from("/tmp").join(format!(
        "rieul-gui-profile-{profile_id}-{}.sock",
        uid.as_ref()
    ))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn socket_path_is_profile_scoped() {
        assert_eq!(
            socket_path_for_uid("abc123", "501"),
            PathBuf::from("/tmp").join("rieul-gui-profile-abc123-501.sock")
        );
    }

    #[test]
    fn pairing_request_payload_uses_ipc_schema() {
        let (proc_id, payload) =
            encode_gui_ipc_request(&GuiIpcRequest::ShowCode(PairingCodeNotification {
                daemon_url: "https://localhost:9012".to_string(),
                pairing_code: "123456".to_string(),
                expires_in_seconds: 30,
            }));

        assert_eq!(proc_id, ProcId::ShowPairingCode);
        let payload = ShowPairingCodeReq::decode(&payload.unwrap()).unwrap();
        assert_eq!(payload.pairing_code, "123456");
    }

    #[test]
    fn pairing_completed_uses_shared_gui_proc() {
        let (proc_id, payload) = encode_gui_ipc_request(&GuiIpcRequest::Completed);

        assert_eq!(proc_id, ProcId::PairingCompleted);
        assert!(payload.is_none());
    }
}
