use super::*;
use crate::desktop::{self, Credentials};
use rieul_daemon_core::generated::rpc::*;

pub(super) struct ConnectionCleanup {
    pub runtime: Arc<desktop::Runtime>,
    pub connection: u64,
}
impl Drop for ConnectionCleanup {
    fn drop(&mut self) {
        self.runtime.close(self.connection);
    }
}
struct AttachmentCleanup {
    runtime: Arc<desktop::Runtime>,
    id: String,
}
impl Drop for AttachmentCleanup {
    fn drop(&mut self) {
        self.runtime.remove(&self.id);
    }
}
async fn write_event(
    send: &mut web_transport_quinn::SendStream,
    message: ReqResMessage,
) -> Result<()> {
    tokio::time::timeout(Duration::from_secs(2), write_reqres_message(send, message))
        .await
        .context("desktop event backpressure timeout")?
}
pub(super) async fn expire(
    runtime: &Arc<desktop::Runtime>,
    path: &Path,
    records: &SharedClientCredentials,
) {
    if runtime.is_empty() {
        return;
    }
    if load_runtime_client_credentials(path, records)
        .await
        .is_err()
    {
        // A read failure must release input; an empty store fails all credentials.
        let mut current = records.lock().await;
        *current = ClientCredentials::default();
    }
    let auth = Auth(records.clone().lock_owned().await);
    let _ = runtime.mutate(|d| d.expire(&auth, now_ms()));
}
struct Auth(tokio::sync::OwnedMutexGuard<ClientCredentials>);
impl Credentials for Auth {
    fn valid(&self, client: &str, _: u64) -> bool {
        self.0
            .clients
            .iter()
            .any(|r| r.client_id == client && r.expires_at_unix > now_unix())
    }
}
fn now_ms() -> u64 {
    static START: std::sync::OnceLock<std::time::Instant> = std::sync::OnceLock::new();
    START
        .get_or_init(std::time::Instant::now)
        .elapsed()
        .as_millis() as u64
}
fn failure(proc: ProcId, e: desktop::Error, stream: bool) -> ReqResMessage {
    let code = match e {
        desktop::Error::Unauthorized => "permission_denied",
        desktop::Error::NotFound => "not_found",
        desktop::Error::Busy => "busy",
        desktop::Error::Stale => "stale_epoch",
        desktop::Error::Invalid => "invalid_configuration",
        desktop::Error::Unsupported => "unsupported",
        desktop::Error::Limit => "limit_exceeded",
        desktop::Error::Backend => "failed",
    };
    if stream {
        stream_error_message(proc.as_u64(), code, &format!("Desktop: {e:?}"))
    } else {
        error_message(proc.as_u64(), code, &format!("Desktop: {e:?}"))
    }
}
impl HostRpcHandler {
    async fn desktop_auth(&self) -> Result<(Auth, u64, String), desktop::Error> {
        let state = self.session_state.lock().await;
        let client = state
            .authenticated_client_id
            .clone()
            .ok_or(desktop::Error::Unauthorized)?;
        let connection = state.session_id;
        drop(state);
        load_runtime_client_credentials(&self.credentials_path, &self.client_credentials)
            .await
            .map_err(|_| desktop::Error::Unauthorized)?;
        let auth = Auth(self.client_credentials.clone().lock_owned().await);
        // Expire all invalid attachments, even if the caller itself is revoked.
        self.desktop.mutate(|d| d.expire(&auth, now_ms()))?;
        if !auth.valid(&client, now_ms()) {
            return Err(desktop::Error::Unauthorized);
        }
        Ok((auth, connection, client))
    }
    pub(super) fn get_desktop_capabilities_rpc<'a>(
        &'a mut self,
        _: (),
    ) -> RpcHandlerFuture<'a, Result<UnaryRpcOutcome>> {
        Box::pin(async move {
            match self.desktop_auth().await {
                Ok(_) => {
                    Ok(RpcResponse::GetDesktopCapabilities(self.desktop.capabilities()).into())
                }
                Err(e) => Ok(UnaryRpcOutcome::Message(failure(
                    ProcId::GetDesktopCapabilities,
                    e,
                    false,
                ))),
            }
        })
    }
    pub(super) fn attach_desktop_rpc<'a>(
        &'a mut self,
        request: AttachDesktopReq,
    ) -> RpcHandlerFuture<'a, Result<()>> {
        Box::pin(async move {
            let send = self.response_stream();
            let mut send = send.lock().await;
            let (auth, connection, client) = match self.desktop_auth().await {
                Ok(a) => a,
                Err(e) => {
                    write_event(&mut send, failure(ProcId::AttachDesktop, e, true)).await?;
                    return Ok(());
                }
            };
            let mut changed = self.desktop.changed.subscribe();
            let attached = match self
                .desktop
                .attach(&auth, connection, &client, now_ms(), &request)
            {
                Ok(a) => a,
                Err(e) => {
                    write_event(&mut send, failure(ProcId::AttachDesktop, e, true)).await?;
                    return Ok(());
                }
            };
            drop(auth);
            let DesktopEvent::Attached {
                ref attach_id,
                ref control,
                ..
            } = attached
            else {
                unreachable!()
            };
            let id = attach_id.clone();
            let mut previous = control.clone();
            let _cleanup = AttachmentCleanup {
                runtime: self.desktop.clone(),
                id: id.clone(),
            };
            write_event(&mut send, stream_start_payload_message(attached.encode())).await?;
            let mut media = tokio::task::JoinSet::new();
            let mut configuration = None;
            let mut tick = tokio::time::interval(Duration::from_millis(100));
            loop {
                tokio::select! {
                    _ = send.stopped() => return Ok(()),
                    _ = changed.changed() => {},
                    _ = tick.tick() => { if self.desktop_auth().await.is_err() { return Ok(()); } },
                }
                if !self.desktop.has(&id) {
                    return Ok(());
                }
                let next = self.desktop.configuration(&id);
                if next != configuration {
                    media.abort_all();
                    if let Some(next) = &next {
                        write_event(
                            &mut send,
                            stream_chunk_payload_message(
                                DesktopEvent::Configured {
                                    configuration: next.clone(),
                                }
                                .encode(),
                            ),
                        )
                        .await?;
                        if let Some(session) = &self.session {
                            for track in &next.tracks {
                                media.spawn(stream_media(
                                    self.desktop.clone(),
                                    session.clone(),
                                    id.clone(),
                                    next.layout_epoch,
                                    track.clone(),
                                ));
                            }
                        }
                    }
                    configuration = next;
                }
                let current = self
                    .desktop
                    .control()
                    .map_err(|e| anyhow::anyhow!("{e:?}"))?;
                if current != previous {
                    write_event(
                        &mut send,
                        stream_chunk_payload_message(
                            DesktopEvent::Control {
                                control: current.clone(),
                            }
                            .encode(),
                        ),
                    )
                    .await?;
                    previous = current;
                }
            }
        })
    }
    pub(super) fn set_desktop_control_rpc<'a>(
        &'a mut self,
        request: SetDesktopControlReq,
    ) -> RpcHandlerFuture<'a, Result<UnaryRpcOutcome>> {
        Box::pin(async move {
            if request.action != DesktopControlAction::Release
                && self.desktop.capabilities().input != DesktopAvailability::Available
            {
                return Ok(UnaryRpcOutcome::Message(failure(
                    ProcId::SetDesktopControl,
                    desktop::Error::Unsupported,
                    false,
                )));
            }
            let result = match self.desktop_auth().await {
                Ok((auth, c, _)) => self
                    .desktop
                    .mutate(|d| {
                        d.set_control(&auth, c, &request.attach_id, now_ms(), request.action)
                    })
                    .and_then(|_| self.desktop.control()),
                Err(e) => Err(e),
            };
            Ok(match result {
                Ok(c) => RpcResponse::SetDesktopControl(c).into(),
                Err(e) => UnaryRpcOutcome::Message(failure(ProcId::SetDesktopControl, e, false)),
            })
        })
    }
    pub(super) fn renew_desktop_lease_rpc<'a>(
        &'a mut self,
        request: DesktopAttachRef,
    ) -> RpcHandlerFuture<'a, Result<UnaryRpcOutcome>> {
        Box::pin(async move {
            let result = match self.desktop_auth().await {
                Ok((auth, c, _)) => self
                    .desktop
                    .mutate(|d| d.renew(&auth, c, &request.attach_id, now_ms())),
                Err(e) => Err(e),
            };
            Ok(match result {
                Ok(()) => RpcResponse::RenewDesktopLease(DesktopLease {
                    attach_id: request.attach_id,
                    remaining_ms: desktop::LEASE_MS,
                })
                .into(),
                Err(e) => UnaryRpcOutcome::Message(failure(ProcId::RenewDesktopLease, e, false)),
            })
        })
    }
    pub(super) fn detach_desktop_rpc<'a>(
        &'a mut self,
        request: DesktopAttachRef,
    ) -> RpcHandlerFuture<'a, Result<UnaryRpcOutcome>> {
        Box::pin(async move {
            let result = match self.desktop_auth().await {
                Ok((auth, c, _)) => self
                    .desktop
                    .mutate(|d| d.detach(&auth, c, &request.attach_id, now_ms())),
                Err(e) => Err(e),
            };
            Ok(match result {
                Ok(()) => RpcResponse::DetachDesktop.into(),
                Err(e) => UnaryRpcOutcome::Message(failure(ProcId::DetachDesktop, e, false)),
            })
        })
    }
    pub(super) fn configure_desktop_viewports_rpc<'a>(
        &'a mut self,
        request: ConfigureDesktopViewportsReq,
    ) -> RpcHandlerFuture<'a, Result<UnaryRpcOutcome>> {
        Box::pin(async move {
            let result = match self.desktop_auth().await {
                Ok((auth, c, _)) => self.desktop.configure(&auth, c, now_ms(), request),
                Err(e) => Err(e),
            };
            Ok(match result {
                Ok(configuration) => RpcResponse::ConfigureDesktopViewports(configuration).into(),
                Err(e) => {
                    UnaryRpcOutcome::Message(failure(ProcId::ConfigureDesktopViewports, e, false))
                }
            })
        })
    }
    pub(super) fn write_desktop_input_rpc<'a>(
        &'a mut self,
        first: DesktopInputFrame,
    ) -> RpcHandlerFuture<'a, Result<Vec<ReqResMessage>>> {
        Box::pin(async move {
            let proc = ProcId::WriteDesktopInput;
            let (auth, c, _) = match self.desktop_auth().await {
                Ok(a) => a,
                Err(e) => return Ok(vec![failure(proc, e, false)]),
            };
            // Validate ownership before reserving a stream, including a first release event.
            if let Err(e) = self
                .desktop
                .mutate(|d| d.authorize(&auth, c, &first.attach_id, now_ms()))
            {
                return Ok(vec![failure(proc, e, false)]);
            }
            drop(auth);
            let mut guard = match self.desktop.begin_input(&first.attach_id) {
                Ok(g) => g,
                Err(e) => return Ok(vec![failure(proc, e, false)]),
            };
            let id = first.attach_id.clone();
            let mut budget = desktop::InputStreamBudget::default();
            let mut frame = first;
            let mut last;
            loop {
                if frame.attach_id != id {
                    return Ok(vec![failure(proc, desktop::Error::Invalid, false)]);
                }
                if budget.decode(&frame.encode()).is_err() {
                    return Ok(vec![failure(proc, desktop::Error::Limit, false)]);
                }
                let (_auth, c, _) = match self.desktop_auth().await {
                    Ok(a) => a,
                    Err(e) => return Ok(vec![failure(proc, e, false)]),
                };
                last = frame.sequence;
                let result = self.desktop.mutate(|d| d.input(&_auth, c, now_ms(), frame));
                drop(_auth);
                if let Err(e) = result {
                    return Ok(vec![failure(proc, e, false)]);
                }
                let next =
                    tokio::time::timeout(Duration::from_secs(5), self.next_request_stream_chunk())
                        .await;
                match next {
                    Ok(Ok(None)) => break,
                    Ok(Ok(Some(payload))) => {
                        if payload.len() > desktop::MAX_FRAME {
                            return Ok(vec![failure(proc, desktop::Error::Limit, false)]);
                        }
                        frame = match DesktopInputFrame::decode(&payload) {
                            Ok(f) => f,
                            Err(_) => {
                                return Ok(vec![failure(proc, desktop::Error::Invalid, false)])
                            }
                        };
                    }
                    _ => return Ok(vec![failure(proc, desktop::Error::Invalid, false)]),
                }
            }
            guard.complete = true;
            Ok(vec![ok_payload_message(
                proc.as_u64(),
                DesktopInputReceipt {
                    last_sequence: last,
                }
                .encode(),
            )])
        })
    }
}

