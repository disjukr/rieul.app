//! Profile-scoped socket IPC; no HTTP endpoint and no JavaScript host process.
use crate::controller::Reply;
#[cfg(windows)]
use anyhow::Context;
use anyhow::{Result, bail, ensure};
use rieul_daemon_core::{
    ipc,
    socket_wire::{
        MAX_SOCKET_WIRE_SEQUENCE_SIZE, SocketReqResMessage as Message, SocketRpcErrorKind,
    },
};
use std::{
    sync::{
        atomic::{AtomicU64, Ordering},
        mpsc,
    },
    time::Duration,
};
use tokio::{
    io::{AsyncRead, AsyncReadExt, AsyncWrite, AsyncWriteExt},
    sync::oneshot,
};

pub enum Event {
    Request {
        proc_id: u64,
        payload: Vec<u8>,
        connection: u64,
        reply: Reply,
    },
    Disconnected(u64),
}
static CONNECTION: AtomicU64 = AtomicU64::new(1);

pub async fn activate<T: AsyncRead + AsyncWrite + Unpin>(stream: &mut T) -> Result<()> {
    let request = ipc::ActivateGuiReq {
        reason: "already-running".into(),
    };
    stream
        .write_all(&Message::encode_sequence(&[
            Message::RequestUnary {
                proc_id: 4,
                stream_id: 1,
                payload: Some(request.encode()),
            },
            Message::RequestStreamEnd { stream_id: 1 },
        ]))
        .await?;
    stream.shutdown().await?;
    let mut response = vec![];
    stream.take(65537).read_to_end(&mut response).await?;
    ensure!(response.len() <= 65536, "GUI activation response too large");
    let messages = Message::decode_sequence(&response)?;
    ensure!(
        matches!(
            messages.as_slice(),
            [
                Message::ResponseUnaryOk { stream_id: 1, .. },
                Message::ResponseStreamEnd { stream_id: 1 }
            ]
        ),
        "invalid GUI activation response"
    );
    Ok(())
}

async fn read_request<T: AsyncRead + Unpin>(stream: &mut T) -> Result<(u64, u64, Vec<u8>)> {
    let mut bytes = vec![];
    loop {
        if let Some((message, _)) = Message::decode_prefix(&bytes)? {
            let Message::RequestUnary {
                proc_id,
                stream_id,
                payload,
            } = message
            else {
                bail!("expected unary GUI request");
            };
            return Ok((proc_id, stream_id, payload.unwrap_or_default()));
        }
        ensure!(
            bytes.len() < MAX_SOCKET_WIRE_SEQUENCE_SIZE,
            "IPC request too large"
        );
        let mut chunk = [0; 8192];
        let n = stream.read(&mut chunk).await?;
        ensure!(n != 0, "incomplete GUI request");
        bytes.extend_from_slice(&chunk[..n]);
    }
}
async fn serve<T: AsyncRead + AsyncWrite + Unpin>(
    mut stream: T,
    events: mpsc::Sender<Event>,
) -> Result<()> {
    let (proc_id, stream_id, payload) =
        tokio::time::timeout(Duration::from_secs(5), read_request(&mut stream)).await??;
    let connection = CONNECTION.fetch_add(1, Ordering::Relaxed);
    let (tx, mut rx) = oneshot::channel();
    events.send(Event::Request {
        proc_id,
        payload,
        connection,
        reply: tx,
    })?;
    let result = if proc_id == 2 {
        // The daemon's in-band stream end is not cancellation. EOF is cancellation.
        let disconnected = async {
            let mut scratch = [0; 1024];
            while stream.read(&mut scratch).await? != 0 {}
            Ok::<_, std::io::Error>(())
        };
        tokio::select! {
            reply = &mut rx => reply?,
            _ = disconnected => {
                let _ = events.send(Event::Disconnected(connection));
                rx.await?
            }
        }
    } else {
        rx.await?
    };
    let response = match result {
        Ok(payload) => Message::ResponseUnaryOk { payload, stream_id },
        Err(error) => Message::ResponseUnaryError {
            error: ipc::failed_error(error.to_string()).encode(),
            error_kind: SocketRpcErrorKind::Method,
            stream_id,
        },
    };
    tokio::time::timeout(Duration::from_secs(1), async {
        stream
            .write_all(&Message::encode_sequence(&[
                response,
                Message::ResponseStreamEnd { stream_id },
            ]))
            .await?;
        stream.shutdown().await
    })
    .await??;
    Ok(())
}

