use std::future::Future;
use std::path::{Path, PathBuf};
use std::pin::Pin;
use std::sync::Arc;

use anyhow::{anyhow, bail, Context, Result};
use rieul_daemon_core::config::{macos_system_config_path, profile_id_for_config_path};
use rieul_daemon_core::ipc::{
    ConfirmPairingReq, ConfirmPairingRes, IpcProcError, ProcId, ShowPairingCodeReq,
};
use rieul_daemon_core::socket_wire::{
    SocketReqResMessage, SocketRpcErrorKind, MAX_SOCKET_WIRE_SEQUENCE_SIZE,
};
pub use rieul_daemon_host::server::PairingConfirmationRequest;
use rieul_daemon_host::server::{PairingCodeNotification, PairingNotifier};
use tokio::io::{AsyncRead, AsyncReadExt, AsyncWrite, AsyncWriteExt};
use tokio::net::{UnixListener, UnixStream};

const DEFAULT_STREAM_ID: u64 = 1;

pub type PairingNotification = PairingCodeNotification;

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum PairingIpcRequest {
    Confirm(PairingConfirmationRequest),
    ShowCode(PairingNotification),
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct MacUserPairingNotifier {
    profile_id: String,
}

impl Default for MacUserPairingNotifier {
    fn default() -> Self {
        Self::from_config_path(macos_system_config_path())
    }
}

impl MacUserPairingNotifier {
    pub fn from_config_path(config_path: impl AsRef<Path>) -> Self {
        Self {
            profile_id: profile_id_for_config_path(config_path),
        }
    }
}

impl PairingNotifier for MacUserPairingNotifier {
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
}

pub fn spawn_pairing_notification_server(
    profile_id: impl Into<String>,
    handler: impl Fn(PairingIpcRequest) -> Result<()> + Send + Sync + 'static,
) {
    let profile_id = profile_id.into();
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
        if let Err(err) = runtime.block_on(run_pairing_notification_server(profile_id, handler)) {
            tracing::warn!(?err, "pairing notification socket server stopped");
        }
    });
}

async fn send_pairing_ipc_request(profile_id: &str, request: PairingIpcRequest) -> Result<()> {
    let socket_path = active_user_socket_path(profile_id);
    let (proc_id, payload) = encode_pairing_ipc_request(&request);
    let mut stream = UnixStream::connect(&socket_path)
        .await
        .with_context(|| format!("connect user daemon socket {}", socket_path.display()))?;
    let response = call_ipc_unary(&mut stream, proc_id.as_u64(), payload).await?;

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
        PairingIpcRequest::ShowCode(_) => Ok(()),
    }
}

async fn run_pairing_notification_server(
    profile_id: String,
    handler: Arc<dyn Fn(PairingIpcRequest) -> Result<()> + Send + Sync>,
) -> Result<()> {
    let socket_path = current_user_socket_path(&profile_id);
    if socket_path.exists() {
        let _ = std::fs::remove_file(&socket_path);
    }
    let listener = UnixListener::bind(&socket_path)
        .with_context(|| format!("bind user daemon socket {}", socket_path.display()))?;

    loop {
        let (mut stream, _) = listener.accept().await?;
        let handler = handler.clone();
        tokio::spawn(async move {
            let (stream_id, request) = match read_pairing_ipc_request(&mut stream).await {
                Ok(request) => request,
                Err(err) => {
                    tracing::warn!(?err, "failed to read pairing notification socket request");
                    return;
                }
            };
            let has_response_payload = matches!(request, PairingIpcRequest::Confirm(_));
            let response = match tokio::task::spawn_blocking(move || handler(request)).await {
                Ok(Ok(())) if has_response_payload => {
                    Ok(Some(ConfirmPairingRes { accepted: true }.encode()))
                }
                Ok(Ok(())) => Ok(None),
                Ok(Err(err)) => Err(IpcProcError::Failed {
                    message: err.to_string(),
                }),
                Err(err) => Err(IpcProcError::Failed {
                    message: err.to_string(),
                }),
            };
            if let Err(err) = write_ipc_unary_response(&mut stream, stream_id, response).await {
                tracing::warn!(?err, "failed to write pairing notification socket response");
            }
        });
    }
}

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
    }
}