#[cfg(test)]
mod tests {
    use super::super::tests::{test_files, test_terminals};
    use super::*;
    #[derive(Default)]
    struct FakeBackend {
        inputs: std::sync::Mutex<Vec<DesktopInputEvent>>,
        changed: tokio::sync::Notify,
    }
    impl desktop::Backend for FakeBackend {
        fn capabilities(&self) -> DesktopCapabilities {
            DesktopCapabilities {
                profile: 1,
                capture: DesktopAvailability::Available,
                input: DesktopAvailability::Available,
                codecs: vec![DesktopCodec {
                    codec: "fixture-only".into(),
                    description: None,
                    hardware: false,
                }],
                composition: false,
                relative_pointer: false,
                max_viewports: 8,
                max_input_frame_bytes: desktop::MAX_FRAME as u64,
                max_input_stream_bytes: desktop::MAX_STREAM as u64,
                reason: None,
            }
        }
        fn displays(&self) -> Vec<DesktopDisplay> {
            vec![DesktopDisplay {
                display_id: "fixture".into(),
                bounds: DesktopRect {
                    x: 0,
                    y: 0,
                    width: 64,
                    height: 64,
                },
                scale: 1.0,
                dpi: 96.0,
            }]
        }
        fn group(&self, _: &DesktopTrack) -> Result<Vec<desktop::EncodedFrame>, desktop::Error> {
            Ok(vec![desktop::EncodedFrame::new(100, true, vec![1, 2, 3])])
        }
        fn input(&self, e: &DesktopInputEvent) -> Result<(), desktop::Error> {
            self.inputs.lock().unwrap().push(e.clone());
            self.changed.notify_one();
            Ok(())
        }
    }
    struct Fixture {
        _dir: tempfile::TempDir,
        credentials_path: PathBuf,
        session: web_transport_quinn::Session,
        backend: Arc<FakeBackend>,
        runtime: Arc<desktop::Runtime>,
        gate: Arc<crate::maintenance::WorkGate>,
        server: tokio::task::JoinHandle<()>,
        _client: web_transport_quinn::Client,
        client_id: String,
        secret: String,
    }
    impl Drop for Fixture {
        fn drop(&mut self) {
            self.session.close(0, b"fixture done");
            self.server.abort();
        }
    }
    impl Fixture {
        async fn new() -> Self {
            let dir = tempfile::tempdir().unwrap();
            let path = dir.path().join("rieul.yaml");
            let credentials_path = client_credentials_path(&path);
            let issued = issue_client_secret("fixture", now_unix());
            let records = ClientCredentials {
                clients: vec![issued.record],
                ..Default::default()
            };
            save_client_credentials(&credentials_path, &records).unwrap();
            let backend = Arc::new(FakeBackend::default());
            let gate = Arc::new(crate::maintenance::WorkGate::default());
            let runtime = desktop::Runtime::new(gate.clone(), Some(backend.clone()));
            let cert = rcgen::generate_simple_self_signed(vec!["127.0.0.1".into()]).unwrap();
            let der = cert.cert.der().clone();
            let key = rustls::pki_types::PrivatePkcs8KeyDer::from(cert.signing_key.serialize_der());
            let mut server = web_transport_quinn::ServerBuilder::new()
                .with_addr("127.0.0.1:0".parse().unwrap())
                .with_certificate(vec![der.clone()], key.into())
                .unwrap();
            let address = server.local_addr().unwrap();
            let credentials = Arc::new(Mutex::new(records.clone()));
            let (events, _) = watch::channel(records);
            let (disconnect, _) = watch::channel(0);
            let rt = runtime.clone();
            let admission = gate.clone();
            let cp = credentials_path.clone();
            let task = tokio::spawn(async move {
                let request = server.accept().await.unwrap();
                let session = request.respond(ConnectResponse::OK).await.unwrap();
                let _ = run_rpc_session(
                    session,
                    path,
                    cp,
                    Arc::new(Mutex::new(SystemConfig::default())),
                    credentials,
                    events,
                    Arc::new(Mutex::new(PairingState::default())),
                    test_files(),
                    None,
                    None,
                    None,
                    None,
                    Arc::new(build_rpc_handlers(None, None, None, None)),
                    test_terminals(),
                    test_commands(),
                    test_agents(),
                    watch::channel(0).0,
                    None,
                    Arc::new(std::sync::atomic::AtomicUsize::new(0)),
                    None,
                    admission,
                    rt,
                    disconnect.subscribe(),
                )
                .await;
                drop(server);
            });
            let client = web_transport_quinn::ClientBuilder::new()
                .with_server_certificates(vec![der])
                .unwrap();
            let session = client
                .connect(web_transport_quinn::proto::ConnectRequest::new(
                    url::Url::parse(&format!("https://127.0.0.1:{}/rieul/rpc", address.port()))
                        .unwrap(),
                ))
                .await
                .unwrap();
            Self {
                _dir: dir,
                credentials_path,
                session,
                backend,
                runtime,
                gate,
                server: task,
                _client: client,
                client_id: issued.client_id,
                secret: issued.client_secret,
            }
        }
        async fn request(&self, message: ReqResMessage) -> ReqResMessage {
            let (mut send, mut recv) = self.session.open_bi().await.unwrap();
            send.write_all(&message.encode()).await.unwrap();
            send.finish().unwrap();
            let bytes = recv.read_to_end(64 * 1024).await.unwrap();
            ReqResMessage::decode_sequence(&bytes).unwrap().remove(0)
        }
        async fn unary(&self, proc: ProcId, payload: Option<Vec<u8>>) -> ReqResMessage {
            self.request(ReqResMessage::RequestUnary {
                proc_id: proc.as_u64(),
                payload,
            })
            .await
        }
        async fn authenticate(&self) {
            let response = self
                .request(ReqResMessage::SessionAuthenticate {
                    mechanism: PAIRED_SECRET_AUTH_MECHANISM.into(),
                    payload: PairedSecretCredential {
                        credential_id: self.client_id.clone(),
                        credential_secret: self.secret.clone(),
                    }
                    .encode(),
                })
                .await;
            assert!(matches!(response, ReqResMessage::SessionAuthenticated));
        }
        async fn attach(&self) -> (String, ReqResMessageReader) {
            let (mut send, recv) = self.session.open_bi().await.unwrap();
            send.write_all(
                &ReqResMessage::RequestUnary {
                    proc_id: ProcId::AttachDesktop.as_u64(),
                    payload: Some(
                        AttachDesktopReq {
                            profile: 1,
                            codecs: vec!["fixture-only".into()],
                            media_uni_streams: true,
                            keyboard_mode: DesktopKeyboardMode::Physical,
                        }
                        .encode(),
                    ),
                }
                .encode(),
            )
            .await
            .unwrap();
            send.finish().unwrap();
            let mut reader = ReqResMessageReader::new(recv);
            let event = reader.next().await.unwrap().unwrap();
            let ReqResMessage::ResponseStreamStart {
                payload: Some(payload),
            } = event
            else {
                panic!("{event:?}")
            };
            let DesktopEvent::Attached { attach_id, .. } = DesktopEvent::decode(&payload).unwrap()
            else {
                panic!()
            };
            (attach_id, reader)
        }
        async fn control(&self, id: &str, action: DesktopControlAction) -> DesktopControl {
            let response = self
                .unary(
                    ProcId::SetDesktopControl,
                    Some(
                        SetDesktopControlReq {
                            attach_id: id.into(),
                            action,
                        }
                        .encode(),
                    ),
                )
                .await;
            let ReqResMessage::ResponseUnaryOk {
                payload: Some(payload),
            } = response
            else {
                panic!("{response:?}")
            };
            DesktopControl::decode(&payload).unwrap()
        }
        async fn wait_input(&self, event: &DesktopInputEvent) {
            loop {
                let notified = self.backend.changed.notified();
                if self.backend.inputs.lock().unwrap().contains(event) {
                    return;
                }
                notified.await;
            }
        }
    }
    #[tokio::test]
    async fn actual_webtransport_auth_incremental_input_reset_and_drain() {
        tokio::time::timeout(Duration::from_secs(20), async {
            let f = Fixture::new().await;
            assert!(matches!(
                f.unary(ProcId::GetDesktopCapabilities, None).await,
                ReqResMessage::ResponseUnaryError { .. }
            ));
            f.authenticate().await;
            let (id, mut events) = f.attach().await;
            assert!(f.gate.begin_drain().is_none());
            let viewport = DesktopViewport {
                viewport_id: "left".into(),
                display_id: "fixture".into(),
                crop: DesktopRect {
                    x: 0,
                    y: 0,
                    width: 64,
                    height: 64,
                },
                width: 64,
                height: 64,
                fps: 60,
                bitrate: 1_000_000,
            };
            let response = f
                .unary(
                    ProcId::ConfigureDesktopViewports,
                    Some(
                        ConfigureDesktopViewportsReq {
                            attach_id: id.clone(),
                            layout_epoch: 1,
                            viewports: vec![viewport],
                            total_bitrate: 1_000_000,
                        }
                        .encode(),
                    ),
                )
                .await;
            assert!(matches!(response, ReqResMessage::ResponseUnaryOk { .. }));
            let mut media = f.session.accept_uni().await.unwrap();
            let bytes = media.read_to_end(65536).await.unwrap();
            let mut objects = Vec::new();
            let mut framing = rieul_daemon_core::desktop_transport::Frames::default();
            framing
                .feed(&bytes, |b| {
                    objects.push(DesktopMediaObject::decode(b).unwrap());
                    Ok(())
                })
                .unwrap();
            framing.finish().unwrap();
            assert_eq!(objects.len(), 1);
            assert_eq!(objects[0].data, vec![1, 2, 3]);
            assert!(objects[0].keyframe);
            assert_eq!(objects[0].attach_id, id);
            // Discarding a media stream does not poison later independent groups.
            let mut abandoned = f.session.accept_uni().await.unwrap();
            let _ = abandoned.stop(1);
            let mut recovered = f.session.accept_uni().await.unwrap();
            let recovered = recovered.read_to_end(65536).await.unwrap();
            assert!(!recovered.is_empty());
            let control = f.control(&id, DesktopControlAction::Acquire).await;
            let key = DesktopInputEvent::PhysicalKey {
                usage: 225,
                down: true,
                repeat: false,
            };
            let frame = DesktopInputFrame {
                attach_id: id.clone(),
                input_epoch: control.input_epoch,
                sequence: 1,
                layout_epoch: 1,
                event: key.clone(),
            };
            let (mut send, mut recv) = f.session.open_bi().await.unwrap();
            send.write_all(
                &ReqResMessage::RequestStreamStart {
                    proc_id: ProcId::WriteDesktopInput.as_u64(),
                    payload: Some(frame.encode()),
                }
                .encode(),
            )
            .await
            .unwrap();
            // The key is processed before EOF: this is a live stream, not buffered RPC.
            f.wait_input(&key).await;
            send.reset(17).unwrap();
            let _ = recv.read_to_end(65536).await;
            loop {
                if f.runtime.control().unwrap().holder_attach_id.is_none() {
                    break;
                }
                tokio::task::yield_now().await;
            }
            assert!(
                f.backend
                    .inputs
                    .lock()
                    .unwrap()
                    .iter()
                    .filter(|e| matches!(e, DesktopInputEvent::ReleaseAll))
                    .count()
                    >= 2
            );
            // Revoking a paired credential closes a live viewer without another input.
            save_client_credentials(&f.credentials_path, &ClientCredentials::default()).unwrap();
            while events.next().await.unwrap().is_some() {}
            assert!(!f.runtime.has(&id));
            while f.gate.active() != 0 {
                tokio::task::yield_now().await;
            }
            assert!(f.gate.begin_drain().is_some());
        })
        .await
        .unwrap();
    }
    #[tokio::test]
    async fn actual_webtransport_oversized_input_releases_control() {
        tokio::time::timeout(Duration::from_secs(20), async {
            let f = Fixture::new().await;
            f.authenticate().await;
            let (id, _events) = f.attach().await;
            let control = f.control(&id, DesktopControlAction::Acquire).await;
            let key = DesktopInputEvent::PhysicalKey {
                usage: 4,
                down: true,
                repeat: false,
            };
            let frame = DesktopInputFrame {
                attach_id: id.clone(),
                input_epoch: control.input_epoch,
                sequence: 1,
                layout_epoch: 1,
                event: key.clone(),
            };
            let (mut send, mut recv) = f.session.open_bi().await.unwrap();
            send.write_all(
                &ReqResMessage::RequestStreamStart {
                    proc_id: ProcId::WriteDesktopInput.as_u64(),
                    payload: Some(frame.encode()),
                }
                .encode(),
            )
            .await
            .unwrap();
            f.wait_input(&key).await;
            // A chunk that never completes inside the small frame bound is rejected.
            let oversized = ReqResMessage::RequestStreamChunk {
                payload: vec![0; desktop::MAX_FRAME + 1024],
            }
            .encode();
            let _ = send.write_all(&oversized).await;
            let _ = send.finish();
            let _ = recv.read_to_end(65536).await;
            while f.runtime.control().unwrap().holder_attach_id.is_some() {
                tokio::task::yield_now().await;
            }
            assert_eq!(
                f.backend.inputs.lock().unwrap().last(),
                Some(&DesktopInputEvent::ReleaseAll)
            );
        })
        .await
        .unwrap();
    }
    #[tokio::test]
    async fn actual_webtransport_raw_first_frame_limit_includes_unknown_fields() {
        tokio::time::timeout(Duration::from_secs(20), async {
            let f = Fixture::new().await;
            f.authenticate().await;
            let (id, _events) = f.attach().await;
            let control = f.control(&id, DesktopControlAction::Acquire).await;
            let frame = DesktopInputFrame {
                attach_id: id,
                input_epoch: control.input_epoch,
                sequence: 1,
                layout_epoch: 1,
                event: DesktopInputEvent::PhysicalKey {
                    usage: 4,
                    down: true,
                    repeat: false,
                },
            };
            use rieul_daemon_core::cbor::Value;
            let Value::Map(mut fields) = Value::decode(&frame.encode()).unwrap() else {
                panic!()
            };
            fields.insert(99, Value::Bytes(vec![0; desktop::MAX_FRAME]));
            let payload = Value::Map(fields).encode();
            // Legacy decoder accepts map ordering; this misses the canonical-header
            // early recognizer but must still fail the raw payload bound.
            let mut wire = vec![1, 0xa2, 2];
            wire.extend(Value::Bytes(payload).encode());
            wire.extend([1, 0x18, 72]);
            let (mut send, mut recv) = f.session.open_bi().await.unwrap();
            send.write_all(&wire).await.unwrap();
            send.finish().unwrap();
            let bytes = recv.read_to_end(65536).await.unwrap();
            let response = ReqResMessage::decode_sequence(&bytes).unwrap().remove(0);
            let ReqResMessage::ResponseUnaryError { error, .. } = response else {
                panic!("{response:?}")
            };
            assert!(matches!(
                DesktopError::decode(&error).unwrap(),
                DesktopError::LimitExceeded { .. }
            ));
            assert!(!f
                .backend
                .inputs
                .lock()
                .unwrap()
                .iter()
                .any(|e| matches!(e, DesktopInputEvent::PhysicalKey { .. })));
        })
        .await
        .unwrap();
    }
    #[tokio::test]
    async fn actual_webtransport_disconnect_releases_held_input() {
        tokio::time::timeout(Duration::from_secs(20), async {
            let f = Fixture::new().await;
            f.authenticate().await;
            let (id, _events) = f.attach().await;
            let control = f.control(&id, DesktopControlAction::Acquire).await;
            let key = DesktopInputEvent::PhysicalKey {
                usage: 4,
                down: true,
                repeat: false,
            };
            let message = ReqResMessage::RequestStreamStart {
                proc_id: ProcId::WriteDesktopInput.as_u64(),
                payload: Some(
                    DesktopInputFrame {
                        attach_id: id.clone(),
                        input_epoch: control.input_epoch,
                        sequence: 1,
                        layout_epoch: 1,
                        event: key.clone(),
                    }
                    .encode(),
                ),
            };
            let response = f.request(message).await;
            assert!(matches!(response, ReqResMessage::ResponseUnaryOk { .. }));
            f.wait_input(&key).await;
            f.session.close(0, b"disconnect fixture");
            while f.runtime.has(&id) {
                tokio::task::yield_now().await;
            }
            assert!(f.runtime.control().unwrap().holder_attach_id.is_none());
            assert_eq!(
                f.backend.inputs.lock().unwrap().last(),
                Some(&DesktopInputEvent::ReleaseAll)
            );
            assert!(f.gate.begin_drain().is_some());
        })
        .await
        .unwrap();
    }
}