#[cfg(unix)]
pub struct Listener {
    inner: tokio::net::UnixListener,
    path: std::path::PathBuf,
    identity: (u64, u64),
}
#[cfg(unix)]
impl Listener {
    pub async fn bind(path: &std::path::Path) -> Result<Option<Self>> {
        use std::os::unix::fs::{FileTypeExt, MetadataExt};
        match tokio::net::UnixStream::connect(path).await {
            Ok(mut stream) => {
                tokio::time::timeout(Duration::from_secs(5), activate(&mut stream)).await??;
                return Ok(None);
            }
            Err(e)
                if [
                    std::io::ErrorKind::NotFound,
                    std::io::ErrorKind::ConnectionRefused,
                ]
                .contains(&e.kind()) => {}
            Err(e) => return Err(e.into()),
        }
        let inner = match tokio::net::UnixListener::bind(path) {
            Ok(listener) => listener,
            Err(error) if error.kind() == std::io::ErrorKind::AddrInUse => {
                // Recheck before unlinking. Only this user's stale socket is eligible.
                if let Ok(mut stream) = tokio::net::UnixStream::connect(path).await {
                    tokio::time::timeout(Duration::from_secs(5), activate(&mut stream)).await??;
                    return Ok(None);
                }
                let meta = std::fs::symlink_metadata(path)?;
                ensure!(
                    meta.file_type().is_socket() && meta.uid() == unsafe { libc::getuid() },
                    "refusing to remove non-owned socket"
                );
                std::fs::remove_file(path)?;
                tokio::net::UnixListener::bind(path)?
            }
            Err(error) => return Err(error.into()),
        };
        let meta = std::fs::symlink_metadata(path)?;
        Ok(Some(Self {
            inner,
            path: path.into(),
            identity: (meta.dev(), meta.ino()),
        }))
    }
    pub async fn run(self, events: mpsc::Sender<Event>) -> Result<()> {
        loop {
            let (stream, _) = self.inner.accept().await?;
            let events = events.clone();
            tokio::spawn(async move {
                if let Err(error) = serve(stream, events).await {
                    eprintln!("GUI IPC: {error}");
                }
            });
        }
    }
}
#[cfg(unix)]
impl Drop for Listener {
    fn drop(&mut self) {
        use std::os::unix::fs::MetadataExt;
        if let Ok(meta) = std::fs::symlink_metadata(&self.path) {
            if (meta.dev(), meta.ino()) == self.identity {
                let _ = std::fs::remove_file(&self.path);
            }
        }
    }
}

