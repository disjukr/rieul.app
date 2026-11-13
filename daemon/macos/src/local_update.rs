//! Fixed local updater endpoint; pathname is routing, never authority.
use anyhow::{Result, bail, ensure};
use rieul_daemon_core::{
    local_update::{self as wire, Operation},
    socket_wire::{SocketReqResMessage as Message, SocketRpcErrorKind},
};
use rieul_daemon_host::updates::{UpdateCommand, UpdateService};
use std::{
    fs,
    os::{
        fd::AsRawFd,
        unix::fs::{FileTypeExt, MetadataExt, OpenOptionsExt, PermissionsExt},
    },
    sync::Arc,
    time::Duration,
};
use tokio::{
    io::{AsyncRead, AsyncReadExt, AsyncWrite, AsyncWriteExt},
    net::{UnixListener, UnixStream},
    sync::watch,
};
const RESPONSE_CONSUMPTION_TIMEOUT: Duration = Duration::from_secs(5);
const ENDPOINT: &str = "/var/run/rieul-updater.sock";
const LOCK: &str = "/var/run/rieul-updater.lock";

pub struct Server {
    task: tokio::task::JoinHandle<()>,
    stop: watch::Sender<bool>,
    _lock: fs::File,
    inode: (u64, u64),
}
impl Drop for Server {
    fn drop(&mut self) {
        self.stop.send_replace(true);
        self.task.abort();
        if fs::symlink_metadata(ENDPOINT)
            .is_ok_and(|m| m.uid() == 0 && (m.dev(), m.ino()) == self.inode)
        {
            let _ = fs::remove_file(ENDPOINT);
        }
    }
}
pub async fn start(
    updater: Arc<dyn UpdateService>,
    ready: Arc<std::sync::atomic::AtomicBool>,
) -> Result<Server> {
    ensure!(
        unsafe { libc::geteuid() } == 0,
        "local updater requires system daemon"
    );
    let lock = fs::OpenOptions::new()
        .read(true)
        .write(true)
        .create(true)
        .truncate(false)
        .mode(0o600)
        .custom_flags(libc::O_NOFOLLOW)
        .open(LOCK)?;
    let metadata = lock.metadata()?;
    ensure!(
        metadata.is_file() && metadata.uid() == 0 && metadata.mode() & 0o077 == 0,
        "unsafe updater IPC lock"
    );
    ensure!(
        unsafe { libc::flock(lock.as_raw_fd(), libc::LOCK_EX | libc::LOCK_NB) } == 0,
        "local updater already running"
    );
    if let Ok(metadata) = fs::symlink_metadata(ENDPOINT) {
        ensure!(
            metadata.file_type().is_socket() && metadata.uid() == 0,
            "unsafe updater socket"
        );
        match tokio::time::timeout(Duration::from_secs(1), UnixStream::connect(ENDPOINT)).await? {
            Ok(_) => bail!("local updater socket already serving"),
            Err(e)
                if matches!(
                    e.kind(),
                    std::io::ErrorKind::ConnectionRefused | std::io::ErrorKind::NotFound
                ) =>
            {
                fs::remove_file(ENDPOINT)?;
            }
            Err(e) => return Err(e.into()),
        }
    }
    let listener = UnixListener::bind(ENDPOINT)?;
    fs::set_permissions(ENDPOINT, fs::Permissions::from_mode(0o666))?;
    let metadata = fs::symlink_metadata(ENDPOINT)?;
    let inode = (metadata.dev(), metadata.ino());
    let (stop, receiver) = watch::channel(false);
    let slots = Arc::new(tokio::sync::Semaphore::new(16));
    let task = tokio::spawn(async move {
        while let Ok((stream, _)) = listener.accept().await {
            let Ok(slot) = slots.clone().try_acquire_owned() else {
                continue;
            };
            let updater = updater.clone();
            let ready = ready.clone();
            let mut stop = receiver.clone();
            tokio::spawn(async move {
                let _slot = slot;
                tokio::select! {
                    _=stop.changed()=>{},
                    result=authenticated(stream,updater,ready)=>if let Err(error)=result { tracing::debug!(?error,"local updater connection ended"); },
                }
            });
        }
    });
    Ok(Server {
        task,
        stop,
        _lock: lock,
        inode,
    })
}
fn authenticate(stream: &UnixStream, uid: u32) -> Result<()> {
    let user = if uid == 0 {
        unsafe { libc::geteuid() }
    } else {
        uid
    };
    ensure!(
        user >= 500 && crate::desktop_ipc::console_uid() == Ok(user),
        "active login changed"
    );
    crate::desktop_ipc::verify_peer(stream, uid)
        .map_err(|e| anyhow::anyhow!("updater peer rejected: {e:?}"))?;
    Ok(())
}
async fn monitor(stream: &UnixStream, uid: u32) -> Result<()> {
    loop {
        authenticate(stream, uid)?;
        tokio::time::sleep(Duration::from_secs(1)).await;
    }
}
async fn authenticated(
    stream: UnixStream,
    updater: Arc<dyn UpdateService>,
    ready: Arc<std::sync::atomic::AtomicBool>,
) -> Result<()> {
    ensure!(
        ready.load(std::sync::atomic::Ordering::Acquire),
        "daemon not ready"
    );
    let uid = crate::desktop_ipc::console_uid().map_err(|_| anyhow::anyhow!("no active user"))?;
    authenticate(&stream, uid)?;
    let standard = stream.into_std()?;
    let probe = UnixStream::from_std(standard.try_clone()?)?;
    let stream = UnixStream::from_std(standard)?;
    tokio::select! { result=serve(stream,updater,||authenticate(&probe,uid))=>result, result=monitor(&probe,uid)=>result }
}
async fn read<R: AsyncRead + Unpin>(reader: &mut R) -> Result<Message> {
    let len = reader.read_u32().await? as usize;
    ensure!(
        (1..=wire::MAX_FRAME).contains(&len),
        "invalid local update frame size"
    );
    let mut bytes = vec![0; len];
    reader.read_exact(&mut bytes).await?;
    wire::decode(&bytes).ok_or_else(|| anyhow::anyhow!("invalid local update frame"))
}
async fn write<W: AsyncWrite + Unpin>(writer: &mut W, message: Message) -> Result<()> {
    let bytes =
        wire::encode(&message).ok_or_else(|| anyhow::anyhow!("oversized local update response"))?;
    tokio::time::timeout(Duration::from_secs(2), writer.write_all(&bytes)).await??;
    Ok(())
}
async fn serve<S: AsyncRead + AsyncWrite + Unpin>(
    stream: S,
    updater: Arc<dyn UpdateService>,
    check: impl Fn() -> Result<()>,
) -> Result<()> {
    let (mut reader, mut writer) = tokio::io::split(stream);
    let request = tokio::time::timeout(Duration::from_secs(5), read(&mut reader)).await??;
    let operation = Operation::parse(request)
        .ok_or_else(|| anyhow::anyhow!("unsupported local updater request"))?;
    check()?;
    let disconnected = async {
        let mut byte = [0];
        let _ = reader.read(&mut byte).await;
    };
    let action = async {
        if operation == Operation::Subscribe {
            let mut events = updater.subscribe()?;
            let mut first = true;
            loop {
                check()?;
                let status = events.borrow_and_update().clone();
                let message = if first {
                    Message::ResponseStreamStart {
                        stream_id: 1,
                        payload: Some(status.encode()),
                    }
                } else {
                    Message::ResponseStreamChunk {
                        stream_id: 1,
                        payload: status.encode(),
                    }
                };
                first = false;
                write(&mut writer, message).await?;
                events.changed().await?;
            }
        } else {
            let result = match operation {
                Operation::Check => updater.request(UpdateCommand::Check).await,
                Operation::Install => updater.request(UpdateCommand::InstallConfirmed).await,
                Operation::ForceInstall => {
                    updater.request(UpdateCommand::ForceInstallConfirmed).await
                }
                Operation::Restart => updater.restart().await,
                _ => unreachable!(),
            };
            check()?;
            let message = match result {
                Ok(status) => Message::ResponseUnaryOk {
                    stream_id: 1,
                    payload: Some(status.encode()),
                },
                Err(error) => Message::ResponseUnaryError {
                    stream_id: 1,
                    error_kind: SocketRpcErrorKind::Method,
                    error: rieul_daemon_core::ipc::failed_error(error.to_string()).encode(),
                },
            };
            write(&mut writer, message).await?;
            write(&mut writer, Message::ResponseStreamEnd { stream_id: 1 }).await?;
            // LOCAL_PEER* evidence must remain available while the helper
            // authenticates this response. It closes after receiving End;
            // the reader branch below then retires this connection immediately.
            // A suspended authenticated helper cannot retain its slot forever.
            // This deadline starts only after both writes, never around the
            // accepted updater operation, and does not report operation success.
            tokio::time::sleep(RESPONSE_CONSUMPTION_TIMEOUT).await;
            bail!("local updater response consumption timed out")
        }
    };
    tokio::select! { result=action=>result, _=disconnected=>Ok(()) }
}

