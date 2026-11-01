//! Bounded private user-session channel. OS peer authentication belongs to connectors.
//! No reconnect/replay after an established channel fails: held native state is uncertain.
use crate::desktop::{Backend, EncodedFrame, Error, MAX_FRAME, MAX_STREAM, MAX_VIEWPORTS, PROFILE};
use ipc::{
    UserDesktopCommand, UserDesktopFrame, UserDesktopRequest, UserDesktopResponse,
    UserDesktopResult,
};
use rieul_daemon_core::{
    generated::ipc, generated::rpc::*, socket_wire::SocketReqResMessage as Message,
};
use std::{
    collections::BTreeMap,
    future::Future,
    pin::Pin,
    sync::{Arc, mpsc},
    time::{Duration, Instant},
};
use tokio::io::{AsyncRead, AsyncReadExt, AsyncWrite, AsyncWriteExt};
const REQUEST_LIMIT: usize = 64 * 1024;
const RESPONSE_LIMIT: usize = 17 * 1024 * 1024;
const STREAM: u64 = 1;
pub trait Channel: AsyncRead + AsyncWrite + Send + Unpin {}
impl<T: AsyncRead + AsyncWrite + Send + Unpin> Channel for T {}
pub type Connection = Box<dyn Channel>;
pub type Connector =
    Arc<dyn Fn() -> Pin<Box<dyn Future<Output = Result<Connection, Error>> + Send>> + Send + Sync>;
