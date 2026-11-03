use super::*;
use crate::desktop::{self, Credentials};
use rieul_daemon_core::generated::rpc::*;

pub(super) struct ConnectionCleanup {
    pub runtime: Arc<desktop::Runtime>,
    pub connection: u64,
}
impl Drop for ConnectionCleanup {
    fn drop(&mut self) {
        let runtime = self.runtime.clone();
        let connection = self.connection;
        desktop::cleanup(move || runtime.close(connection));
    }
}
struct AttachmentCleanup {
    runtime: Arc<desktop::Runtime>,
    id: String,
}
impl Drop for AttachmentCleanup {
    fn drop(&mut self) {
        let runtime = self.runtime.clone();
        let id = self.id.clone();
        desktop::cleanup(move || runtime.remove(&id));
    }
}
async fn blocking<T: Send + 'static>(
    runtime: Arc<desktop::Runtime>,
    call: impl FnOnce(&desktop::Runtime) -> Result<T, desktop::Error> + Send + 'static,
) -> Result<T, desktop::Error> {
    tokio::task::spawn_blocking(move || call(&runtime))
        .await
        .map_err(|_| desktop::Error::Backend)?
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
    config_path: &Path,
) {
    if blocking(runtime.clone(), |r| Ok(r.is_empty()))
        .await
        .unwrap_or(false)
    {
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
    let subjects = cluster_subjects(config_path).await;
    let auth = Auth(records.clone().lock_owned().await, subjects);
    let _ = blocking(runtime.clone(), move |r| {
        r.mutate(|d| d.expire(&auth, now_ms()))
    })
    .await;
}
async fn cluster_subjects(config_path: &Path) -> Vec<String> {
    let path = config_path.with_extension("cluster.sqlite");
    tokio::task::spawn_blocking(move || {
        crate::cluster::runtime::client::subjects(&path).unwrap_or_default()
    })
    .await
    .unwrap_or_default()
}
struct Auth(tokio::sync::OwnedMutexGuard<ClientCredentials>, Vec<String>);
impl Credentials for Auth {
    fn valid(&self, client: &str, _: u64) -> bool {
        self.1.iter().any(|subject| subject == client)
            || self
                .0
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
        desktop::Error::HelperUnavailable => "failed",
        desktop::Error::HelperAuthentication => "permission_denied",
    };
    let message = match e {
        desktop::Error::HelperUnavailable => "Screen helper is unavailable. Open the Rieul app in the daemon's logged-in user session.".to_string(),
        desktop::Error::HelperAuthentication => "Screen helper authentication failed. The daemon and Rieul app must be the same installed version.".to_string(),
        _ => format!("Screen: {e:?}"),
    };
    if stream {
        stream_error_message(proc.as_u64(), code, &message)
    } else {
        error_message(proc.as_u64(), code, &message)
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
        let subjects = cluster_subjects(&self.config_path).await;
        let auth = Auth(self.client_credentials.clone().lock_owned().await, subjects);
        // Revocation still attempts cleanup, but never initiates a fresh helper.
        let valid = auth.valid(&client, now_ms());
        let auth = blocking(self.desktop.clone(), move |r| {
            if !valid {
                let _ = r.mutate(|d| d.expire(&auth, now_ms()));
                return Err(desktop::Error::Unauthorized);
            }
            // Recovery must precede the generation-fenced expiration operation.
            r.reconcile_backend()?;
            r.mutate(|d| d.expire(&auth, now_ms()))?;
            Ok(auth)
        })
        .await?;
        Ok((auth, connection, client))
    }
    pub(super) fn get_desktop_capabilities_rpc<'a>(
        &'a mut self,
        _: (),
    ) -> RpcHandlerFuture<'a, Result<UnaryRpcOutcome>> {
        Box::pin(async move {
            match self.desktop_auth().await {
                Ok(_) => Ok(RpcResponse::GetDesktopCapabilities(
                    blocking(self.desktop.clone(), |r| Ok(r.capabilities()))
                        .await
                        .map_err(|e| anyhow::anyhow!("{e:?}"))?,
                )
                .into()),
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
            let runtime = self.desktop.clone();
            let (attached, _cleanup) = match tokio::task::spawn_blocking(move || {
                let attached = runtime.attach(&auth, connection, &client, now_ms(), &request)?;
                let DesktopEvent::Attached { ref attach_id, .. } = attached else {
                    return Err(desktop::Error::Backend);
                };
                let cleanup = AttachmentCleanup {
                    runtime: runtime.clone(),
                    id: attach_id.clone(),
                };
                Ok((attached, cleanup))
            })
            .await?
            {
                Ok(value) => value,
                Err(e) => {
                    write_event(&mut send, failure(ProcId::AttachDesktop, e, true)).await?;
                    return Ok(());
                }
            };
            let DesktopEvent::Attached {
                ref attach_id,
                ref control,
                ..
            } = attached
            else {
                unreachable!()
            };
            let mut previous_layout = blocking(self.desktop.clone(), |r| r.layout_event())
                .await
                .map_err(|e| anyhow::anyhow!("{e:?}"))?;
            let id = attach_id.clone();
            let mut previous = control.clone();
            write_event(&mut send, stream_start_payload_message(attached.encode())).await?;
            let mut media = tokio::task::JoinSet::new();
            let mut configuration = None;
            let mut previous_cursor = None;
            let mut tick = tokio::time::interval(Duration::from_millis(100));
            loop {
                tokio::select! {
                    _ = send.stopped() => return Ok(()),
                    _ = changed.changed() => {},
                    _ = tick.tick() => {
                        if self.desktop_auth().await.is_err() { return Ok(()); }
                        let runtime=self.desktop.clone();
                        if let Some(work)=runtime.capture_work(){
                            tokio::task::spawn_blocking(move || {let _work=work;runtime.refresh_layout()}).await?.map_err(|e|anyhow::anyhow!("{e:?}"))?;
                        }
                    },
                }
                let check_id = id.clone();
                if !blocking(self.desktop.clone(), move |r| Ok(r.has(&check_id)))
                    .await
                    .map_err(|e| anyhow::anyhow!("{e:?}"))?
                {
                    return Ok(());
                }
                let layout = blocking(self.desktop.clone(), |r| r.layout_event())
                    .await
                    .map_err(|e| anyhow::anyhow!("{e:?}"))?;
                if layout != previous_layout {
                    media.abort_all();
                    write_event(&mut send, stream_chunk_payload_message(layout.encode())).await?;
                    previous_layout = layout;
                    previous_cursor = None;
                }
                let config_id = id.clone();
                let next = blocking(self.desktop.clone(), move |r| {
                    Ok(r.configuration(&config_id))
                })
                .await
                .map_err(|e| anyhow::anyhow!("{e:?}"))?;
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
                if let Some(config) = &configuration {
                    if let Some(backend) = self.desktop.backend() {
                        let layout = config.layout_epoch;
                        if let Some(work) = self.desktop.capture_work() {
                            let cursor = tokio::task::spawn_blocking(move || {
                                let _work = work;
                                backend.cursor(layout)
                            })
                            .await?;
                            if cursor != previous_cursor {
                                if let Some(event) = &cursor {
                                    write_event(
                                        &mut send,
                                        stream_chunk_payload_message(event.encode()),
                                    )
                                    .await?;
                                }
                                previous_cursor = cursor;
                            }
                        }
                    }
                }
                let current = blocking(self.desktop.clone(), |r| r.control())
                    .await
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
            let result = match self.desktop_auth().await {
                Ok((auth, c, _)) => {
                    blocking(self.desktop.clone(), move |r| {
                        if request.action != DesktopControlAction::Release
                            && r.capabilities().input != DesktopAvailability::Available
                        {
                            return Err(desktop::Error::Unsupported);
                        }
                        r.mutate(|d| {
                            d.set_control(&auth, c, &request.attach_id, now_ms(), request.action)
                        })?;
                        r.control()
                    })
                    .await
                }
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
                Ok((auth, c, _)) => {
                    let id = request.attach_id.clone();
                    blocking(self.desktop.clone(), move |r| {
                        r.mutate(|d| d.renew(&auth, c, &id, now_ms()))
                    })
                    .await
                }
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
                Ok((auth, c, _)) => {
                    blocking(self.desktop.clone(), move |r| {
                        r.mutate(|d| d.detach(&auth, c, &request.attach_id, now_ms()))
                    })
                    .await
                }
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
                Ok((auth, c, _)) => {
                    blocking(self.desktop.clone(), move |r| {
                        r.configure(&auth, c, now_ms(), request)
                    })
                    .await
                }
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
            let stream_id = first.attach_id.clone();
            let runtime = self.desktop.clone();
            let mut guard = match tokio::task::spawn_blocking(move || {
                runtime.mutate(|d| d.authorize(&auth, c, &stream_id, now_ms()))?;
                runtime.begin_input(&stream_id)
            })
            .await?
            {
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
                let result = blocking(self.desktop.clone(), move |r| {
                    r.accept_input(&_auth, c, now_ms(), frame)
                })
                .await;
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
                                return Ok(vec![failure(proc, desktop::Error::Invalid, false)]);
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

fn finish_capture(
    backend: &dyn desktop::Backend,
    track: &DesktopTrack,
    work: Option<crate::maintenance::WorkGuard>,
) {
    if backend.end_track(track).is_err() {
        // Unknown capture lifetime stays protected until authenticated recovery.
        // A timeout or IPC loss is not proof that the native producer stopped.
        backend.retain_uncertain_capture(track, work);
        eprintln!("Desktop capture shutdown failed; update workload retained");
    }
}

#[cfg(test)]
pub(super) mod tests {
    use super::super::tests::{test_files, test_terminals};
    use super::*;
    #[test]
    fn helper_failures_have_truthful_method_errors() {
        for (cause, auth) in [
            (desktop::Error::HelperAuthentication, true),
            (desktop::Error::HelperUnavailable, false),
        ] {
            let ReqResMessage::ResponseUnaryError { error, .. } =
                failure(ProcId::GetDesktopCapabilities, cause, false)
            else {
                panic!()
            };
            match DesktopError::decode(&error).unwrap() {
                DesktopError::PermissionDenied { message } if auth => {
                    assert!(message.contains("helper authentication failed"))
                }
                DesktopError::Failed { message } if !auth => {
                    assert!(message.contains("helper is unavailable"))
                }
                other => panic!("unexpected error: {other:?}"),
            }
        }
    }
    #[derive(Default)]
    struct FakeBackend {
        inputs: std::sync::Mutex<Vec<DesktopInputEvent>>,
        changed: tokio::sync::Notify,
        display_pause: std::sync::Mutex<
            Option<(
                tokio::sync::oneshot::Sender<()>,
                std::sync::mpsc::Receiver<()>,
            )>,
        >,
        layout_offset: std::sync::atomic::AtomicI64,
        streaming_group: std::sync::atomic::AtomicBool,
        shutdown_fails: std::sync::atomic::AtomicBool,
        encoding_fails: std::sync::atomic::AtomicBool,
    }
    impl desktop::Backend for FakeBackend {
        fn recover_input(&self, keys: &[u64], buttons: &[u64]) -> Result<(), desktop::Error> {
            for usage in keys {
                self.input(&DesktopInputEvent::PhysicalKey {
                    usage: *usage,
                    down: false,
                    repeat: false,
                })?;
            }
            for button in buttons {
                self.input(&DesktopInputEvent::Button {
                    viewport_id: String::new(),
                    x: 0.0,
                    y: 0.0,
                    button: *button,
                    down: false,
                })?;
            }
            Ok(())
        }

        fn end_track(&self, _: &DesktopTrack) -> Result<(), desktop::Error> {
            if self
                .shutdown_fails
                .load(std::sync::atomic::Ordering::SeqCst)
            {
                Err(desktop::Error::Backend)
            } else {
                Ok(())
            }
        }
        fn capabilities(&self) -> DesktopCapabilities {
            DesktopCapabilities {
                profile: 1,
                feedback: Some(true),
                wheel_units: None,
                physical_keys: None,
                capture: DesktopAvailability::Available,
                input: DesktopAvailability::Available,
                codecs: vec![
                    DesktopCodec {
                        codec: "fixture-only".into(),
                        description: None,
                        hardware: false,
                    },
                    DesktopCodec {
                        codec: "fixture-preferred".into(),
                        description: None,
                        hardware: true,
                    },
                ],
                composition: false,
                relative_pointer: false,
                max_viewports: 8,
                max_input_frame_bytes: desktop::MAX_FRAME as u64,
                max_input_stream_bytes: desktop::MAX_STREAM as u64,
                reason: None,
            }
        }
        fn displays(&self) -> Vec<DesktopDisplay> {
            let pause = self.display_pause.lock().unwrap().take();
            if let Some((started, release)) = pause {
                let _ = started.send(());
                // Dropping the sender also unblocks this worker on test failure.
                let _ = release.recv();
            }
            vec![DesktopDisplay {
                display_id: "fixture".into(),
                bounds: DesktopRect {
                    x: self.layout_offset.load(std::sync::atomic::Ordering::SeqCst),
                    y: 0,
                    width: 64,
                    height: 64,
                },
                scale: 1.0,
                dpi: 96.0,
            }]
        }
        fn group(&self, _: &DesktopTrack) -> Result<Vec<desktop::EncodedFrame>, desktop::Error> {
            if self
                .encoding_fails
                .load(std::sync::atomic::Ordering::SeqCst)
            {
                return Err(desktop::Error::Backend);
            }
            Ok(vec![desktop::EncodedFrame::new(100, true, vec![1, 2, 3])])
        }
        fn stream_group(
            &self,
            track: &DesktopTrack,
            emit: &mut dyn FnMut(desktop::EncodedFrame) -> Result<(), desktop::Error>,
        ) -> Result<(), desktop::Error> {
            if self
                .streaming_group
                .swap(false, std::sync::atomic::Ordering::SeqCst)
            {
                emit(desktop::EncodedFrame::new(1, true, vec![1, 2, 3]))?;
                std::thread::sleep(Duration::from_millis(25));
                for i in 1..32 {
                    emit(desktop::EncodedFrame::new(i + 1, false, vec![0; 65536]))?;
                }
                Ok(())
            } else {
                for frame in self.group(track)? {
                    emit(frame)?;
                }
                Ok(())
            }
        }
        fn input(&self, e: &DesktopInputEvent) -> Result<(), desktop::Error> {
            self.inputs.lock().unwrap().push(e.clone());
            self.changed.notify_one();
            Ok(())
        }
    }
    #[test]
    fn selected_codec_follows_client_preference_without_a_protocol_codec_priority() {
        struct Allowed;
        impl desktop::Credentials for Allowed {
            fn valid(&self, _: &str, _: u64) -> bool {
                true
            }
        }
        let runtime = desktop::Runtime::new(
            Arc::new(crate::maintenance::WorkGate::default()),
            Some(Arc::new(FakeBackend::default())),
        );
        let event = runtime
            .attach(
                &Allowed,
                1,
                "client",
                0,
                &AttachDesktopReq {
                    profile: 1,
                    codecs: vec!["fixture-preferred".into(), "fixture-only".into()],
                    media_uni_streams: true,
                    keyboard_mode: DesktopKeyboardMode::Physical,
                },
            )
            .unwrap();
        let DesktopEvent::Attached { attach_id, .. } = event else {
            panic!("attach");
        };
        let configuration = runtime
            .configure(
                &Allowed,
                1,
                0,
                ConfigureDesktopViewportsReq {
                    attach_id,
                    layout_epoch: 1,
                    total_bitrate: 1000,
                    viewports: vec![DesktopViewport {
                        viewport_id: "v".into(),
                        display_id: "fixture".into(),
                        crop: DesktopRect {
                            x: 0,
                            y: 0,
                            width: 64,
                            height: 64,
                        },
                        width: 64,
                        height: 64,
                        fps: 1,
                        bitrate: 1000,
                    }],
                },
            )
            .unwrap();
        assert_eq!(configuration.tracks[0].codec.codec, "fixture-preferred");
    }
    #[test]
    fn uncertain_native_shutdown_keeps_update_workload() {
        let track = DesktopTrack {
            track_id: 1,
            codec_epoch: 1,
            codec: DesktopCodec {
                codec: "fixture".into(),
                hardware: false,
                description: None,
            },
            viewport: DesktopViewport {
                viewport_id: "v".into(),
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
                bitrate: 1000,
            },
        };
        for fails in [false, true] {
            let backend = FakeBackend::default();
            backend
                .shutdown_fails
                .store(fails, std::sync::atomic::Ordering::SeqCst);
            let gate = Arc::new(crate::maintenance::WorkGate::default());
            finish_capture(&backend, &track, gate.enter());
            assert_eq!(gate.active(), usize::from(fails));
            assert_eq!(gate.begin_drain().is_none(), fails);
        }
    }
    struct FixtureUpdater(crate::updates::StatusFeed);
    impl crate::updates::UpdateService for FixtureUpdater {
        fn status(&self) -> Result<UpdateStatus> {
            Ok(self.0.subscribe().borrow().clone())
        }
        fn subscribe(&self) -> Result<watch::Receiver<UpdateStatus>> {
            Ok(self.0.subscribe())
        }
        fn request(&self, _: crate::updates::UpdateCommand) -> crate::updates::UpdateRequest<'_> {
            Box::pin(async move { self.status() })
        }
    }
    #[tokio::test]
    async fn actual_webtransport_update_subscription_snapshot_order_reconnect_revoke_and_cleanup() {
        tokio::time::timeout(Duration::from_secs(10), async {
            let updater = Arc::new(FixtureUpdater(Default::default()));
            let f = Fixture::with_updates(false, Some(updater.clone())).await;
            let denied = f.unary(ProcId::CheckForUpdates, None).await;
            assert!(matches!(denied, ReqResMessage::ResponseUnaryError { .. }));
            f.authenticate().await;
            async fn subscribe(f: &Fixture) -> ReqResMessageReader {
                let (mut send, recv) = f.session.open_bi().await.unwrap();
                send.write_all(
                    &ReqResMessage::RequestUnary {
                        proc_id: ProcId::SubscribeUpdateStatus.as_u64(),
                        payload: None,
                    }
                    .encode(),
                )
                .await
                .unwrap();
                send.finish().unwrap();
                ReqResMessageReader::new(recv)
            }
            async fn snapshot(reader: &mut ReqResMessageReader) -> UpdateStatus {
                match reader.next().await.unwrap().unwrap() {
                    ReqResMessage::ResponseStreamStart {
                        payload: Some(bytes),
                    }
                    | ReqResMessage::ResponseStreamChunk { payload: bytes } => {
                        UpdateStatus::decode(&bytes).unwrap()
                    }
                    other => panic!("{other:?}"),
                }
            }
            let mut stream = subscribe(&f).await;
            let first = snapshot(&mut stream).await;
            let mut next = first.clone();
            next.phase = UpdatePhase::Downloading;
            let sent = updater.0.publish(next);
            assert_eq!(snapshot(&mut stream).await, sent);
            assert!(sent.ordering.revision > first.ordering.revision);
            stream.recv.stop(0).unwrap();
            while updater.0.receivers() != 0 {
                tokio::task::yield_now().await;
            }
            let mut stream = subscribe(&f).await;
            assert_eq!(snapshot(&mut stream).await, sent);
            save_client_credentials(&f.credentials_path, &ClientCredentials::default()).unwrap();
            let mut next = sent;
            next.phase = UpdatePhase::Ready;
            updater.0.publish(next);
            assert!(stream.next().await.unwrap().is_none());
            assert_eq!(updater.0.receivers(), 0);
            let denied = f.unary(ProcId::InstallUpdateConfirmed, None).await;
            assert!(matches!(denied, ReqResMessage::ResponseUnaryError { .. }));
        })
        .await
        .unwrap();
    }
    pub(in crate::server) struct Fixture {
        pub(in crate::server) _dir: tempfile::TempDir,
        pub(in crate::server) credentials_path: PathBuf,
        pub(in crate::server) session: web_transport_quinn::Session,
        backend: Arc<FakeBackend>,
        runtime: Arc<desktop::Runtime>,
        pub(in crate::server) gate: Arc<crate::maintenance::WorkGate>,
        server: tokio::task::JoinHandle<()>,
        pub(in crate::server) _client: web_transport_quinn::Client,
        client_id: String,
        secret: String,
        helper_tasks: Arc<std::sync::Mutex<Vec<tokio::task::AbortHandle>>>,
    }
    impl Drop for Fixture {
        fn drop(&mut self) {
            self.session.close(0, b"fixture done");
            self.server.abort();
        }
    }
    impl Fixture {
        pub(in crate::server) async fn new() -> Self {
            Self::with_ipc(false).await
        }
        async fn with_ipc(use_ipc: bool) -> Self {
            Self::with_updates(use_ipc, None).await
        }
        async fn with_updates(use_ipc: bool, updates: SharedUpdater) -> Self {
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
            let helper_tasks = Arc::new(std::sync::Mutex::new(Vec::new()));
            let adapter: Arc<dyn desktop::Backend> = if use_ipc {
                let native = backend.clone();
                let helpers = helper_tasks.clone();
                Arc::new(crate::desktop_ipc::Proxy::new(Arc::new(move || {
                    let native = native.clone();
                    let helpers = helpers.clone();
                    Box::pin(async move {
                        let (client, server) = tokio::io::duplex(65536);
                        let task = tokio::spawn(crate::desktop_ipc::serve(server, native));
                        helpers.lock().unwrap().push(task.abort_handle());
                        Ok(Box::new(client) as crate::desktop_ipc::Connection)
                    })
                })))
            } else {
                backend.clone()
            };
            let runtime = desktop::Runtime::new(gate.clone(), Some(adapter));
            let cert = rcgen::generate_simple_self_signed(vec!["127.0.0.1".into()]).unwrap();
            let der = cert.cert.der().clone();
            let key = rustls::pki_types::PrivatePkcs8KeyDer::from(cert.signing_key.serialize_der());
            let mut server = web_transport_quinn::ServerBuilder::new()
                .with_addr("127.0.0.1:0".parse().unwrap())
                .with_certificate(vec![der.clone()], key.into())
                .unwrap();
            let address = server.local_addr().unwrap();
            save(
                &path,
                &SystemConfig {
                    listen_addr: address.to_string(),
                    domain: Some("127.0.0.1".into()),
                    ..Default::default()
                },
            )
            .unwrap();
            let credentials = Arc::new(Mutex::new(records.clone()));
            let (events, _) = watch::channel(records);
            let (disconnect, _) = watch::channel(0);
            let rt = runtime.clone();
            let admission = gate.clone();
            let cp = credentials_path.clone();
            let task = tokio::spawn(async move {
                let mut connections = tokio::task::JoinSet::new();
                while let Some(request) = server.accept().await {
                    let session = request.respond(ConnectResponse::OK).await.unwrap();
                    let path = path.clone();
                    let cp = cp.clone();
                    let credentials = credentials.clone();
                    let events = events.clone();
                    let updates = updates.clone();
                    let admission = admission.clone();
                    let rt = rt.clone();
                    let disconnect = disconnect.clone();
                    connections.spawn(async move {
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
                            updates,
                            admission,
                            rt,
                            disconnect.subscribe(),
                        )
                        .await;
                    });
                }
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
                helper_tasks,
            }
        }
        async fn request(&self, message: ReqResMessage) -> ReqResMessage {
            let (mut send, mut recv) = self.session.open_bi().await.unwrap();
            send.write_all(&message.encode()).await.unwrap();
            send.finish().unwrap();
            let bytes = recv.read_to_end(64 * 1024).await.unwrap();
            ReqResMessage::decode_sequence(&bytes).unwrap().remove(0)
        }
        pub(in crate::server) async fn unary(
            &self,
            proc: ProcId,
            payload: Option<Vec<u8>>,
        ) -> ReqResMessage {
            self.request(ReqResMessage::RequestUnary {
                proc_id: proc.as_u64(),
                payload,
            })
            .await
        }
        pub(in crate::server) async fn authenticate(&self) {
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
        pub(in crate::server) async fn hold_key_on(
            &self,
            session: &web_transport_quinn::Session,
        ) -> (
            web_transport_quinn::SendStream,
            web_transport_quinn::RecvStream,
            ReqResMessageReader,
        ) {
            let (mut send, recv) = session.open_bi().await.unwrap();
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
            let mut events = ReqResMessageReader::new(recv);
            let ReqResMessage::ResponseStreamStart {
                payload: Some(bytes),
            } = events.next().await.unwrap().unwrap()
            else {
                panic!()
            };
            let DesktopEvent::Attached { attach_id, .. } = DesktopEvent::decode(&bytes).unwrap()
            else {
                panic!()
            };
            let (mut send, mut recv) = session.open_bi().await.unwrap();
            send.write_all(
                &ReqResMessage::RequestUnary {
                    proc_id: ProcId::SetDesktopControl.as_u64(),
                    payload: Some(
                        SetDesktopControlReq {
                            attach_id: attach_id.clone(),
                            action: DesktopControlAction::Acquire,
                        }
                        .encode(),
                    ),
                }
                .encode(),
            )
            .await
            .unwrap();
            send.finish().unwrap();
            let messages =
                ReqResMessage::decode_sequence(&recv.read_to_end(65536).await.unwrap()).unwrap();
            let ReqResMessage::ResponseUnaryOk {
                payload: Some(bytes),
            } = &messages[0]
            else {
                panic!()
            };
            let control = DesktopControl::decode(bytes).unwrap();
            let key = DesktopInputEvent::PhysicalKey {
                usage: 225,
                down: true,
                repeat: false,
            };
            let previous_keys = self
                .backend
                .inputs
                .lock()
                .unwrap()
                .iter()
                .filter(|event| *event == &key)
                .count();
            let frame = DesktopInputFrame {
                attach_id,
                input_epoch: control.input_epoch,
                sequence: 1,
                layout_epoch: 1,
                event: key.clone(),
            };
            let (mut send, recv) = session.open_bi().await.unwrap();
            send.write_all(
                &ReqResMessage::RequestStreamStart {
                    proc_id: ProcId::WriteDesktopInput.as_u64(),
                    payload: Some(frame.encode()),
                }
                .encode(),
            )
            .await
            .unwrap();
            loop {
                let changed = self.backend.changed.notified();
                if self
                    .backend
                    .inputs
                    .lock()
                    .unwrap()
                    .iter()
                    .filter(|event| *event == &key)
                    .count()
                    > previous_keys
                {
                    break;
                }
                changed.await;
            }
            (send, recv, events)
        }
        pub(in crate::server) async fn assert_control_released(&self) {
            tokio::time::timeout(Duration::from_secs(2), async {
                loop {
                    if blocking(self.runtime.clone(), |r| r.control())
                        .await
                        .unwrap()
                        .holder_attach_id
                        .is_none()
                    {
                        break;
                    }
                    tokio::task::yield_now().await;
                }
            })
            .await
            .unwrap();
            let inputs = self.backend.inputs.lock().unwrap();
            let key_down = inputs
                .iter()
                .rposition(|e| matches!(e, DesktopInputEvent::PhysicalKey { down: true, .. }))
                .unwrap();
            assert!(inputs[key_down + 1..]
                .iter()
                .any(|e| matches!(e, DesktopInputEvent::ReleaseAll)));
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
    #[tokio::test(flavor = "multi_thread", worker_threads = 4)]
    async fn authenticated_rpc_recovers_helper_before_expiring_old_generation() {
        tokio::time::timeout(Duration::from_secs(10), async {
            let f = Fixture::with_ipc(true).await;
            f.authenticate().await;
            let (old, _events) = f.attach().await;
            let control = f.control(&old, DesktopControlAction::Acquire).await;
            let response = f
                .request(ReqResMessage::RequestStreamStart {
                    proc_id: ProcId::WriteDesktopInput.as_u64(),
                    payload: Some(
                        DesktopInputFrame {
                            attach_id: old.clone(),
                            input_epoch: control.input_epoch,
                            layout_epoch: 1,
                            sequence: 1,
                            event: DesktopInputEvent::PhysicalKey {
                                usage: 4,
                                down: true,
                                repeat: false,
                            },
                        }
                        .encode(),
                    ),
                })
                .await;
            assert!(matches!(response, ReqResMessage::ResponseUnaryOk { .. }));
            // Clean half-close acknowledges the down event but retains held input.
            f.helper_tasks.lock().unwrap().last().unwrap().abort();
            loop {
                let response = f.unary(ProcId::GetDesktopCapabilities, None).await;
                if matches!(response, ReqResMessage::ResponseUnaryOk { .. })
                    && f.helper_tasks.lock().unwrap().len() > 1
                {
                    break;
                }
                tokio::time::sleep(Duration::from_millis(10)).await;
            }
            let (new, _events) = f.attach().await;
            assert_ne!(old, new);
            assert!(f.runtime.control().unwrap().holder_attach_id.is_none());
            assert!(f.runtime.control().unwrap().input_epoch > control.input_epoch);
            f.wait_input(&DesktopInputEvent::PhysicalKey {
                usage: 4,
                down: false,
                repeat: false,
            })
            .await;
            assert!(matches!(
                f.unary(
                    ProcId::RenewDesktopLease,
                    Some(DesktopAttachRef { attach_id: old }.encode())
                )
                .await,
                ReqResMessage::ResponseUnaryError { .. }
            ));
            f.control(&new, DesktopControlAction::Acquire).await;
        })
        .await
        .unwrap();
    }
    #[tokio::test]
    async fn native_encoder_failure_through_ipc_closes_attachment_and_releases_control() {
        tokio::time::timeout(Duration::from_secs(10), async {
            let f = Fixture::with_ipc(true).await;
            f.authenticate().await;
            let (id, _events) = f.attach().await;
            f.control(&id, DesktopControlAction::Acquire).await;
            f.backend
                .encoding_fails
                .store(true, std::sync::atomic::Ordering::SeqCst);
            let response = f
                .unary(
                    ProcId::ConfigureDesktopViewports,
                    Some(
                        ConfigureDesktopViewportsReq {
                            attach_id: id.clone(),
                            layout_epoch: 1,
                            total_bitrate: 1000,
                            viewports: vec![DesktopViewport {
                                viewport_id: "v".into(),
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
                                bitrate: 1000,
                            }],
                        }
                        .encode(),
                    ),
                )
                .await;
            assert!(matches!(response, ReqResMessage::ResponseUnaryOk { .. }));
            loop {
                let check = id.clone();
                if !blocking(f.runtime.clone(), move |r| Ok(r.has(&check)))
                    .await
                    .unwrap()
                {
                    break;
                }
                tokio::time::sleep(Duration::from_millis(5)).await;
            }
            f.wait_input(&DesktopInputEvent::ReleaseAll).await;
            assert!(blocking(f.runtime.clone(), |r| r.control())
                .await
                .unwrap()
                .holder_attach_id
                .is_none());
        })
        .await
        .unwrap();
    }
    #[tokio::test]
    async fn viewer_feedback_is_track_bound_and_does_not_grant_control() {
        tokio::time::timeout(Duration::from_secs(10), async {
            let f = Fixture::new().await;
            f.authenticate().await;
            let (id, _events) = f.attach().await;
            f.backend
                .streaming_group
                .store(true, std::sync::atomic::Ordering::SeqCst);
            let response = f
                .unary(
                    ProcId::ConfigureDesktopViewports,
                    Some(
                        ConfigureDesktopViewportsReq {
                            attach_id: id.clone(),
                            layout_epoch: 1,
                            total_bitrate: 1_000_000,
                            viewports: vec![DesktopViewport {
                                viewport_id: "v".into(),
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
                            }],
                        }
                        .encode(),
                    ),
                )
                .await;
            let ReqResMessage::ResponseUnaryOk {
                payload: Some(payload),
                ..
            } = response
            else {
                panic!("{response:?}")
            };
            let configuration = DesktopConfiguration::decode(&payload).unwrap();
            let track = &configuration.tracks[0];
            let mut partial = f.session.accept_uni().await.unwrap();
            let mut header = [0; 4];
            partial.read_exact(&mut header).await.unwrap();
            let mut first = vec![0; u32::from_be_bytes(header) as usize];
            partial.read_exact(&mut first).await.unwrap();
            assert!(DesktopMediaObject::decode(&first).unwrap().keyframe);
            partial.stop(1).unwrap();
            let mut recovered = f.session.accept_uni().await.unwrap();
            assert!(!recovered.read_to_end(65536).await.unwrap().is_empty());

            let frame = DesktopInputFrame {
                attach_id: id.clone(),
                input_epoch: 0,
                layout_epoch: 1,
                sequence: 1,
                event: DesktopInputEvent::Feedback {
                    track_id: track.track_id,
                    codec_epoch: track.codec_epoch,
                    group_id: 1,
                    decode_micros: 10,
                    render_micros: 10,
                    queue_depth: 3,
                    request_keyframe: true,
                },
            };
            let response = f
                .request(ReqResMessage::RequestStreamStart {
                    proc_id: ProcId::WriteDesktopInput.as_u64(),
                    payload: Some(frame.encode()),
                })
                .await;
            assert!(matches!(response, ReqResMessage::ResponseUnaryOk { .. }));
            assert!(f.runtime.control().unwrap().holder_attach_id.is_none());
            assert!(f.runtime.feedback_delay(&id, track.track_id) > Duration::ZERO);
            let mut stale = frame.clone();
            stale.sequence = 2;
            if let DesktopInputEvent::Feedback { codec_epoch, .. } = &mut stale.event {
                *codec_epoch += 1;
            }
            let response = f
                .request(ReqResMessage::RequestStreamStart {
                    proc_id: ProcId::WriteDesktopInput.as_u64(),
                    payload: Some(stale.encode()),
                })
                .await;
            assert!(!matches!(response, ReqResMessage::ResponseUnaryOk { .. }));
            f.backend
                .layout_offset
                .store(100, std::sync::atomic::Ordering::SeqCst);
            f.runtime.refresh_layout().unwrap();
            assert!(f.runtime.configuration(&id).is_none());
            assert!(matches!(
                f.runtime.layout_event().unwrap(),
                DesktopEvent::Layout {
                    layout_epoch: 2,
                    ..
                }
            ));
        })
        .await
        .unwrap();
    }

    #[tokio::test]
    async fn actual_webtransport_auth_incremental_input_reset_and_drain_through_user_ipc() {
        tokio::time::timeout(Duration::from_secs(20), async {
            let f = Fixture::with_ipc(true).await;
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
                if blocking(f.runtime.clone(), |r| r.control())
                    .await
                    .unwrap()
                    .holder_attach_id
                    .is_none()
                {
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
            // Stream EOF can precede the blocking attachment cleanup. Never take
            // its state mutex on this current-thread runtime: the helper IPC must
            // keep running while cleanup awaits its native shutdown response.
            while blocking(f.runtime.clone(), {
                let id = id.clone();
                move |r| Ok(r.has(&id))
            })
            .await
            .unwrap()
            {
                tokio::task::yield_now().await;
            }
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
        disconnect_releases_held_input(false).await;
    }

    #[tokio::test]
    async fn actual_webtransport_disconnect_protects_inflight_layout_work() {
        disconnect_releases_held_input(true).await;
    }

    async fn disconnect_releases_held_input(pause_layout: bool) {
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
            let release = if pause_layout {
                let (started, waiting) = tokio::sync::oneshot::channel();
                let (release, blocked) = std::sync::mpsc::channel();
                *f.backend.display_pause.lock().unwrap() = Some((started, blocked));
                waiting.await.unwrap();
                Some(release)
            } else {
                None
            };
            f.session.close(0, b"disconnect fixture");
            while f.runtime.has(&id) {
                tokio::task::yield_now().await;
            }
            assert!(f.runtime.control().unwrap().holder_attach_id.is_none());
            assert_eq!(
                f.backend.inputs.lock().unwrap().last(),
                Some(&DesktopInputEvent::ReleaseAll)
            );
            if pause_layout {
                assert!(f.gate.begin_drain().is_none());
            }
            drop(release);
            // Attachment removal proves input cleanup, not completion of detached
            // RPC/native work. Acquire the actual admission barrier before draining.
            let _drain = loop {
                if let Some(drain) = f.gate.begin_drain() {
                    break drain;
                }
                tokio::task::yield_now().await;
            };
            assert!(f.runtime.capture_work().is_none());
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
    struct TrackCleanup(
        Arc<dyn desktop::Backend>,
        DesktopTrack,
        Option<crate::maintenance::WorkGuard>,
    );
    impl Drop for TrackCleanup {
        fn drop(&mut self) {
            let backend = self.0.clone();
            let track = self.1.clone();
            let work = self.2.take();
            // Cleanup can wait for a bounded native call; never block the async runtime.
            tokio::task::spawn_blocking(move || {
                finish_capture(backend.as_ref(), &track, work);
            });
        }
    }
    let _track_cleanup = TrackCleanup(backend.clone(), track.clone(), Some(_work));
    let mut group = 0u64;
    let mut pacing =
        tokio::time::interval(Duration::from_secs_f64(1.0 / track.viewport.fps as f64));
    pacing.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);
    loop {
        pacing.tick().await;
        tokio::time::sleep(runtime.feedback_delay(&id, track.track_id)).await;
        let check_id = id.clone();
        if !blocking(runtime.clone(), move |r| Ok(r.has(&check_id)))
            .await
            .unwrap_or(false)
        {
            return;
        }
        group += 1;
        let started = std::time::Instant::now();
        let backend = backend.clone();
        let capture_track = track.clone();
        // A non-cancelable OS call keeps its own workload guard until it returns.
        let Some(work) = runtime.capture_work() else {
            return;
        };
        let (tx, mut rx) = tokio::sync::mpsc::channel(2);
        let producer = tokio::task::spawn_blocking(move || {
            let _work = work;
            backend.stream_group(&capture_track, &mut |frame| {
                tx.blocking_send(frame).map_err(|_| desktop::Error::Stale)
            })
        });
        let mut send =
            match tokio::time::timeout(Duration::from_millis(500), session.open_uni()).await {
                Ok(Ok(s)) => s,
                _ => {
                    drop(rx);
                    let _ = producer.await;
                    continue;
                }
            };
        let mut bytes = 0usize;
        let result = tokio::time::timeout(Duration::from_secs(5), async {
            let mut index = 0u64;
            while let Some(frame) = rx.recv().await {
                let check_id = id.clone();
                let attached = blocking(runtime.clone(), move |r| Ok(r.has(&check_id)))
                    .await
                    .unwrap_or(false);
                if index >= 240 || frame.keyframe != (index == 0) || !attached {
                    anyhow::bail!("invalid or detached desktop group");
                }
                let object = DesktopMediaObject {
                    attach_id: id.clone(),
                    track_id: track.track_id,
                    layout_epoch: layout,
                    codec_epoch: track.codec_epoch,
                    group_id: group,
                    object_id: index,
                    timestamp_micros: frame.timestamp_micros,
                    keyframe: frame.keyframe,
                    data: frame.data,
                };
                let encoded = rieul_daemon_core::desktop_transport::encode_object(&object)
                    .map_err(|e| anyhow::anyhow!("{e:?}"))?;
                bytes += encoded.len();
                if bytes > rieul_daemon_core::desktop_transport::MAX_GROUP_BYTES {
                    anyhow::bail!("desktop group exceeds budget");
                }
                tokio::time::timeout(Duration::from_millis(500), send.write_all(&encoded))
                    .await??;
                index += 1;
            }
            if index == 0 {
                anyhow::bail!("desktop group has no frame");
            }
            send.finish()?;
            tokio::time::timeout(Duration::from_millis(500), send.stopped()).await??;
            Ok::<_, anyhow::Error>(())
        })
        .await;
        if !matches!(result, Ok(Ok(()))) {
            let _ = send.reset(1);
        }
        drop(rx); // Unblock a producer abandoned under downstream pressure.
        if !matches!(producer.await, Ok(Ok(())) | Ok(Err(desktop::Error::Stale))) {
            let failed_id = id.clone();
            let _ = blocking(runtime.clone(), move |r| {
                r.remove(&failed_id);
                Ok(())
            })
            .await;
            return;
        }
        tokio::time::sleep(
            Duration::from_secs_f64(bytes as f64 * 8.0 / track.viewport.bitrate as f64)
                .saturating_sub(started.elapsed()),
        )
        .await;
    }
}