/// Installed signed system binary in the GUI user's context. The inherited pipe
/// conveys only a fixed action; root still verifies its code and active UID.
pub async fn helper(operation: Operation) -> Result<()> {
    let uid = unsafe { libc::geteuid() };
    ensure!(uid != 0, "updater helper must be a user process");
    let meta = fs::symlink_metadata(ENDPOINT)?;
    ensure!(
        meta.file_type().is_socket() && meta.uid() == 0,
        "unsafe updater endpoint"
    );
    let stream =
        tokio::time::timeout(Duration::from_secs(2), UnixStream::connect(ENDPOINT)).await??;
    authenticate(&stream, 0)?;
    let standard = stream.into_std()?;
    let probe = UnixStream::from_std(standard.try_clone()?)?;
    let mut stream = UnixStream::from_std(standard)?;
    let relay = async {
        write(&mut stream, operation.request()).await?;
        let mut stdout = tokio::io::stdout();
        loop {
            let message = read(&mut stream).await?;
            authenticate(&probe, 0)?;
            let end = matches!(message, Message::ResponseStreamEnd { stream_id: 1 });
            ensure!(
                matches!(
                    message,
                    Message::ResponseUnaryOk { stream_id: 1, .. }
                        | Message::ResponseUnaryError { stream_id: 1, .. }
                        | Message::ResponseStreamStart { stream_id: 1, .. }
                        | Message::ResponseStreamChunk { stream_id: 1, .. }
                        | Message::ResponseStreamEnd { stream_id: 1 }
                ),
                "invalid updater response"
            );
            write(&mut stdout, message).await?;
            stdout.flush().await?;
            if end {
                return Ok(());
            }
        }
    };
    let parent_closed = crate::desktop_ipc::parent_closed();
    tokio::select! {result=relay=>result, result=monitor(&probe,0)=>result, _=parent_closed=>Ok(())}
}