#[cfg(windows)]
pub struct Listener {
    inner: tokio::net::windows::named_pipe::NamedPipeServer,
    path: std::path::PathBuf,
}
#[cfg(windows)]
impl Listener {
    pub async fn bind(path: &std::path::Path) -> Result<Option<Self>> {
        use tokio::net::windows::named_pipe::{ClientOptions, ServerOptions};
        // A second process can arrive while the server creates its next instance.
        // Wait for that instance instead of treating ERROR_PIPE_BUSY as a failure.
        let deadline = tokio::time::Instant::now() + Duration::from_secs(5);
        loop {
            match ClientOptions::new().open(path) {
                Ok(mut stream) => {
                    tokio::time::timeout(Duration::from_secs(5), activate(&mut stream)).await??;
                    return Ok(None);
                }
                Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
                    match ServerOptions::new().first_pipe_instance(true).create(path) {
                        Ok(inner) => {
                            return Ok(Some(Self {
                                inner,
                                path: path.into(),
                            }));
                        }
                        Err(error) if error.raw_os_error() == Some(5) => {} // concurrent first instance
                        Err(error) => return Err(error).context("bind GUI pipe"),
                    }
                }
                Err(error) if error.raw_os_error() == Some(231) => {}
                Err(error) => return Err(error.into()),
            }
            ensure!(
                tokio::time::Instant::now() < deadline,
                "GUI pipe activation deadline"
            );
            tokio::time::sleep(Duration::from_millis(20)).await;
        }
    }
    pub async fn run(mut self, events: mpsc::Sender<Event>) -> Result<()> {
        use tokio::net::windows::named_pipe::ServerOptions;
        loop {
            self.inner.connect().await?;
            let next = ServerOptions::new().create(&self.path)?;
            let stream = std::mem::replace(&mut self.inner, next);
            let events = events.clone();
            tokio::spawn(async move {
                if let Err(error) = serve(stream, events).await {
                    eprintln!("GUI IPC: {error}");
                }
            });
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::controller::{Controller, Info};
    fn info() -> Info {
        Info {
            config_path: "fixture.yaml".into(),
            daemon_url: "https://fixture.invalid".into(),
        }
    }
    async fn send_confirmation(client: &mut tokio::io::DuplexStream) {
        let payload = ipc::ConfirmPairingReq {
            daemon_url: info().daemon_url,
            confirmation_code: "42".into(),
            client_label: "Fixture".into(),
        }
        .encode();
        let request = Message::encode_sequence(&[
            Message::RequestUnary {
                proc_id: 2,
                stream_id: 7,
                payload: Some(payload),
            },
            Message::RequestStreamEnd { stream_id: 7 },
        ]);
        // Deliberately split every byte: framing cannot depend on socket chunks.
        for byte in request {
            client.write_all(&[byte]).await.unwrap();
        }
    }
    async fn event(rx: &mpsc::Receiver<Event>) -> Event {
        tokio::time::timeout(Duration::from_secs(2), async {
            loop {
                if let Ok(event) = rx.try_recv() {
                    return event;
                }
                tokio::task::yield_now().await;
            }
        })
        .await
        .unwrap()
    }
    #[tokio::test]
    async fn fragmented_confirmation_responds_with_original_stream_id() {
        let (mut client, server) = tokio::io::duplex(8192);
        let (tx, rx) = mpsc::channel();
        let task = tokio::spawn(serve(server, tx));
        send_confirmation(&mut client).await;
        let Event::Request {
            proc_id,
            payload,
            connection,
            reply,
        } = event(&rx).await
        else {
            panic!()
        };
        let mut controller = Controller::new(info());
        controller.request(proc_id, &payload, connection, reply);
        controller.resolve(true, controller.generation).unwrap();
        let mut bytes = vec![];
        client.read_to_end(&mut bytes).await.unwrap();
        let messages = Message::decode_sequence(&bytes).unwrap();
        assert_eq!(messages.len(), 2);
        assert_eq!(messages[0].stream_id(), 7);
        assert!(
            ipc::ConfirmPairingRes::decode(messages[0].payload().unwrap())
                .unwrap()
                .accepted
        );
        assert!(matches!(
            messages[1],
            Message::ResponseStreamEnd { stream_id: 7 }
        ));
        task.await.unwrap().unwrap();
    }
    #[tokio::test]
    async fn half_close_cancels_pending_confirmation_but_returns_rejection() {
        let (mut client, server) = tokio::io::duplex(8192);
        let (tx, rx) = mpsc::channel();
        let task = tokio::spawn(serve(server, tx));
        send_confirmation(&mut client).await;
        let Event::Request {
            proc_id,
            payload,
            connection,
            reply,
        } = event(&rx).await
        else {
            panic!()
        };
        let mut controller = Controller::new(info());
        controller.request(proc_id, &payload, connection, reply);
        client.shutdown().await.unwrap();
        let Event::Disconnected(id) = event(&rx).await else {
            panic!()
        };
        assert_eq!(id, connection);
        controller.disconnected(id);
        let mut bytes = vec![];
        client.read_to_end(&mut bytes).await.unwrap();
        let messages = Message::decode_sequence(&bytes).unwrap();
        assert!(
            !ipc::ConfirmPairingRes::decode(messages[0].payload().unwrap())
                .unwrap()
                .accepted
        );
        task.await.unwrap().unwrap();
    }
    #[tokio::test]
    async fn duplicate_activation_checks_the_response() {
        let (mut client, server) = tokio::io::duplex(8192);
        let (tx, rx) = mpsc::channel();
        let server = tokio::spawn(serve(server, tx));
        let activation = tokio::spawn(async move { activate(&mut client).await });
        let Event::Request {
            proc_id,
            payload,
            connection,
            reply,
        } = event(&rx).await
        else {
            panic!()
        };
        let mut controller = Controller::new(info());
        assert_eq!(
            controller.request(proc_id, &payload, connection, reply),
            vec![crate::controller::Effect::Show]
        );
        activation.await.unwrap().unwrap();
        server.await.unwrap().unwrap();
    }
    #[cfg(unix)]
    #[tokio::test]
    async fn stale_socket_cleanup_never_removes_regular_files_or_symlinks() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("gui.sock");
        std::fs::write(&path, "keep").unwrap();
        assert!(Listener::bind(&path).await.is_err());
        assert_eq!(std::fs::read_to_string(&path).unwrap(), "keep");
        let link = dir.path().join("link.sock");
        std::os::unix::fs::symlink(&path, &link).unwrap();
        assert!(Listener::bind(&link).await.is_err());
        assert!(link.is_symlink());
        let stale = dir.path().join("stale.sock");
        drop(std::os::unix::net::UnixListener::bind(&stale).unwrap());
        let listener = Listener::bind(&stale).await.unwrap().unwrap();
        drop(listener);
        assert!(!stale.exists());
    }
}
