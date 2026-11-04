//! Bounded private user-session channel. OS peer authentication belongs to connectors.
//! Recovery is explicit and generation fenced; only uncertain input releases cross generations.
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
        UserDesktopCommand::RecoverInput { keys, buttons } => {
            if keys.len() > 228
                || buttons.len() > 5
                || keys.iter().any(|k| !(4..=231).contains(k))
                || buttons.iter().any(|b| !(1..=5).contains(b))
            {
                return Err(Error::Invalid);
            }
            backend.recover_input(&keys, &buttons)?;
            UserDesktopResult::Done
        }
        UserDesktopCommand::ProbeVideo { track } => {
            let track = DesktopTrack::decode(&track.encode()).map_err(|_| Error::Invalid)?;
            if !crate::desktop::validate_video_probe(&track) {
                return Err(Error::Invalid);
            }
            UserDesktopResult::VideoProbe {
                verification: ipc::DesktopQualityVerification::decode(
                    &backend.probe_video(&track).encode(),
                )
                .map_err(|_| Error::Invalid)?,
            }
        }
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
        UserDesktopCommand::StreamGroup { .. } => return Err(Error::Unsupported),
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
    let mut probes = tokio::task::JoinSet::new();
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
            let initial_request = first;
            first = false;
            let request = UserDesktopRequest::decode(&payload).map_err(|_| Error::Invalid)?;
            if matches!(request.command, UserDesktopCommand::RecoverInput { .. }) && !initial_request { return Err(Error::Invalid); }
            if request.request_id == 0 {
                if !matches!(request.command, UserDesktopCommand::Ping) { return Err(Error::Invalid); }
                tx.send(UserDesktopResponse { request_id: 0, result: UserDesktopResult::Done }).await.map_err(|_| Error::Backend)?;
                continue;
            }
            if request.request_id <= last { return Err(Error::Stale); }
            last = request.request_id;
            while groups.try_join_next().is_some() {}
            while probes.try_join_next().is_some() {}
            if let UserDesktopCommand::StreamGroup { track, .. } = &request.command {
                let key = (track.track_id, track.codec_epoch);
                if tracks.len() >= 32 && !tracks.contains_key(&key) { return Err(Error::Limit); }
                let entry = tracks.entry(key).or_insert_with(|| (track.clone(), Arc::new(tokio::sync::Mutex::new(()))));
                if entry.0 != *track { return Err(Error::Stale); }
                let guard = entry.1.clone().try_lock_owned().map_err(|_| Error::Busy)?;
                if groups.len() >= 8 { return Err(Error::Busy); }
                let backend = backend.clone(); let tx = tx.clone();
                groups.spawn(async move {
                    let frames = tx.clone();
                    let response = tokio::task::spawn_blocking(move || {
                        let _guard = guard;
                        if let UserDesktopCommand::StreamGroup { track, refresh } = request.command {
                            let track = DesktopTrack::decode(&track.encode()).map_err(|_| Error::Invalid);
                            let mut count=0; let mut bytes=0usize;
                            result(track.and_then(|track| backend.stream_group_with_refresh(&track, refresh, &mut |f| {
                                count+=1; bytes=bytes.checked_add(f.data.len()).ok_or(Error::Limit)?;
                                if count>240 || f.data.len()>4*1024*1024 || bytes>16*1024*1024 { return Err(Error::Limit); }
                                frames.blocking_send(UserDesktopResponse {request_id:request.request_id,result:UserDesktopResult::GroupFrame {frame:UserDesktopFrame {timestamp_micros:f.timestamp_micros,keyframe:f.keyframe,data:f.data}}}).map_err(|_|Error::Stale)
                            }).map(|_|UserDesktopResult::Done)))
                        } else { result(execute(backend.as_ref(), request.command)) }
                    }).await.unwrap_or(UserDesktopResult::Failed { code: "Backend".into() });
                    let _ = tx.send(UserDesktopResponse { request_id: request.request_id, result: response }).await;
                });
            } else if matches!(request.command, UserDesktopCommand::ProbeVideo { .. }) {
                // A bounded synthetic probe must not block the IPC reader/input channel.
                if !probes.is_empty() {
                    tx.send(UserDesktopResponse { request_id: request.request_id, result: result(Err(Error::Busy)) }).await.map_err(|_| Error::Backend)?;
                    continue;
                }
                let backend = backend.clone(); let tx = tx.clone();
                probes.spawn(async move {
                    let response = tokio::task::spawn_blocking(move || result(execute(backend.as_ref(), request.command))).await
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
    while probes.join_next().await.is_some() {}
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
struct Replies {
    frames: mpsc::SyncSender<Result<UserDesktopResult, Error>>,
    terminal: Option<mpsc::SyncSender<Result<UserDesktopResult, Error>>>,
}
impl Replies {
    fn send(
        &self,
        value: Result<UserDesktopResult, Error>,
    ) -> Result<(), mpsc::SendError<Result<UserDesktopResult, Error>>> {
        self.terminal.as_ref().unwrap_or(&self.frames).send(value)
    }
    fn try_send(
        &self,
        value: Result<UserDesktopResult, Error>,
    ) -> Result<(), mpsc::TrySendError<Result<UserDesktopResult, Error>>> {
        self.terminal
            .as_ref()
            .unwrap_or(&self.frames)
            .try_send(value)
    }
}
struct Call {
    command: UserDesktopCommand,
    reply: Replies,
    deadline: Instant,
    generation: u64,
    recovery: bool,
    minimum_codec_epoch: u64,
    frames: usize,
    bytes: usize,
    overflow: bool,
}
/// Lazy connection; neither construction nor GUI startup captures the desktop.
pub struct Proxy {
    sender: tokio::sync::mpsc::Sender<Call>,
    generation: Arc<std::sync::atomic::AtomicU64>,
    ready: Arc<std::sync::atomic::AtomicBool>,
    minimum_codec_epoch: Arc<std::sync::atomic::AtomicU64>,
    recovery: std::sync::Mutex<()>,
    uncertain_captures: std::sync::Mutex<Vec<(u64, crate::maintenance::WorkGuard)>>,
}
impl Proxy {
    pub fn new(connector: Connector) -> Self {
        let (sender, receiver) = tokio::sync::mpsc::channel(16);
        let generation = Arc::new(std::sync::atomic::AtomicU64::new(0));
        let ready = Arc::new(std::sync::atomic::AtomicBool::new(false));
        let minimum_codec_epoch = Arc::new(std::sync::atomic::AtomicU64::new(0));
        let worker_minimum = minimum_codec_epoch.clone();
        let worker_generation = generation.clone();
        let worker_ready = ready.clone();
        std::thread::spawn(move || {
            if let Ok(runtime) = tokio::runtime::Builder::new_current_thread()
                .enable_all()
                .build()
            {
                runtime.block_on(proxy_worker(
                    connector,
                    receiver,
                    worker_generation,
                    worker_ready,
                    worker_minimum,
                ));
            }
        });
        Self {
            sender,
            generation,
            ready,
            minimum_codec_epoch,
            recovery: Default::default(),
            uncertain_captures: Default::default(),
        }
    }
    fn call(&self, command: UserDesktopCommand) -> Result<UserDesktopResult, Error> {
        self.call_inner(command, false, 0)
    }
    fn call_inner(
        &self,
        command: UserDesktopCommand,
        recovery: bool,
        minimum_codec_epoch: u64,
    ) -> Result<UserDesktopResult, Error> {
        let (tx, rx) = mpsc::sync_channel(1);
        self.sender
            .try_send(Call {
                command,
                reply: Replies {
                    frames: tx,
                    terminal: None,
                },
                deadline: Instant::now() + Duration::from_secs(3),
                generation: self.generation(),
                recovery,
                minimum_codec_epoch,
                frames: 0,
                bytes: 0,
                overflow: false,
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
#[derive(Default)]
struct Ledger {
    keys: BTreeMap<u64, u64>,
    buttons: BTreeMap<u64, u64>,
}
impl Ledger {
    fn record(&mut self, command: &UserDesktopCommand, id: u64) {
        if let UserDesktopCommand::Input { event, .. } = command {
            match event {
                ipc::DesktopInputEvent::PhysicalKey {
                    usage, down: true, ..
                } => {
                    self.keys.insert(*usage, id);
                }
                ipc::DesktopInputEvent::Button {
                    button, down: true, ..
                } => {
                    self.buttons.insert(*button, id);
                }
                _ => (),
            }
        }
    }
    fn ack(&mut self, command: &UserDesktopCommand, id: u64) {
        match command {
            UserDesktopCommand::RecoverInput { .. } => {
                self.keys.clear();
                self.buttons.clear();
            }
            UserDesktopCommand::Input { event, .. } => match event {
                ipc::DesktopInputEvent::PhysicalKey {
                    usage, down: false, ..
                } => self.keys.retain(|k, n| k != usage || *n > id),
                ipc::DesktopInputEvent::Button {
                    button,
                    down: false,
                    ..
                } => self.buttons.retain(|k, n| k != button || *n > id),
                ipc::DesktopInputEvent::ReleaseAll => {
                    self.keys.retain(|_, n| *n > id);
                    self.buttons.retain(|_, n| *n > id);
                }
                _ => (),
            },
            _ => (),
        }
    }
}
async fn proxy_worker(
    connector: Connector,
    mut calls: tokio::sync::mpsc::Receiver<Call>,
    generation: Arc<std::sync::atomic::AtomicU64>,
    ready: Arc<std::sync::atomic::AtomicBool>,
    minimum_codec_epoch: Arc<std::sync::atomic::AtomicU64>,
) {
    let mut ledger = Ledger::default();
    loop {
        let (stream, initial) = loop {
            let Some(mut call) = calls.recv().await else {
                return;
            };
            let current = generation.load(std::sync::atomic::Ordering::SeqCst);
            if call.generation != current || (current != 0 && !call.recovery) {
                let _ = call.reply.send(Err(Error::Stale));
                continue;
            }
            if call.recovery {
                call.command = UserDesktopCommand::RecoverInput {
                    keys: ledger.keys.keys().copied().collect(),
                    buttons: ledger.buttons.keys().copied().collect(),
                };
            }
            match tokio::time::timeout(Duration::from_secs(1), connector()).await {
                Ok(Ok(stream)) => break (stream, call),
                Ok(Err(Error::Unauthorized)) => {
                    let _ = call.reply.send(Err(Error::HelperAuthentication));
                }
                Ok(Err(error)) if error != Error::Unsupported => {
                    let _ = call.reply.send(Err(error));
                }
                _ => {
                    let _ = call.reply.send(Err(Error::HelperUnavailable));
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
                if call.generation != generation.load(std::sync::atomic::Ordering::SeqCst) { let _ = call.reply.send(Err(Error::Stale)); continue; }
                if !ready.load(std::sync::atomic::Ordering::SeqCst) && call.generation != 0 && !call.recovery {
                    let _=call.reply.send(Err(Error::Stale)); continue;
                }
                match &call.command {
                    UserDesktopCommand::StreamGroup { track, .. } | UserDesktopCommand::EndTrack { track }
                        if track.codec_epoch < minimum_codec_epoch.load(std::sync::atomic::Ordering::SeqCst) => {
                            let result = if matches!(call.command, UserDesktopCommand::EndTrack { .. }) { Ok(UserDesktopResult::Done) } else { Err(Error::Stale) };
                            let _=call.reply.send(result); continue;
                        },
                    _=>(),
                }
                next = next.checked_add(1).filter(|id| *id <= 9_007_199_254_740_991).ok_or(Error::Limit)?;
                if Instant::now() >= call.deadline { let _=call.reply.send(Err(Error::Stale)); continue; }
                ledger.record(&call.command, next);
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
                    if let UserDesktopResult::GroupFrame { frame } = &response.result {
                        let call=pending.get_mut(&response.request_id).ok_or(Error::Stale)?;
                        if !matches!(call.command,UserDesktopCommand::StreamGroup {..}) || Instant::now()>=call.deadline {return Err(Error::Stale);}
                        call.frames+=1;call.bytes=call.bytes.checked_add(frame.data.len()).ok_or(Error::Limit)?;
                        if call.frames>240 || frame.data.len()>4*1024*1024 || call.bytes>16*1024*1024 {return Err(Error::Limit);}
                        if !call.overflow && call.reply.frames.try_send(Ok(response.result)).is_err() {call.overflow=true;}
                        continue;
                    }
                    let call = pending.remove(&response.request_id).ok_or(Error::Stale)?;
                    if Instant::now() >= call.deadline { let _=call.reply.try_send(Err(Error::Stale)); return Err(Error::Stale); }
                    if matches!(call.command,UserDesktopCommand::StreamGroup {..}) {
                        let value=if call.overflow {Err(Error::Busy)} else {Ok(response.result)};
                        // A separate one-slot terminal channel cannot be starved by media frames.
                        let _=call.reply.try_send(value);continue;
                    }
                    if matches!(response.result, UserDesktopResult::Done) {
                        ledger.ack(&call.command, response.request_id);
                        if call.recovery { minimum_codec_epoch.store(call.minimum_codec_epoch, std::sync::atomic::Ordering::SeqCst); ready.store(true, std::sync::atomic::Ordering::SeqCst); }
                    } else if call.recovery { let _=call.reply.send(Err(Error::Backend)); return Err(Error::Backend); }
                    if call.generation == 0 && !call.recovery { ready.store(true, std::sync::atomic::Ordering::SeqCst); }
                    if call.reply.send(Ok(response.result)).is_err() { return Err(Error::Stale); }
                },
                _ = heartbeat.tick() => {
                    if pending.values().any(|c| Instant::now() >= c.deadline) { return Err(Error::Stale); }
                    write(&mut output, Message::RequestStreamChunk { payload: UserDesktopRequest { request_id:0, command:UserDesktopCommand::Ping }.encode(), stream_id:STREAM }, REQUEST_LIMIT).await?;
                }
            }
        }
    }.await;
        let _ = outcome;
        ready.store(false, std::sync::atomic::Ordering::SeqCst);
        generation.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
        drop(input);
        drop(output);
        for (_, call) in pending {
            let _ = call.reply.send(Err(Error::Backend));
        }
    }
}
impl Backend for Proxy {
    fn generation(&self) -> u64 {
        self.generation.load(std::sync::atomic::Ordering::SeqCst)
    }
    fn recover(&self, minimum_codec_epoch: u64) -> Result<u64, Error> {
        let _lock = self.recovery.lock().map_err(|_| Error::Backend)?;
        let expected = self.generation();
        if !self.ready.load(std::sync::atomic::Ordering::SeqCst) {
            match self.call_inner(
                UserDesktopCommand::RecoverInput {
                    keys: vec![],
                    buttons: vec![],
                },
                true,
                minimum_codec_epoch,
            )? {
                UserDesktopResult::Done => (),
                _ => return Err(Error::Backend),
            }
        }
        if self.generation() != expected || !self.ready.load(std::sync::atomic::Ordering::SeqCst) {
            return Err(Error::Backend);
        }
        self.uncertain_captures
            .lock()
            .map_err(|_| Error::Backend)?
            .retain(|(epoch, _)| {
                *epoch
                    >= self
                        .minimum_codec_epoch
                        .load(std::sync::atomic::Ordering::SeqCst)
            });
        Ok(expected)
    }
    fn retain_uncertain_capture(
        &self,
        track: &DesktopTrack,
        work: Option<crate::maintenance::WorkGuard>,
    ) {
        let _lock = self.recovery.lock().unwrap_or_else(|e| e.into_inner());
        if track.codec_epoch
            >= self
                .minimum_codec_epoch
                .load(std::sync::atomic::Ordering::SeqCst)
        {
            if let Some(work) = work {
                self.uncertain_captures
                    .lock()
                    .unwrap_or_else(|e| e.into_inner())
                    .push((track.codec_epoch, work));
            }
        }
    }

    fn probe_video(&self, track: &DesktopTrack) -> DesktopQualityVerification {
        if !crate::desktop::validate_video_probe(track) {
            return DesktopQualityVerification::Unsupported;
        }
        match self.call(UserDesktopCommand::ProbeVideo {
            track: ipc::DesktopTrack::decode(&track.encode()).unwrap(),
        }) {
            Ok(UserDesktopResult::VideoProbe { verification }) => {
                DesktopQualityVerification::decode(&verification.encode())
                    .unwrap_or(DesktopQualityVerification::Unknown)
            }
            _ => DesktopQualityVerification::Unknown,
        }
    }
    fn capabilities(&self) -> DesktopCapabilities {
        match self.call(UserDesktopCommand::Capabilities) {
            Ok(UserDesktopResult::Capabilities { value }) => DesktopCapabilities::decode(&value.encode()).unwrap_or_default(),
            _ => DesktopCapabilities { profile:PROFILE, capture:DesktopAvailability::Unsupported, input:DesktopAvailability::Unsupported, codecs:vec![], composition:false, relative_pointer:false, max_viewports:MAX_VIEWPORTS as u64,max_input_frame_bytes:MAX_FRAME as u64,max_input_stream_bytes:MAX_STREAM as u64,reason:Some("Authenticated desktop helper unavailable; waiting for authenticated helper recovery".into()),feedback:None,wheel_units:None,physical_keys:None },
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
        if track.codec_epoch
            < self
                .minimum_codec_epoch
                .load(std::sync::atomic::Ordering::SeqCst)
        {
            return Ok(());
        }
        match self.call(UserDesktopCommand::EndTrack {
            track: ipc::DesktopTrack::decode(&track.encode()).map_err(|_| Error::Invalid)?,
        })? {
            UserDesktopResult::Done => Ok(()),
            _ => Err(Error::Backend),
        }
    }
    fn stream_group(
        &self,
        track: &DesktopTrack,
        emit: &mut dyn FnMut(EncodedFrame) -> Result<(), Error>,
    ) -> Result<(), Error> {
        self.stream_group_with_refresh(track, false, emit)
    }
    fn stream_group_with_refresh(
        &self,
        track: &DesktopTrack,
        refresh: bool,
        emit: &mut dyn FnMut(EncodedFrame) -> Result<(), Error>,
    ) -> Result<(), Error> {
        if track.codec_epoch
            < self
                .minimum_codec_epoch
                .load(std::sync::atomic::Ordering::SeqCst)
        {
            return Err(Error::Stale);
        }
        let (tx, rx) = mpsc::sync_channel(2);
        let (done_tx, done_rx) = mpsc::sync_channel(1);
        self.sender
            .try_send(Call {
                command: UserDesktopCommand::StreamGroup {
                    refresh,
                    track: ipc::DesktopTrack::decode(&track.encode())
                        .map_err(|_| Error::Invalid)?,
                },
                reply: Replies {
                    frames: tx,
                    terminal: Some(done_tx),
                },
                deadline: Instant::now() + Duration::from_secs(3),
                generation: self.generation(),
                recovery: false,
                minimum_codec_epoch: 0,
                frames: 0,
                bytes: 0,
                overflow: false,
            })
            .map_err(|_| Error::Busy)?;
        let mut cancelled = None;
        loop {
            let response = match rx.recv_timeout(Duration::from_secs(4)) {
                Ok(value) => value?,
                Err(mpsc::RecvTimeoutError::Disconnected) => done_rx
                    .recv_timeout(Duration::from_secs(1))
                    .map_err(|_| Error::Backend)??,
                Err(mpsc::RecvTimeoutError::Timeout) => return Err(Error::Backend),
            };
            match response {
                UserDesktopResult::GroupFrame { frame } => {
                    if cancelled.is_none() {
                        cancelled = emit(EncodedFrame::new(
                            frame.timestamp_micros,
                            frame.keyframe,
                            frame.data,
                        ))
                        .err();
                    }
                }
                UserDesktopResult::Done => return cancelled.map_or(Ok(()), Err),
                UserDesktopResult::Failed { code } if code == "Busy" => return Err(Error::Busy),
                UserDesktopResult::Failed { .. } => return Err(Error::Backend),
                _ => return Err(Error::Invalid),
            }
            // Even after downstream cancellation retain this call until producer completion.
            // This keeps capture/update workload ownership alive; no frames or input replay.
        }
    }
    fn group(&self, track: &DesktopTrack) -> Result<Vec<EncodedFrame>, Error> {
        let mut frames = vec![];
        self.stream_group_with_refresh(track, false, &mut |f| {
            frames.push(f);
            Ok(())
        })?;
        Ok(frames)
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
    #[test]
    fn connector_errors_preserve_authentication_and_availability() {
        for (cause, expected) in [
            (Error::Unauthorized, Error::HelperAuthentication),
            (Error::Unsupported, Error::HelperUnavailable),
            (Error::Busy, Error::Busy),
        ] {
            let cause = Arc::new(Mutex::new(Some(cause)));
            let proxy = Proxy::new(Arc::new(move || {
                let cause = cause.lock().unwrap().take().unwrap();
                Box::pin(async move { Err(cause) })
            }));
            assert_eq!(proxy.recover(1), Err(expected));
        }
    }
    #[derive(Default)]
    struct Fake {
        inputs: Mutex<Vec<DesktopInputEvent>>,
        stopped: AtomicUsize,
        probe_pause: Mutex<
            Option<(
                tokio::sync::oneshot::Sender<()>,
                std::sync::mpsc::Receiver<()>,
            )>,
        >,
    }
    impl Backend for Fake {
        fn probe_video(&self, _: &DesktopTrack) -> DesktopQualityVerification {
            if let Some((started, release)) = self.probe_pause.lock().unwrap().take() {
                let _ = started.send(());
                let _ = release.recv();
            }
            DesktopQualityVerification::Unknown
        }
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

    struct Streaming {
        base: Fake,
        release: Mutex<Option<std::sync::mpsc::Receiver<()>>>,
        burst: bool,
    }
    impl Backend for Streaming {
        fn capabilities(&self) -> DesktopCapabilities {
            self.base.capabilities()
        }
        fn displays(&self) -> Vec<DesktopDisplay> {
            vec![]
        }
        fn input(&self, e: &DesktopInputEvent) -> Result<(), Error> {
            self.base.input(e)
        }
        fn end_track(&self, t: &DesktopTrack) -> Result<(), Error> {
            self.base.end_track(t)
        }
        fn stream_group(
            &self,
            _: &DesktopTrack,
            emit: &mut dyn FnMut(EncodedFrame) -> Result<(), Error>,
        ) -> Result<(), Error> {
            emit(EncodedFrame::new(1, true, vec![1]))?;
            if let Some(release) = self.release.lock().unwrap().take() {
                release.recv_timeout(Duration::from_secs(2)).unwrap();
            }
            for i in 2..if self.burst { 100 } else { 3 } {
                emit(EncodedFrame::new(i, false, vec![2]))?;
            }
            Ok(())
        }
    }
    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn incremental_frames_precede_completion_and_cancel_keeps_producer_owned() {
        let (release_tx, release_rx) = std::sync::mpsc::channel();
        let native = Arc::new(Streaming {
            base: Fake::default(),
            release: Mutex::new(Some(release_rx)),
            burst: false,
        });
        let (client, server) = tokio::io::duplex(8192);
        let (stop_tx, stop_rx) = tokio::sync::oneshot::channel();
        let server_native = native.clone();
        let server = tokio::spawn(serve_until(server, server_native, async {
            let _ = stop_rx.await;
        }));
        let slot = Arc::new(Mutex::new(Some(client)));
        let proxy = Arc::new(Proxy::new(Arc::new(move || {
            let stream = slot.lock().unwrap().take();
            Box::pin(async move {
                stream
                    .map(|s| Box::new(s) as Connection)
                    .ok_or(Error::Backend)
            })
        })));
        let (seen_tx, seen_rx) = tokio::sync::oneshot::channel();
        let p = proxy.clone();
        let capture = tokio::task::spawn_blocking(move || {
            let mut seen = Some(seen_tx);
            p.stream_group(
                &DesktopTrack {
                    track_id: 1,
                    codec_epoch: 1,
                    ..Default::default()
                },
                &mut |_| {
                    if let Some(tx) = seen.take() {
                        let _ = tx.send(());
                    }
                    Err(Error::Stale)
                },
            )
        });
        tokio::time::timeout(Duration::from_secs(1), seen_rx)
            .await
            .unwrap()
            .unwrap();
        assert!(
            !capture.is_finished(),
            "cancel must await producer completion"
        );
        let p = proxy.clone();
        tokio::task::spawn_blocking(move || p.input(&DesktopInputEvent::ReleaseAll))
            .await
            .unwrap()
            .unwrap();
        assert!(
            native
                .base
                .inputs
                .lock()
                .unwrap()
                .contains(&DesktopInputEvent::ReleaseAll)
        );
        release_tx.send(()).unwrap();
        assert_eq!(capture.await.unwrap(), Err(Error::Stale));
        stop_tx.send(()).unwrap();
        let _ = server.await;
    }
    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn slow_media_consumer_is_bounded_without_blocking_input_or_losing_terminal_error() {
        let native = Arc::new(Streaming {
            base: Fake::default(),
            release: Mutex::new(None),
            burst: true,
        });
        let (client, server) = tokio::io::duplex(8192);
        let (stop_tx, stop_rx) = tokio::sync::oneshot::channel();
        let server = tokio::spawn(serve_until(server, native, async {
            let _ = stop_rx.await;
        }));
        let slot = Arc::new(Mutex::new(Some(client)));
        let proxy = Arc::new(Proxy::new(Arc::new(move || {
            let stream = slot.lock().unwrap().take();
            Box::pin(async move {
                stream
                    .map(|s| Box::new(s) as Connection)
                    .ok_or(Error::Backend)
            })
        })));
        let p = proxy.clone();
        let result = tokio::task::spawn_blocking(move || {
            p.stream_group(
                &DesktopTrack {
                    track_id: 1,
                    codec_epoch: 1,
                    ..Default::default()
                },
                &mut |_| {
                    std::thread::sleep(Duration::from_millis(100));
                    Ok(())
                },
            )
        })
        .await
        .unwrap();
        assert_eq!(result, Err(Error::Busy));
        tokio::task::spawn_blocking(move || proxy.input(&DesktopInputEvent::ReleaseAll))
            .await
            .unwrap()
            .unwrap();
        stop_tx.send(()).unwrap();
        let _ = server.await;
    }
    #[test]
    fn synthetic_probe_bounds_and_unknown_backend_do_not_inject_input() {
        let backend = Fake::default();
        let mut track = DesktopTrack {
            viewport: DesktopViewport {
                width: 1280,
                height: 720,
                fps: 30,
                bitrate: 5_000_000,
                ..Default::default()
            },
            ..Default::default()
        };
        let command = |t: &DesktopTrack| UserDesktopCommand::ProbeVideo {
            track: ipc::DesktopTrack::decode(&t.encode()).unwrap(),
        };
        assert_eq!(
            execute(&backend, command(&track)).unwrap(),
            UserDesktopResult::VideoProbe {
                verification: ipc::DesktopQualityVerification::Unknown
            }
        );
        track.viewport.width = 8192;
        assert!(matches!(
            execute(&backend, command(&track)),
            Err(Error::Invalid)
        ));
        assert!(backend.inputs.lock().unwrap().is_empty());
        assert_eq!(backend.stopped.load(Ordering::SeqCst), 0);
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
    async fn busy_probe_does_not_block_input_or_consume_eight_media_slots() {
        tokio::time::timeout(Duration::from_secs(5), async {
            let (mut client, server) = tokio::io::duplex(65536);
            let backend = Arc::new(Fake::default());
            let (started, waiting) = tokio::sync::oneshot::channel();
            let (release, blocked) = std::sync::mpsc::channel();
            *backend.probe_pause.lock().unwrap() = Some((started, blocked));
            let task = tokio::spawn(serve(server, backend.clone()));
            let track = ipc::DesktopTrack {
                viewport: ipc::DesktopViewport {
                    width: 1280,
                    height: 720,
                    fps: 30,
                    bitrate: 5_000_000,
                    ..Default::default()
                },
                ..Default::default()
            };
            write(
                &mut client,
                Message::RequestStreamStart {
                    proc_id: ipc::ProcId::HostUserDesktop.as_u64(),
                    stream_id: STREAM,
                    payload: Some(
                        UserDesktopRequest {
                            request_id: 1,
                            command: UserDesktopCommand::ProbeVideo {
                                track: track.clone(),
                            },
                        }
                        .encode(),
                    ),
                },
                REQUEST_LIMIT,
            )
            .await
            .unwrap();
            waiting.await.unwrap();
            let mut commands = vec![
                UserDesktopCommand::ProbeVideo {
                    track: track.clone(),
                },
                UserDesktopCommand::Input {
                    event: ipc::DesktopInputEvent::PhysicalKey {
                        usage: 4,
                        down: true,
                        repeat: false,
                    },
                    viewport: None,
                },
            ];
            for id in 1..=8 {
                let mut track = track.clone();
                track.track_id = id;
                track.codec_epoch = 1;
                commands.push(UserDesktopCommand::StreamGroup {
                    track,
                    refresh: false,
                });
            }
            for (i, command) in commands.into_iter().enumerate() {
                write(
                    &mut client,
                    Message::RequestStreamChunk {
                        stream_id: STREAM,
                        payload: UserDesktopRequest {
                            request_id: i as u64 + 2,
                            command,
                        }
                        .encode(),
                    },
                    REQUEST_LIMIT,
                )
                .await
                .unwrap();
            }
            let mut reader = Reader::default();
            let mut replies = BTreeMap::new();
            for _ in 0..10 {
                let message = reader.read(&mut client, RESPONSE_LIMIT).await.unwrap();
                let payload = match message {
                    Message::ResponseStreamStart {
                        payload: Some(p), ..
                    }
                    | Message::ResponseStreamChunk { payload: p, .. } => p,
                    _ => panic!("unexpected IPC response"),
                };
                let response = UserDesktopResponse::decode(&payload).unwrap();
                replies.insert(response.request_id, response.result);
            }
            assert!(
                matches!(replies.get(&2),Some(UserDesktopResult::Failed {code}) if code=="Busy")
            );
            assert!(matches!(replies.get(&3), Some(UserDesktopResult::Done)));
            assert_eq!(backend.inputs.lock().unwrap().len(), 1);
            assert!(!replies.contains_key(&1));
            drop(release);
            let _ = reader.read(&mut client, RESPONSE_LIMIT).await.unwrap();
            drop(client);
            assert!(task.await.unwrap().is_err());
            assert_eq!(backend.stopped.load(Ordering::SeqCst), 8);
        })
        .await
        .unwrap();
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

#[cfg(test)]
#[path = "desktop_recovery_tests.rs"]
mod recovery_tests;