#[cfg(test)]
mod tests {
    use super::*;
    use rieul_daemon_host::updates::{StatusFeed, UpdateRequest};
    use std::sync::atomic::{AtomicUsize, Ordering};
    struct Fixture {
        feed: StatusFeed,
        calls: AtomicUsize,
    }
    impl Fixture {
        fn new() -> Arc<Self> {
            Arc::new(Self {
                feed: StatusFeed::default(),
                calls: AtomicUsize::new(0),
            })
        }
    }
    impl UpdateService for Fixture {
        fn status(&self) -> Result<rieul_daemon_core::generated::rpc::UpdateStatus> {
            Ok(self.feed.subscribe().borrow().clone())
        }
        fn subscribe(
            &self,
        ) -> Result<watch::Receiver<rieul_daemon_core::generated::rpc::UpdateStatus>> {
            self.calls.fetch_add(1, Ordering::SeqCst);
            Ok(self.feed.subscribe())
        }
        fn request(&self, _: UpdateCommand) -> UpdateRequest<'_> {
            Box::pin(async {
                self.calls.fetch_add(1, Ordering::SeqCst);
                self.status()
            })
        }
        fn restart(&self) -> UpdateRequest<'_> {
            self.request(UpdateCommand::Check)
        }
    }
    #[tokio::test]
    async fn not_ready_rejects_before_any_updater_operation() {
        let (_client, server) = UnixStream::pair().unwrap();
        let fixture = Fixture::new();
        let error = authenticated(
            server,
            fixture.clone(),
            Arc::new(std::sync::atomic::AtomicBool::new(false)),
        )
        .await
        .unwrap_err();
        assert!(error.to_string().contains("not ready"));
        assert_eq!(fixture.calls.load(Ordering::SeqCst), 0);
    }
    #[tokio::test]
    async fn failed_auth_never_invokes_any_privileged_operation() {
        for operation in [
            Operation::Subscribe,
            Operation::Check,
            Operation::Install,
            Operation::ForceInstall,
            Operation::Restart,
        ] {
            let fixture = Fixture::new();
            let (mut client, server) = tokio::io::duplex(4096);
            write(&mut client, operation.request()).await.unwrap();
            assert!(
                serve(server, fixture.clone(), || bail!(
                    "fixture wrong UID/code/signature"
                ))
                .await
                .is_err()
            );
            assert_eq!(fixture.calls.load(Ordering::SeqCst), 0);
        }
    }
    #[tokio::test]
    async fn subscription_delivers_initial_then_changes_and_cleans_up_on_disconnect() {
        let fixture = Fixture::new();
        let (mut client, server) = tokio::io::duplex(4096);
        let service = fixture.clone();
        let task = tokio::spawn(async move { serve(server, service, || Ok(())).await });
        write(&mut client, Operation::Subscribe.request())
            .await
            .unwrap();
        assert!(matches!(
            read(&mut client).await.unwrap(),
            Message::ResponseStreamStart { stream_id: 1, .. }
        ));
        let mut state = fixture.status().unwrap();
        state.reason = Some("fixture changed".into());
        fixture.feed.publish(state);
        assert!(matches!(
            read(&mut client).await.unwrap(),
            Message::ResponseStreamChunk { stream_id: 1, .. }
        ));
        drop(client);
        tokio::time::timeout(Duration::from_secs(1), task)
            .await
            .unwrap()
            .unwrap()
            .unwrap();
        assert_eq!(fixture.calls.load(Ordering::SeqCst), 1);
    }
    #[tokio::test]
    async fn unary_fixed_commands_and_oversized_frames_are_bounded() {
        for operation in [
            Operation::Check,
            Operation::Install,
            Operation::ForceInstall,
            Operation::Restart,
        ] {
            let fixture = Fixture::new();
            let (mut client, server) = tokio::io::duplex(4096);
            let service = fixture.clone();
            let task = tokio::spawn(async move { serve(server, service, || Ok(())).await });
            write(&mut client, operation.request()).await.unwrap();
            assert!(matches!(
                read(&mut client).await.unwrap(),
                Message::ResponseUnaryOk { stream_id: 1, .. }
            ));
            assert!(matches!(
                read(&mut client).await.unwrap(),
                Message::ResponseStreamEnd { stream_id: 1 }
            ));
            assert!(
                !task.is_finished(),
                "peer must remain authenticatable through response consumption"
            );
            drop(client);
            tokio::time::timeout(Duration::from_secs(1), task)
                .await
                .unwrap()
                .unwrap()
                .unwrap();
            assert_eq!(fixture.calls.load(Ordering::SeqCst), 1);
        }
        let fixture = Fixture::new();
        let (mut client, server) = tokio::io::duplex(4096);
        client
            .write_u32((wire::MAX_FRAME + 1) as u32)
            .await
            .unwrap();
        assert!(serve(server, fixture.clone(), || Ok(())).await.is_err());
        assert_eq!(fixture.calls.load(Ordering::SeqCst), 0);
    }
    #[tokio::test]
    async fn eof_returns_connection_slot_without_waiting_for_consumption_deadline() {
        let slots = Arc::new(tokio::sync::Semaphore::new(1));
        let permit = slots.clone().acquire_owned().await.unwrap();
        let (mut client, server) = tokio::io::duplex(4096);
        let fixture = Fixture::new();
        let task = tokio::spawn(async move {
            let _permit = permit;
            serve(server, fixture, || Ok(())).await
        });
        write(&mut client, Operation::Install.request())
            .await
            .unwrap();
        read(&mut client).await.unwrap();
        read(&mut client).await.unwrap();
        assert_eq!(slots.available_permits(), 0);
        drop(client);
        tokio::time::timeout(Duration::from_secs(1), task)
            .await
            .unwrap()
            .unwrap()
            .unwrap();
        assert_eq!(slots.available_permits(), 1);
    }
    #[tokio::test]
    async fn stalled_consumers_return_all_slots_without_cancelling_accepted_work() {
        struct Background {
            fixture: Arc<Fixture>,
            release: Arc<tokio::sync::Barrier>,
            reply: Arc<tokio::sync::Barrier>,
            done: Arc<AtomicUsize>,
        }
        impl UpdateService for Background {
            fn status(&self) -> Result<rieul_daemon_core::generated::rpc::UpdateStatus> {
                self.fixture.status()
            }
            fn subscribe(
                &self,
            ) -> Result<watch::Receiver<rieul_daemon_core::generated::rpc::UpdateStatus>>
            {
                self.fixture.subscribe()
            }
            fn request(&self, _: UpdateCommand) -> UpdateRequest<'_> {
                Box::pin(async {
                    self.fixture.calls.fetch_add(1, Ordering::SeqCst);
                    let release = self.release.clone();
                    let done = self.done.clone();
                    tokio::spawn(async move {
                        release.wait().await;
                        done.fetch_add(1, Ordering::SeqCst);
                    });
                    self.reply.wait().await;
                    self.status()
                })
            }
        }
        let fixture = Fixture::new();
        let release = Arc::new(tokio::sync::Barrier::new(17));
        let done = Arc::new(AtomicUsize::new(0));
        let reply = Arc::new(tokio::sync::Barrier::new(17));
        let service = Arc::new(Background {
            fixture: fixture.clone(),
            release: release.clone(),
            reply: reply.clone(),
            done: done.clone(),
        });
        let slots = Arc::new(tokio::sync::Semaphore::new(16));
        let mut clients = vec![];
        let mut tasks = vec![];
        for _ in 0..16 {
            let permit = slots.clone().acquire_owned().await.unwrap();
            let (mut client, server) = tokio::io::duplex(4096);
            let service = service.clone();
            tasks.push(tokio::spawn(async move {
                let _permit = permit;
                serve(server, service, || Ok(())).await
            }));
            write(&mut client, Operation::Install.request())
                .await
                .unwrap();
            // Keep the consumer alive but do not read the buffered response.
            clients.push(client);
        }
        assert_eq!(slots.available_permits(), 0);
        // The request may run longer than the response-consumption budget.
        tokio::time::sleep(RESPONSE_CONSUMPTION_TIMEOUT + Duration::from_millis(100)).await;
        assert!(tasks.iter().all(|task| !task.is_finished()));
        assert_eq!(fixture.calls.load(Ordering::SeqCst), 16);
        reply.wait().await;
        tokio::time::timeout(
            RESPONSE_CONSUMPTION_TIMEOUT + Duration::from_secs(2),
            async {
                for task in tasks {
                    let error = task.await.unwrap().unwrap_err();
                    assert!(error.to_string().contains("response consumption timed out"));
                }
            },
        )
        .await
        .unwrap();
        assert_eq!(slots.available_permits(), 16);
        assert_eq!(fixture.calls.load(Ordering::SeqCst), 16);
        assert_eq!(done.load(Ordering::SeqCst), 0);
        // Connection expiry must not abort accepted, independently owned work.
        tokio::time::timeout(Duration::from_secs(1), release.wait())
            .await
            .unwrap();
        tokio::time::timeout(Duration::from_secs(1), async {
            while done.load(Ordering::SeqCst) != 16 {
                tokio::task::yield_now().await;
            }
        })
        .await
        .unwrap();
        for mut client in clients {
            assert!(matches!(
                read(&mut client).await.unwrap(),
                Message::ResponseUnaryOk { .. }
            ));
            assert!(matches!(
                read(&mut client).await.unwrap(),
                Message::ResponseStreamEnd { .. }
            ));
            assert!(read(&mut client).await.is_err());
        }
    }
    #[tokio::test]
    async fn changed_identity_stops_subscription_before_next_snapshot() {
        let fixture = Fixture::new();
        let (mut client, server) = tokio::io::duplex(4096);
        let permitted = Arc::new(std::sync::atomic::AtomicBool::new(true));
        let check = permitted.clone();
        let service = fixture.clone();
        let task = tokio::spawn(async move {
            serve(server, service, || {
                ensure!(check.load(Ordering::SeqCst), "login replaced");
                Ok(())
            })
            .await
        });
        write(&mut client, Operation::Subscribe.request())
            .await
            .unwrap();
        read(&mut client).await.unwrap();
        permitted.store(false, Ordering::SeqCst);
        let mut state = fixture.status().unwrap();
        state.reason = Some("must not deliver".into());
        fixture.feed.publish(state);
        assert!(task.await.unwrap().is_err());
        assert!(read(&mut client).await.is_err());
    }
}