#[derive(Default)]
struct Reader {
    bytes: Vec<u8>,
}
impl Reader {
    async fn read<R: AsyncRead + Unpin>(
        &mut self,
        input: &mut R,
        limit: usize,
    ) -> Result<Message, Error> {
        loop {
            if let Some((message, used)) =
                Message::decode_prefix(&self.bytes).map_err(|_| Error::Invalid)?
            {
                self.bytes.drain(..used);
                return Ok(message);
            }
            if self.bytes.len() >= limit {
                return Err(Error::Limit);
            }
            let mut buffer = [0; 8192];
            let capacity = buffer.len().min(limit - self.bytes.len());
            let n = input
                .read(&mut buffer[..capacity])
                .await
                .map_err(|_| Error::Backend)?;
            if n == 0 {
                return Err(Error::Backend);
            }
            self.bytes.extend_from_slice(&buffer[..n]);
        }
    }
}
async fn write<W: AsyncWrite + Unpin>(
    output: &mut W,
    message: Message,
    limit: usize,
) -> Result<(), Error> {
    let bytes = message.encode();
    if bytes.len() > limit {
        return Err(Error::Limit);
    }
    tokio::time::timeout(Duration::from_secs(2), output.write_all(&bytes))
        .await
        .map_err(|_| Error::Backend)?
        .map_err(|_| Error::Backend)
}
fn result(value: Result<UserDesktopResult, Error>) -> UserDesktopResult {
    value.unwrap_or_else(|error| UserDesktopResult::Failed {
        code: format!("{error:?}"),
    })
}
fn execute(backend: &dyn Backend, command: UserDesktopCommand) -> Result<UserDesktopResult, Error> {
    Ok(match command {
        UserDesktopCommand::Ping => UserDesktopResult::Done,
        UserDesktopCommand::Capabilities => UserDesktopResult::Capabilities {
            value: ipc::DesktopCapabilities::decode(&backend.capabilities().encode())
                .map_err(|_| Error::Invalid)?,
        },
        UserDesktopCommand::Displays => UserDesktopResult::Displays {
            values: backend
                .displays()
                .into_iter()
                .map(|d| ipc::DesktopDisplay::decode(&d.encode()).map_err(|_| Error::Invalid))
                .collect::<Result<_, _>>()?,
        },
        UserDesktopCommand::Cursor { layout_epoch } => UserDesktopResult::Cursor {
            value: backend
                .cursor(layout_epoch)
                .map(|c| ipc::DesktopEvent::decode(&c.encode()).map_err(|_| Error::Invalid))
                .transpose()?,
        },
        UserDesktopCommand::Input { event, viewport } => {
            let event = DesktopInputEvent::decode(&event.encode()).map_err(|_| Error::Invalid)?;
            let viewport = viewport
                .map(|v| DesktopViewport::decode(&v.encode()).map_err(|_| Error::Invalid))
                .transpose()?;
            backend.input_viewport(&event, viewport.as_ref())?;
            UserDesktopResult::Done
        }
        UserDesktopCommand::EndTrack { track } => {
            backend
                .end_track(&DesktopTrack::decode(&track.encode()).map_err(|_| Error::Invalid)?)?;
            UserDesktopResult::Done
        }
        UserDesktopCommand::Group { track } => {
            let mut total = 0usize;
            let mut frames = Vec::new();
            backend.stream_group(
                &DesktopTrack::decode(&track.encode()).map_err(|_| Error::Invalid)?,
                &mut |frame| {
                    total = total.checked_add(frame.data.len()).ok_or(Error::Limit)?;
                    if frames.len() >= 240
                        || frame.data.len() > 4 * 1024 * 1024
                        || total > 16 * 1024 * 1024
                    {
                        return Err(Error::Limit);
                    }
                    frames.push(UserDesktopFrame {
                        timestamp_micros: frame.timestamp_micros,
                        keyframe: frame.keyframe,
                        data: frame.data,
                    });
                    Ok(())
                },
            )?;
            UserDesktopResult::Group { frames }
        }
    })
}
/// Serve one already authenticated system peer. Caller must serialize ownership of
/// the native backend across connections and retire the helper on a cleanup error.
pub async fn serve<S: Channel + 'static>(
    stream: S,
    backend: Arc<dyn Backend>,
) -> Result<(), Error> {
    serve_until(stream, backend, std::future::pending()).await
}
pub async fn serve_until<S: Channel + 'static>(
    stream: S,
    backend: Arc<dyn Backend>,
    stop: impl Future<Output = ()> + Send,
) -> Result<(), Error> {
    tokio::pin!(stop);
    let (mut input, mut output) = tokio::io::split(stream);
    let mut reader = Reader::default();
    let (tx, mut rx) = tokio::sync::mpsc::channel::<UserDesktopResponse>(2);
    let (ended_tx, mut ended_rx) = tokio::sync::oneshot::channel();
    let writer = tokio::spawn(async move {
        let mut first = true;
        while let Some(response) = rx.recv().await {
            let message = if first {
                first = false;
                Message::ResponseStreamStart {
                    payload: Some(response.encode()),
                    stream_id: STREAM,
                }
            } else {
                Message::ResponseStreamChunk {
                    payload: response.encode(),
                    stream_id: STREAM,
                }
            };
            if write(&mut output, message, RESPONSE_LIMIT).await.is_err() {
                break;
            }
        }
        let _ = ended_tx.send(());
    });
    let mut first = true;
    let mut last = 0;
    let mut tracks =
        BTreeMap::<(u64, u64), (ipc::DesktopTrack, Arc<tokio::sync::Mutex<()>>)>::new();
    let mut groups = tokio::task::JoinSet::new();
    let outcome = async {
        loop {
            let message = tokio::select! {
                _ = &mut ended_rx => return Err(Error::Backend),
                _ = &mut stop => return Err(Error::Backend),
                message = tokio::time::timeout(Duration::from_secs(5), reader.read(&mut input, REQUEST_LIMIT)) => message.map_err(|_| Error::Stale)??,
            };
            let payload = match message {
                Message::RequestStreamStart { proc_id, payload: Some(payload), stream_id: STREAM }
                    if first && proc_id == ipc::ProcId::HostUserDesktop.as_u64() => payload,
                Message::RequestStreamChunk { payload, stream_id: STREAM } if !first => payload,
                _ => return Err(Error::Invalid),
            };
            first = false;
            let request = UserDesktopRequest::decode(&payload).map_err(|_| Error::Invalid)?;
            if request.request_id == 0 {
                if !matches!(request.command, UserDesktopCommand::Ping) { return Err(Error::Invalid); }
                tx.send(UserDesktopResponse { request_id: 0, result: UserDesktopResult::Done }).await.map_err(|_| Error::Backend)?;
                continue;
            }
            if request.request_id <= last { return Err(Error::Stale); }
            last = request.request_id;
            while groups.try_join_next().is_some() {}
            if let UserDesktopCommand::Group { track } = &request.command {
                let key = (track.track_id, track.codec_epoch);
                if tracks.len() >= 32 && !tracks.contains_key(&key) { return Err(Error::Limit); }
                let entry = tracks.entry(key).or_insert_with(|| (track.clone(), Arc::new(tokio::sync::Mutex::new(()))));
                if entry.0 != *track { return Err(Error::Stale); }
                let guard = entry.1.clone().try_lock_owned().map_err(|_| Error::Busy)?;
                if groups.len() >= 8 { return Err(Error::Busy); }
                let backend = backend.clone(); let tx = tx.clone();
                groups.spawn(async move {
                    let response = tokio::task::spawn_blocking(move || { let _guard = guard; result(execute(backend.as_ref(), request.command)) }).await
                        .unwrap_or(UserDesktopResult::Failed { code: "Backend".into() });
                    let _ = tx.send(UserDesktopResponse { request_id: request.request_id, result: response }).await;
                });
            } else {
                let guard = if let UserDesktopCommand::EndTrack { track } = &request.command {
                    if let Some((_, lock)) = tracks.remove(&(track.track_id, track.codec_epoch)) { Some(lock.lock_owned().await) } else { None }
                } else { None };
                let backend = backend.clone();
                let response = tokio::task::spawn_blocking(move || { let _guard = guard; result(execute(backend.as_ref(), request.command)) }).await.map_err(|_| Error::Backend)?;
                tx.send(UserDesktopResponse { request_id: request.request_id, result: response }).await.map_err(|_| Error::Backend)?;
            }
        }
    }.await;
    writer.abort();
    drop(tx);
    // Group workers may hold native captures; drain real work before releasing ownership.
    while groups.join_next().await.is_some() {}
    let cleanup = tokio::task::spawn_blocking(move || {
        let mut ok = backend.input(&DesktopInputEvent::ReleaseAll).is_ok();
        for (_, (track, _)) in tracks {
            ok &= DesktopTrack::decode(&track.encode())
                .map_err(|_| Error::Invalid)
                .and_then(|t| backend.end_track(&t))
                .is_ok();
        }
        if ok { Ok(()) } else { Err(Error::Backend) }
    })
    .await
    .map_err(|_| Error::Backend)?;
    cleanup?;
    outcome
}
struct Call {
    command: UserDesktopCommand,
    reply: mpsc::SyncSender<Result<UserDesktopResult, Error>>,
    deadline: Instant,
}
/// Lazy connection; neither construction nor GUI startup captures the desktop.
pub struct Proxy {
    sender: tokio::sync::mpsc::Sender<Call>,
}
impl Proxy {
    pub fn new(connector: Connector) -> Self {
        let (sender, receiver) = tokio::sync::mpsc::channel(16);
        std::thread::spawn(move || {
            if let Ok(runtime) = tokio::runtime::Builder::new_current_thread()
                .enable_all()
                .build()
            {
                runtime.block_on(proxy_worker(connector, receiver));
            }
        });
        Self { sender }
    }
    fn call(&self, command: UserDesktopCommand) -> Result<UserDesktopResult, Error> {
        let (tx, rx) = mpsc::sync_channel(1);
        self.sender
            .try_send(Call {
                command,
                reply: tx,
                deadline: Instant::now() + Duration::from_secs(3),
            })
            .map_err(|_| Error::Busy)?;
        match rx
            .recv_timeout(Duration::from_secs(4))
            .map_err(|_| Error::Backend)??
        {
            UserDesktopResult::Failed { code } => Err(match code.as_str() {
                "Unsupported" => Error::Unsupported,
                "Unauthorized" => Error::Unauthorized,
                "Stale" => Error::Stale,
                "Busy" => Error::Busy,
                "Limit" => Error::Limit,
                "Invalid" => Error::Invalid,
                _ => Error::Backend,
            }),
            value => Ok(value),
        }
    }
}
async fn proxy_worker(connector: Connector, mut calls: tokio::sync::mpsc::Receiver<Call>) {
    let (stream, initial) = loop {
        let Some(call) = calls.recv().await else {
            return;
        };
        match tokio::time::timeout(Duration::from_secs(1), connector()).await {
            Ok(Ok(stream)) => break (stream, call),
            _ => {
                let _ = call.reply.send(Err(Error::Unsupported));
            }
        }
    };
    let (mut input, mut output) = tokio::io::split(stream);
    let mut reader = Reader::default();
    let mut pending = BTreeMap::<u64, Call>::new();
    let mut next = 0u64;
    let mut first_request = true;
    let mut first_response = true;
    let mut heartbeat = tokio::time::interval(Duration::from_secs(1));
    let mut initial = Some(initial);
    let outcome: Result<(), Error> = async {
        loop {
            if let Some(call) = initial.take() {
                next = next.checked_add(1).filter(|id| *id <= 9_007_199_254_740_991).ok_or(Error::Limit)?;
                if Instant::now() >= call.deadline { let _=call.reply.send(Err(Error::Stale)); continue; }
                let request = UserDesktopRequest { request_id: next, command: call.command.clone() }.encode();
                let message = if first_request { first_request=false; Message::RequestStreamStart { proc_id: ipc::ProcId::HostUserDesktop.as_u64(), payload: Some(request), stream_id: STREAM } }
                    else { Message::RequestStreamChunk { payload: request, stream_id: STREAM } };
                pending.insert(next, call);
                write(&mut output, message, REQUEST_LIMIT).await?;
            }
            tokio::select! {
                call = calls.recv(), if pending.len() < 16 => { match call { Some(call) => initial=Some(call), None => return Ok(()) } },
                response = reader.read(&mut input, RESPONSE_LIMIT) => {
                    let payload = match response? {
                        Message::ResponseStreamStart { payload: Some(p), stream_id: STREAM } if first_response => p,
                        Message::ResponseStreamChunk { payload: p, stream_id: STREAM } if !first_response => p,
                        _ => return Err(Error::Invalid),
                    };
                    first_response=false;
                    let response = UserDesktopResponse::decode(&payload).map_err(|_| Error::Invalid)?;
                    if response.request_id == 0 { if !matches!(response.result, UserDesktopResult::Done) {return Err(Error::Invalid);} continue; }
                    let call = pending.remove(&response.request_id).ok_or(Error::Stale)?;
                    if Instant::now() >= call.deadline || call.reply.send(Ok(response.result)).is_err() { return Err(Error::Stale); }
                },
                _ = heartbeat.tick() => {
                    if pending.values().any(|c| Instant::now() >= c.deadline) { return Err(Error::Stale); }
                    write(&mut output, Message::RequestStreamChunk { payload: UserDesktopRequest { request_id:0, command:UserDesktopCommand::Ping }.encode(), stream_id:STREAM }, REQUEST_LIMIT).await?;
                }
            }
        }
    }.await;
    let _ = outcome;
    drop(input);
    drop(output);
    for (_, call) in pending {
        let _ = call.reply.send(Err(Error::Backend));
    }
    // Closing receiver rejects further calls; never replay input or reconnect implicitly.
}
impl Backend for Proxy {
    fn capabilities(&self) -> DesktopCapabilities {
        match self.call(UserDesktopCommand::Capabilities) {
            Ok(UserDesktopResult::Capabilities { value }) => DesktopCapabilities::decode(&value.encode()).unwrap_or_default(),
            _ => DesktopCapabilities { profile:PROFILE, capture:DesktopAvailability::Unsupported, input:DesktopAvailability::Unsupported, codecs:vec![], composition:false, relative_pointer:false, max_viewports:MAX_VIEWPORTS as u64,max_input_frame_bytes:MAX_FRAME as u64,max_input_stream_bytes:MAX_STREAM as u64,reason:Some("Authenticated desktop helper unavailable; a lost helper channel requires daemon restart".into()),feedback:None,wheel_units:None,physical_keys:None },
        }
    }
    fn displays(&self) -> Vec<DesktopDisplay> {
        match self.call(UserDesktopCommand::Displays) {
            Ok(UserDesktopResult::Displays { values }) => values
                .into_iter()
                .filter_map(|d| DesktopDisplay::decode(&d.encode()).ok())
                .collect(),
            _ => vec![],
        }
    }
    fn cursor(&self, layout_epoch: u64) -> Option<DesktopEvent> {
        match self.call(UserDesktopCommand::Cursor { layout_epoch }) {
            Ok(UserDesktopResult::Cursor { value }) => {
                value.and_then(|d| DesktopEvent::decode(&d.encode()).ok())
            }
            _ => None,
        }
    }
    fn input(&self, event: &DesktopInputEvent) -> Result<(), Error> {
        self.input_viewport(event, None)
    }
    fn input_viewport(
        &self,
        event: &DesktopInputEvent,
        viewport: Option<&DesktopViewport>,
    ) -> Result<(), Error> {
        match self.call(UserDesktopCommand::Input {
            event: ipc::DesktopInputEvent::decode(&event.encode()).map_err(|_| Error::Invalid)?,
            viewport: viewport
                .map(|v| ipc::DesktopViewport::decode(&v.encode()).map_err(|_| Error::Invalid))
                .transpose()?,
        })? {
            UserDesktopResult::Done => Ok(()),
            _ => Err(Error::Backend),
        }
    }
    fn end_track(&self, track: &DesktopTrack) -> Result<(), Error> {
        match self.call(UserDesktopCommand::EndTrack {
            track: ipc::DesktopTrack::decode(&track.encode()).map_err(|_| Error::Invalid)?,
        })? {
            UserDesktopResult::Done => Ok(()),
            _ => Err(Error::Backend),
        }
    }
    fn group(&self, track: &DesktopTrack) -> Result<Vec<EncodedFrame>, Error> {
        match self.call(UserDesktopCommand::Group {
            track: ipc::DesktopTrack::decode(&track.encode()).map_err(|_| Error::Invalid)?,
        })? {
            UserDesktopResult::Group { frames } => Ok(frames
                .into_iter()
                .map(|f| EncodedFrame::new(f.timestamp_micros, f.keyframe, f.data))
                .collect()),
            _ => Err(Error::Backend),
        }
    }
    fn keyboard_mode_supported(&self, mode: DesktopKeyboardMode) -> bool {
        mode == DesktopKeyboardMode::Physical
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::{
        Mutex,
        atomic::{AtomicUsize, Ordering},
    };
    #[derive(Default)]
    struct Fake {
        inputs: Mutex<Vec<DesktopInputEvent>>,
        stopped: AtomicUsize,
    }
    impl Backend for Fake {
        fn capabilities(&self) -> DesktopCapabilities {
            DesktopCapabilities {
                capture: DesktopAvailability::Available,
                input: DesktopAvailability::Available,
                ..Default::default()
            }
        }
        fn displays(&self) -> Vec<DesktopDisplay> {
            vec![]
        }
        fn input(&self, event: &DesktopInputEvent) -> Result<(), Error> {
            self.inputs.lock().unwrap().push(event.clone());
            Ok(())
        }
        fn group(&self, _: &DesktopTrack) -> Result<Vec<EncodedFrame>, Error> {
            std::thread::sleep(Duration::from_millis(100));
            Ok(vec![EncodedFrame::new(1, true, vec![1, 2, 3])])
        }
        fn end_track(&self, _: &DesktopTrack) -> Result<(), Error> {
            self.stopped.fetch_add(1, Ordering::SeqCst);
            Ok(())
        }
    }
    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn proxy_multiplexes_media_and_releases_on_parent_shutdown_without_reconnect() {
        let (client, server) = tokio::io::duplex(8192);
        let backend = Arc::new(Fake::default());
        let native = backend.clone();
        let (stop_tx, stop_rx) = tokio::sync::oneshot::channel();
        let task = tokio::spawn(serve_until(server, native, async {
            let _ = stop_rx.await;
        }));
        let client = Arc::new(Mutex::new(Some(client)));
        let attempts = Arc::new(AtomicUsize::new(0));
        let count = attempts.clone();
        let proxy = Arc::new(Proxy::new(Arc::new(move || {
            count.fetch_add(1, Ordering::SeqCst);
            let stream = client.lock().unwrap().take();
            Box::pin(async move {
                stream
                    .map(|s| Box::new(s) as Connection)
                    .ok_or(Error::Backend)
            })
        })));
        let p = proxy.clone();
        tokio::task::spawn_blocking(move || {
            assert_eq!(p.capabilities().capture, DesktopAvailability::Available);
            p.input(&DesktopInputEvent::PhysicalKey {
                usage: 4,
                down: true,
                repeat: false,
            })
            .unwrap();
        })
        .await
        .unwrap();
        let p = proxy.clone();
        let group = tokio::task::spawn_blocking(move || {
            p.group(&DesktopTrack {
                track_id: 1,
                codec_epoch: 1,
                ..Default::default()
            })
        });
        let p = proxy.clone();
        tokio::task::spawn_blocking(move || {
            p.input(&DesktopInputEvent::PhysicalKey {
                usage: 4,
                down: false,
                repeat: false,
            })
            .unwrap()
        })
        .await
        .unwrap();
        assert_eq!(group.await.unwrap().unwrap()[0].data, vec![1, 2, 3]);
        stop_tx.send(()).unwrap();
        assert!(task.await.unwrap().is_err());
        assert!(matches!(
            backend.inputs.lock().unwrap().last(),
            Some(DesktopInputEvent::ReleaseAll)
        ));
        assert_eq!(backend.stopped.load(Ordering::SeqCst), 1);
        let p = proxy.clone();
        tokio::task::spawn_blocking(move || {
            assert!(p.input(&DesktopInputEvent::ReleaseAll).is_err())
        })
        .await
        .unwrap();
        assert_eq!(attempts.load(Ordering::SeqCst), 1);
    }
    #[tokio::test]
    async fn duplicate_request_and_oversized_frame_retire_the_session() {
        for oversized in [false, true] {
            let (mut client, server) = tokio::io::duplex(REQUEST_LIMIT * 2);
            let backend = Arc::new(Fake::default());
            let task = tokio::spawn(serve(server, backend.clone()));
            let payload = UserDesktopRequest {
                request_id: 1,
                command: UserDesktopCommand::Input {
                    event: ipc::DesktopInputEvent::PhysicalKey {
                        usage: 4,
                        down: true,
                        repeat: false,
                    },
                    viewport: None,
                },
            }
            .encode();
            write(
                &mut client,
                Message::RequestStreamStart {
                    proc_id: ipc::ProcId::HostUserDesktop.as_u64(),
                    payload: Some(payload.clone()),
                    stream_id: STREAM,
                },
                REQUEST_LIMIT,
            )
            .await
            .unwrap();
            let mut reader = Reader::default();
            reader.read(&mut client, RESPONSE_LIMIT).await.unwrap();
            if oversized {
                client
                    .write_all(&vec![0x9f; REQUEST_LIMIT + 1])
                    .await
                    .unwrap();
            } else {
                write(
                    &mut client,
                    Message::RequestStreamChunk {
                        payload,
                        stream_id: STREAM,
                    },
                    REQUEST_LIMIT,
                )
                .await
                .unwrap();
            }
            assert!(
                tokio::time::timeout(Duration::from_secs(2), task)
                    .await
                    .unwrap()
                    .unwrap()
                    .is_err()
            );
            assert_eq!(backend.inputs.lock().unwrap().len(), 2);
            assert!(matches!(
                backend.inputs.lock().unwrap().last(),
                Some(DesktopInputEvent::ReleaseAll)
            ));
        }
    }
}