async fn read_pairing_ipc_request(stream: &mut UnixStream) -> Result<(u64, PairingIpcRequest)> {
    let request = read_ipc_unary_request(stream).await?;
    let payload = request
        .payload
        .as_deref()
        .ok_or_else(|| anyhow!("pairing IPC request is missing payload"))?;
    let stream_id = request.stream_id;
    let request = match ProcId::from_u64(request.proc_id) {
        Some(ProcId::ConfirmPairing) => {
            let payload = ConfirmPairingReq::decode(payload)
                .map_err(|err| anyhow!("ConfirmPairing request is malformed: {err}"))?;
            PairingIpcRequest::Confirm(PairingConfirmationRequest {
                daemon_url: payload.daemon_url,
                confirmation_code: payload.confirmation_code,
                client_label: payload.client_label,
            })
        }
        Some(ProcId::ShowPairingCode) => {
            let payload = ShowPairingCodeReq::decode(payload)
                .map_err(|err| anyhow!("ShowPairingCode request is malformed: {err}"))?;
            PairingIpcRequest::ShowCode(PairingNotification {
                daemon_url: payload.daemon_url,
                pairing_code: payload.pairing_code,
                expires_in_seconds: i64::try_from(payload.expires_in_seconds).unwrap_or(i64::MAX),
            })
        }
        _ => bail!("unsupported pairing IPC proc id {}", request.proc_id),
    };
    Ok((stream_id, request))
}

#[derive(Debug)]
struct IpcUnaryRequest {
    stream_id: u64,
    proc_id: u64,
    payload: Option<Vec<u8>>,
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

async fn read_ipc_unary_request<R>(reader: &mut R) -> Result<IpcUnaryRequest>
where
    R: AsyncRead + Unpin,
{
    let mut messages = SocketWireMessageReader::new(MAX_SOCKET_WIRE_SEQUENCE_SIZE);
    let mut request: Option<IpcUnaryRequest> = None;
    loop {
        let message = messages.read_next(reader).await?;
        match message {
            SocketReqResMessage::RequestUnary {
                stream_id,
                proc_id,
                payload,
            } => {
                if request.is_some() {
                    bail!("IPC stream sent more than one unary request");
                }
                request = Some(IpcUnaryRequest {
                    stream_id,
                    proc_id,
                    payload,
                });
            }
            SocketReqResMessage::RequestStreamEnd { stream_id } => {
                let request =
                    request.ok_or_else(|| anyhow!("IPC stream ended before unary request"))?;
                if request.stream_id != stream_id {
                    bail!("IPC request stream id mismatch");
                }
                return Ok(request);
            }
            other => bail!("unexpected IPC request message {other:?}"),
        }
    }
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

async fn write_ipc_unary_response<W>(
    writer: &mut W,
    stream_id: u64,
    response: Result<Option<Vec<u8>>, IpcProcError>,
) -> Result<()>
where
    W: AsyncWrite + Unpin,
{
    let response = match response {
        Ok(payload) => SocketReqResMessage::ResponseUnaryOk { payload, stream_id },
        Err(error) => SocketReqResMessage::ResponseUnaryError {
            error: error.encode(),
            error_kind: SocketRpcErrorKind::Method,
            stream_id,
        },
    };
    let bytes = SocketReqResMessage::encode_sequence(&[
        response,
        SocketReqResMessage::ResponseStreamEnd { stream_id },
    ]);
    writer
        .write_all(&bytes)
        .await
        .context("write IPC response")?;
    writer.flush().await.context("flush IPC response")
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

fn active_user_socket_path(profile_id: &str) -> PathBuf {
    if let Some(uid) = std::env::var_os("SUDO_UID").filter(|uid| !uid.is_empty()) {
        return socket_path_for_uid(profile_id, uid.to_string_lossy());
    }
    #[cfg(target_os = "macos")]
    if let Some(uid) = console_user_uid() {
        return socket_path_for_uid(profile_id, uid);
    }
    current_user_socket_path(profile_id)
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

fn current_user_socket_path(profile_id: &str) -> PathBuf {
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
            encode_pairing_ipc_request(&PairingIpcRequest::ShowCode(PairingNotification {
                daemon_url: "https://localhost:9012".to_string(),
                pairing_code: "123456".to_string(),
                expires_in_seconds: 30,
            }));

        assert_eq!(proc_id, ProcId::ShowPairingCode);
        let payload = ShowPairingCodeReq::decode(&payload.unwrap()).unwrap();
        assert_eq!(payload.pairing_code, "123456");
    }
}