async fn stream_media(
    runtime: Arc<desktop::Runtime>,
    session: web_transport_quinn::Session,
    id: String,
    layout: u64,
    track: DesktopTrack,
) {
    let Some(_work) = runtime.capture_work() else {
        return;
    };
    let Some(backend) = runtime.backend() else {
        return;
    };
    let mut group = 0u64;
    let mut pacing =
        tokio::time::interval(Duration::from_secs_f64(1.0 / track.viewport.fps as f64));
    pacing.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);
    loop {
        pacing.tick().await;
        if !runtime.has(&id) {
            return;
        }
        group += 1;
        let backend = backend.clone();
        let capture_track = track.clone();
        // A non-cancelable OS call keeps its own workload guard until it returns.
        let Some(work) = runtime.capture_work() else {
            return;
        };
        let frames = match tokio::task::spawn_blocking(move || {
            let _work = work;
            backend.group(&capture_track)
        })
        .await
        {
            Ok(Ok(frames)) => frames,
            _ => return,
        };
        if frames.is_empty() || frames.len() > 240 || !runtime.has(&id) {
            return;
        }
        let mut bytes = 0usize;
        let mut objects = Vec::with_capacity(frames.len());
        for (index, frame) in frames.into_iter().enumerate() {
            if frame.keyframe != (index == 0) {
                return;
            }
            let object = DesktopMediaObject {
                attach_id: id.clone(),
                track_id: track.track_id,
                layout_epoch: layout,
                codec_epoch: track.codec_epoch,
                group_id: group,
                object_id: index as u64,
                timestamp_micros: frame.timestamp_micros,
                keyframe: frame.keyframe,
                data: frame.data,
            };
            let encoded = match rieul_daemon_core::desktop_transport::encode_object(&object) {
                Ok(b) => b,
                Err(_) => return,
            };
            bytes += encoded.len();
            if bytes > rieul_daemon_core::desktop_transport::MAX_GROUP_BYTES {
                return;
            }
            objects.push(encoded);
        }
        let mut send =
            match tokio::time::timeout(Duration::from_millis(500), session.open_uni()).await {
                Ok(Ok(s)) => s,
                _ => continue,
            };
        let result = tokio::time::timeout(Duration::from_millis(500), async {
            for bytes in &objects {
                send.write_all(bytes).await?;
            }
            send.finish()?;
            send.stopped().await?;
            Ok::<_, anyhow::Error>(())
        })
        .await;
        if !matches!(result, Ok(Ok(()))) {
            let _ = send.reset(1);
        }
        tokio::time::sleep(Duration::from_secs_f64(
            bytes as f64 * 8.0 / track.viewport.bitrate as f64,
        ))
        .await;
    }
}
