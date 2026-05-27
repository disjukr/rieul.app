use std::collections::{BTreeMap, HashSet};
use std::net::SocketAddr;
use std::path::{Path, PathBuf};
use std::sync::{Arc, RwLock};
use std::time::Duration;

use anyhow::{bail, Context, Result};
use notify::{Event, RecursiveMode, Watcher};
use rustls::server::{ClientHello, ResolvesServerCert};
use rustls::sign::CertifiedKey;
use time::OffsetDateTime;
use tokio::sync::Mutex;
use tracing::{info, warn};
use web_transport_quinn::proto::ConnectResponse;
use wgo_daemon_core::cbor::Value;
use wgo_daemon_core::config::{
    load_or_default, save, windows_program_data_config_path, SystemConfig,
};
use wgo_daemon_core::pairing::{issue_client_secret, verify_client_secret, verify_pairing_code};
use wgo_daemon_core::rpc::{
    BulkMutationItemResult, BulkMutationRes, CompletePairingRequest, CompletePairingResponse,
    CreateNodesReq, DeletePathsReq, DirectoryEntryKey, DirectorySubscriptionCloseReason,
    DirectoryTableEvent, FsEntry, ProcId, ReadFileReq, ReadFileRes, RenamePathsReq, RootEntryKey,
    RootsSubscriptionCloseReason, RootsTableEvent, RpcErrorCode, RpcErrorPayload,
    StartPairingResponse, WriteFileReq,
};
use wgo_daemon_core::traits::{FileService, ServiceError};
use wgo_daemon_core::wire::{
    DatagramMessage, PairedSecretCredential, ReqResMessage, RpcErrorKind, SessionAuthErrorCode,
    MAX_MESSAGE_SEQUENCE_SIZE, PAIRED_SECRET_AUTH_MECHANISM,
};

use crate::cert::{
    configured_certificate_paths, prepare_server_certificate, uses_scheduled_certificate_refresh,
};
use crate::fs::WindowsFileService;

const CERT_RELOAD_DEBOUNCE: Duration = Duration::from_millis(250);
const SCHEDULED_CERT_REFRESH_INTERVAL: Duration = Duration::from_secs(60 * 60);
const SUBSCRIPTION_DEBOUNCE: Duration = Duration::from_millis(150);
// TODO: Replace root subscription polling with Windows volume notifications.
// `notify` watches concrete filesystem paths, so it does not cover the drive
// root namespace well. Prefer `CM_Register_Notification` over WM_DEVICECHANGE:
// it can work in dev/background daemons without a hidden window or Windows
// service control handler. The `windows` crate is already used here; the likely
// extra Cargo features are `Win32_Devices_DeviceAndDriverInstallation` for
// `CM_Register_Notification`/`CM_Unregister_Notification`/`CM_NOTIFY_FILTER`
// and `Win32_System_Ioctl` for `GUID_DEVINTERFACE_VOLUME`. Register a
// device-interface filter for volume changes, forward the callback into an
// async channel, keep the notification handle alive, unregister it in Drop, and
// keep this polling path as a fallback if registration fails or events prove
// incomplete for network drives/mount points.
const ROOTS_SUBSCRIPTION_POLL_INTERVAL: Duration = Duration::from_secs(2);

type SharedSystemConfig = Arc<Mutex<SystemConfig>>;
type SharedRpcSessionState = Arc<Mutex<RpcSessionState>>;

#[derive(Default)]
struct RpcSessionState {
    authenticated_client_id: Option<String>,
}

pub async fn run_system_server(addr: SocketAddr, config_path: Option<PathBuf>) -> Result<()> {
    let config_path = config_path.unwrap_or_else(windows_program_data_config_path);
    let provider = web_transport_quinn::crypto::default_provider();
    let mut config = load_or_default(&config_path)?;
    config.listen_addr = addr.to_string();
    let certificate = prepare_server_certificate(&mut config, addr, &config_path, &provider)?;
    save(&config_path, &config)?;
    let config_state = Arc::new(Mutex::new(config));

    let resolver = Arc::new(ReloadingCertResolver::new(certificate.certified_key));
    let mut server = build_reloadable_server(addr, provider.clone(), resolver.clone())?;

    tokio::spawn(reload_certificates(
        config_path.clone(),
        addr,
        provider,
        resolver,
    ));

    info!(%addr, "wgo Windows system daemon listening");

    while let Some(request) = server.accept().await {
        let config_path = config_path.clone();
        let config_state = config_state.clone();
        tokio::spawn(async move {
            if let Err(err) = handle_request(request, config_path, config_state).await {
                warn!(?err, "WebTransport request failed");
            }
        });
    }
    Ok(())
}

#[derive(Debug)]
struct ReloadingCertResolver {
    current: RwLock<Arc<CertifiedKey>>,
}

impl ReloadingCertResolver {
    fn new(initial: Arc<CertifiedKey>) -> Self {
        Self {
            current: RwLock::new(initial),
        }
    }

    fn current_fingerprint(&self) -> Option<Vec<u8>> {
        self.current
            .read()
            .ok()
            .and_then(|current| current.cert.first().map(|cert| cert.to_vec()))
    }

    fn replace(&self, next: Arc<CertifiedKey>) -> Result<bool> {
        let Some(next_fingerprint) = next.cert.first().map(|cert| cert.to_vec()) else {
            bail!("certificate chain is empty");
        };
        let mut current = self
            .current
            .write()
            .map_err(|_| anyhow::anyhow!("certificate resolver lock is poisoned"))?;
        let changed = current
            .cert
            .first()
            .map(|cert| cert.as_ref() != next_fingerprint.as_slice())
            .unwrap_or(true);
        if changed {
            *current = next;
        }
        Ok(changed)
    }
}

impl ResolvesServerCert for ReloadingCertResolver {
    fn resolve(&self, _client_hello: ClientHello<'_>) -> Option<Arc<CertifiedKey>> {
        self.current.read().ok().map(|current| current.clone())
    }
}

fn build_reloadable_server(
    addr: SocketAddr,
    provider: web_transport_quinn::crypto::Provider,
    resolver: Arc<ReloadingCertResolver>,
) -> Result<web_transport_quinn::Server> {
    let mut tls_config = rustls::ServerConfig::builder_with_provider(provider)
        .with_protocol_versions(&[&rustls::version::TLS13])?
        .with_no_client_auth()
        .with_cert_resolver(resolver);
    tls_config.alpn_protocols = vec![web_transport_quinn::ALPN.as_bytes().to_vec()];

    let quic_config: web_transport_quinn::quinn::crypto::rustls::QuicServerConfig = tls_config
        .try_into()
        .context("failed to build QUIC TLS config")?;
    let server_config =
        web_transport_quinn::quinn::ServerConfig::with_crypto(Arc::new(quic_config));
    let endpoint = web_transport_quinn::quinn::Endpoint::server(server_config, addr)
        .context("failed to bind QUIC endpoint")?;
    Ok(web_transport_quinn::Server::new(endpoint))
}

async fn reload_certificates(
    config_path: PathBuf,
    addr: SocketAddr,
    provider: web_transport_quinn::crypto::Provider,
    resolver: Arc<ReloadingCertResolver>,
) {
    let (reload_tx, mut reload_rx) = tokio::sync::mpsc::unbounded_channel();
    let mut watcher = match create_certificate_watcher(reload_tx.clone()) {
        Ok(watcher) => watcher,
        Err(err) => {
            warn!(
                ?err,
                "failed to create certificate watcher; scheduled refresh remains active"
            );
            schedule_certificate_refreshes(reload_tx);
            return scheduled_reload_loop(config_path, addr, provider, resolver, &mut reload_rx)
                .await;
        }
    };

    let mut watch_state = CertificateWatchState::default();
    match load_or_default(&config_path) {
        Ok(config) => {
            if let Err(err) =
                update_certificate_watches(&mut watcher, &mut watch_state, &config_path, &config)
            {
                warn!(?err, "failed to initialize certificate watches");
            }
        }
        Err(err) => {
            warn!(?err, config = %config_path.display(), "failed to read config for certificate watcher setup");
            watch_config_parent(&mut watcher, &mut watch_state, &config_path);
        }
    }

    schedule_certificate_refreshes(reload_tx);

    loop {
        let Some(trigger) = reload_rx.recv().await else {
            break;
        };

        let trigger = match collect_reload_triggers(trigger, &mut reload_rx).await {
            Some(trigger) => trigger,
            None => continue,
        };

        let mut config = match load_or_default(&config_path) {
            Ok(config) => config,
            Err(err) => {
                warn!(?err, config = %config_path.display(), "failed to read config for certificate reload");
                continue;
            }
        };
        let next_reload_key = certificate_reload_key(&config);
        let should_reload = match trigger {
            CertificateReloadTrigger::Scheduled => uses_scheduled_certificate_refresh(&config),
            CertificateReloadTrigger::Filesystem(paths) => {
                if watch_state.config_changed(&paths) {
                    next_reload_key != watch_state.reload_key
                } else {
                    watch_state.certificate_changed(&paths) || paths.is_empty()
                }
            }
        };

        if !should_reload {
            if let Err(err) =
                update_certificate_watches(&mut watcher, &mut watch_state, &config_path, &config)
            {
                warn!(?err, "failed to update certificate watches");
            }
            continue;
        }

        let response = (|| -> Result<()> {
            config.listen_addr = addr.to_string();
            let certificate =
                prepare_server_certificate(&mut config, addr, &config_path, &provider)?;
            save(&config_path, &config)?;
            if resolver.replace(certificate.certified_key)? {
                info!("reloaded WebTransport TLS certificate");
            }
            Ok(())
        })();

        if let Err(err) = response {
            warn!(
                ?err,
                "certificate reload failed; keeping previous certificate"
            );
            if resolver.current_fingerprint().is_none() {
                warn!("certificate resolver has no usable certificate");
            }
        } else {
            if let Err(err) =
                update_certificate_watches(&mut watcher, &mut watch_state, &config_path, &config)
            {
                warn!(?err, "failed to update certificate watches");
            }
        }
    }
}

async fn scheduled_reload_loop(
    config_path: PathBuf,
    addr: SocketAddr,
    provider: web_transport_quinn::crypto::Provider,
    resolver: Arc<ReloadingCertResolver>,
    reload_rx: &mut tokio::sync::mpsc::UnboundedReceiver<CertificateReloadTrigger>,
) {
    while let Some(trigger) = reload_rx.recv().await {
        if !matches!(trigger, CertificateReloadTrigger::Scheduled) {
            continue;
        }
        let response = (|| -> Result<()> {
            let mut config = load_or_default(&config_path)?;
            if !uses_scheduled_certificate_refresh(&config) {
                return Ok(());
            }
            config.listen_addr = addr.to_string();
            let certificate =
                prepare_server_certificate(&mut config, addr, &config_path, &provider)?;
            save(&config_path, &config)?;
            resolver.replace(certificate.certified_key)?;
            Ok(())
        })();
        if let Err(err) = response {
            warn!(?err, "scheduled certificate reload failed");
        }
    }
}

fn create_certificate_watcher(
    reload_tx: tokio::sync::mpsc::UnboundedSender<CertificateReloadTrigger>,
) -> Result<notify::RecommendedWatcher> {
    Ok(notify::recommended_watcher(
        move |event: notify::Result<Event>| match event {
            Ok(event) => {
                let _ = reload_tx.send(CertificateReloadTrigger::Filesystem(event.paths));
            }
            Err(err) => {
                warn!(?err, "certificate watcher event failed");
            }
        },
    )?)
}

fn schedule_certificate_refreshes(
    reload_tx: tokio::sync::mpsc::UnboundedSender<CertificateReloadTrigger>,
) {
    tokio::spawn(async move {
        loop {
            tokio::time::sleep(SCHEDULED_CERT_REFRESH_INTERVAL).await;
            if reload_tx.send(CertificateReloadTrigger::Scheduled).is_err() {
                break;
            }
        }
    });
}

async fn collect_reload_triggers(
    first: CertificateReloadTrigger,
    reload_rx: &mut tokio::sync::mpsc::UnboundedReceiver<CertificateReloadTrigger>,
) -> Option<CertificateReloadTrigger> {
    if matches!(first, CertificateReloadTrigger::Scheduled) {
        return Some(first);
    }

    tokio::time::sleep(CERT_RELOAD_DEBOUNCE).await;
    let mut paths = match first {
        CertificateReloadTrigger::Filesystem(paths) => paths,
        CertificateReloadTrigger::Scheduled => return Some(CertificateReloadTrigger::Scheduled),
    };

    while let Ok(trigger) = reload_rx.try_recv() {
        match trigger {
            CertificateReloadTrigger::Filesystem(next_paths) => paths.extend(next_paths),
            CertificateReloadTrigger::Scheduled => {
                return Some(CertificateReloadTrigger::Scheduled);
            }
        }
    }

    Some(CertificateReloadTrigger::Filesystem(paths))
}

#[derive(Debug)]
enum CertificateReloadTrigger {
    Filesystem(Vec<PathBuf>),
    Scheduled,
}

#[derive(Default)]
struct CertificateWatchState {
    watched_dirs: HashSet<PathBuf>,
    config_file: PathBuf,
    certificate_files: HashSet<PathBuf>,
    reload_key: String,
}

impl CertificateWatchState {
    fn config_changed(&self, paths: &[PathBuf]) -> bool {
        paths
            .iter()
            .any(|path| normalized_path_key(path) == normalized_path_key(&self.config_file))
    }

    fn certificate_changed(&self, paths: &[PathBuf]) -> bool {
        paths.iter().any(|path| {
            let path = normalized_path_key(path);
            self.certificate_files
                .iter()
                .any(|cert_path| path == normalized_path_key(cert_path))
        })
    }
}

fn update_certificate_watches(
    watcher: &mut notify::RecommendedWatcher,
    state: &mut CertificateWatchState,
    config_path: &Path,
    config: &SystemConfig,
) -> Result<()> {
    state.config_file = absolute_path(config_path);
    state.reload_key = certificate_reload_key(config);
    state.certificate_files = configured_certificate_paths(config, config_path)?
        .into_iter()
        .map(|path| absolute_path(&path))
        .collect();

    watch_config_parent(watcher, state, config_path);
    for path in state.certificate_files.clone() {
        watch_parent_dir(watcher, state, &path);
    }

    Ok(())
}

fn watch_config_parent(
    watcher: &mut notify::RecommendedWatcher,
    state: &mut CertificateWatchState,
    config_path: &Path,
) {
    state.config_file = absolute_path(config_path);
    watch_parent_dir(watcher, state, config_path);
}

fn watch_parent_dir(
    watcher: &mut notify::RecommendedWatcher,
    state: &mut CertificateWatchState,
    path: &Path,
) {
    let Some(parent) = path.parent() else {
        return;
    };
    let parent = absolute_path(parent);
    if !state.watched_dirs.insert(parent.clone()) {
        return;
    }
    if let Err(err) = watcher.watch(&parent, RecursiveMode::NonRecursive) {
        warn!(?err, path = %parent.display(), "failed to watch certificate directory");
    }
}

fn absolute_path(path: &Path) -> PathBuf {
    if path.is_absolute() {
        path.to_path_buf()
    } else {
        std::env::current_dir()
            .unwrap_or_else(|_| PathBuf::from("."))
            .join(path)
    }
}

fn normalized_path_key(path: &Path) -> String {
    absolute_path(path)
        .to_string_lossy()
        .replace('\\', "/")
        .to_ascii_lowercase()
}

fn certificate_reload_key(config: &SystemConfig) -> String {
    if let Some(tls) = &config.tls {
        format!("tls:{}:{}", tls.cert_file, tls.key_file)
    } else if let Some(domain) = config.domain.as_deref() {
        format!(
            "domain:{}",
            domain.trim().trim_end_matches('.').to_ascii_lowercase()
        )
    } else {
        "unconfigured".to_string()
    }
}

async fn handle_request(
    request: web_transport_quinn::Request,
    config_path: PathBuf,
    config_state: SharedSystemConfig,
) -> Result<()> {
    let path = request.url.path().to_string();
    match path.as_str() {
        "/rpc" => {
            let session = request.respond(ConnectResponse::OK).await?;
            run_rpc_session(session, config_path, config_state).await
        }
        "/moqt" => {
            let session = request.respond(ConnectResponse::OK).await?;
            info!("accepted reserved /moqt session");
            session.close(0, b"moqt route reserved");
            Ok(())
        }
        _ => {
            request.reject(http::StatusCode::NOT_FOUND).await?;
            Ok(())
        }
    }
}

async fn run_rpc_session(
    session: web_transport_quinn::Session,
    config_path: PathBuf,
    config_state: SharedSystemConfig,
) -> Result<()> {
    let session_state = Arc::new(Mutex::new(RpcSessionState::default()));
    loop {
        tokio::select! {
            stream = session.accept_bi() => {
                let (mut send, mut recv) = stream?;
                let config_path = config_path.clone();
                let config_state = config_state.clone();
                let session_state = session_state.clone();
                tokio::spawn(async move {
                    let response = async {
                        let messages = read_reqres_message_sequence_from_stream(&mut recv)
                            .await
                            .context("invalid reqres message sequence")?;
                        handle_reqres_stream(
                            messages,
                            &mut send,
                            &config_path,
                            config_state,
                            session_state,
                        )
                        .await?;
                        send.finish()?;
                        Result::<()>::Ok(())
                    }
                    .await;
                    if let Err(err) = response {
                        warn!(?err, "RPC stream failed");
                    }
                });
            }
            datagram = session.read_datagram() => {
                let datagram = datagram?;
                if let Some(response) = handle_wire_datagram(&datagram) {
                    if response.len() > session.max_datagram_size() {
                        warn!(size = response.len(), max = session.max_datagram_size(), "datagram response exceeds transport limit");
                    } else if let Err(err) = session.send_datagram(response.into()) {
                        warn!(?err, "failed to send datagram response");
                    }
                }
            }
        }
    }
}

fn handle_wire_datagram(bytes: &[u8]) -> Option<Vec<u8>> {
    match DatagramMessage::decode(bytes) {
        Ok(DatagramMessage::Ping { ping_id }) => Some(DatagramMessage::Pong { ping_id }.encode()),
        Ok(DatagramMessage::Pong { .. }) => None,
        Err(err) => {
            warn!(?err, "ignoring malformed datagram message");
            None
        }
    }
}

fn is_subscription_proc(proc_id: u64) -> bool {
    proc_id == ProcId::SubscribeRoots.as_u64() || proc_id == ProcId::SubscribeDirectory.as_u64()
}

async fn read_reqres_message_sequence_from_stream(
    recv: &mut web_transport_quinn::RecvStream,
) -> Result<Vec<ReqResMessage>> {
    let bytes = recv.read_to_end(MAX_MESSAGE_SEQUENCE_SIZE).await?;
    ReqResMessage::decode_sequence(&bytes).map_err(Into::into)
}

async fn handle_reqres_messages(
    messages: Vec<ReqResMessage>,
    config_path: &Path,
    config_state: SharedSystemConfig,
    session_state: SharedRpcSessionState,
) -> Result<Vec<ReqResMessage>> {
    let Some(first) = messages.first() else {
        return Ok(vec![generic_error_message(
            0,
            RpcErrorCode::BadMessage,
            "reqres message sequence is empty",
        )]);
    };
    if first.is_session_control() {
        handle_session_control_messages(messages, config_state, session_state).await
    } else {
        handle_rpc_messages(messages, config_path, config_state, session_state).await
    }
}

async fn handle_reqres_stream(
    messages: Vec<ReqResMessage>,
    send: &mut web_transport_quinn::SendStream,
    config_path: &Path,
    config_state: SharedSystemConfig,
    session_state: SharedRpcSessionState,
) -> Result<()> {
    if let Some((proc_id, payload)) = request_unary_parts(&messages) {
        if is_subscription_proc(proc_id) {
            return handle_subscription_stream(proc_id, payload, send, config_state, session_state)
                .await;
        }
    }

    let responses =
        handle_reqres_messages(messages, config_path, config_state, session_state).await?;
    write_reqres_messages(send, &responses).await
}

fn request_unary_parts(messages: &[ReqResMessage]) -> Option<(u64, Option<Vec<u8>>)> {
    if messages.len() != 1 {
        return None;
    }
    match &messages[0] {
        ReqResMessage::RequestUnary { proc_id, payload } => Some((*proc_id, payload.clone())),
        _ => None,
    }
}

async fn handle_subscription_stream(
    proc_id: u64,
    payload: Option<Vec<u8>>,
    send: &mut web_transport_quinn::SendStream,
    _config_state: SharedSystemConfig,
    session_state: SharedRpcSessionState,
) -> Result<()> {
    if requires_authentication(proc_id) && !is_authenticated(&session_state).await {
        write_reqres_message(
            send,
            stream_generic_error_message(
                proc_id,
                RpcErrorCode::Unauthorized,
                "valid paired client credentials are required",
            ),
        )
        .await?;
        return Ok(());
    }

    let files = WindowsFileService::default();
    if proc_id == ProcId::SubscribeRoots.as_u64() {
        return stream_roots_subscription(send, files, proc_id).await;
    }

    let Some(payload) = payload else {
        write_reqres_message(
            send,
            stream_generic_error_message(
                proc_id,
                RpcErrorCode::MissingPayload,
                "SubscribeDirectory requires a payload",
            ),
        )
        .await?;
        return Ok(());
    };
    let request = match wgo_daemon_core::rpc::SubscribeDirectoryReq::decode(&payload) {
        Ok(request) => request,
        Err(_) => {
            write_reqres_message(
                send,
                stream_generic_error_message(
                    proc_id,
                    RpcErrorCode::MalformedPayload,
                    "SubscribeDirectory payload is malformed",
                ),
            )
            .await?;
            return Ok(());
        }
    };
    stream_directory_subscription(send, files, proc_id, request.path).await
}

async fn stream_roots_subscription(
    send: &mut web_transport_quinn::SendStream,
    files: WindowsFileService,
    proc_id: u64,
) -> Result<()> {
    let mut rows = match files.roots().await {
        Ok(rows) => rows,
        Err(err) => {
            write_reqres_message(send, stream_service_error_message(proc_id, err)).await?;
            return Ok(());
        }
    };
    write_reqres_message(
        send,
        stream_start_payload_message(RootsTableEvent::Snapshot { rows: rows.clone() }.encode()),
    )
    .await?;

    let mut interval = tokio::time::interval(ROOTS_SUBSCRIPTION_POLL_INTERVAL);
    loop {
        interval.tick().await;
        match files.roots().await {
            Ok(next_rows) => {
                if let Some(event) = roots_patch(&rows, &next_rows) {
                    write_reqres_message(send, stream_chunk_payload_message(event.encode()))
                        .await?;
                    rows = next_rows;
                }
            }
            Err(err) => {
                let reason = roots_close_reason_for_error(&err);
                write_reqres_message(
                    send,
                    stream_chunk_payload_message(RootsTableEvent::Closed { reason }.encode()),
                )
                .await?;
                return Ok(());
            }
        }
    }
}

async fn stream_directory_subscription(
    send: &mut web_transport_quinn::SendStream,
    files: WindowsFileService,
    proc_id: u64,
    path: String,
) -> Result<()> {
    if let Err(err) = files.list_directory(path.clone()).await {
        write_reqres_message(send, stream_service_error_message(proc_id, err)).await?;
        return Ok(());
    }

    let (_watcher, mut events) = match create_subscription_watcher(Path::new(&path)) {
        Ok(watcher) => watcher,
        Err(err) => {
            write_reqres_message(
                send,
                stream_error_message(proc_id, "failed", &err.to_string()),
            )
            .await?;
            return Ok(());
        }
    };

    let mut rows = match files.list_directory(path.clone()).await {
        Ok(rows) => rows,
        Err(err) => {
            write_reqres_message(send, stream_service_error_message(proc_id, err)).await?;
            return Ok(());
        }
    };
    write_reqres_message(
        send,
        stream_start_payload_message(DirectoryTableEvent::Snapshot { rows: rows.clone() }.encode()),
    )
    .await?;

    loop {
        match events.recv().await {
            Some(Ok(_)) => {}
            Some(Err(err)) => {
                warn!(?err, path, "filesystem subscription watcher failed");
                write_reqres_message(
                    send,
                    stream_chunk_payload_message(
                        DirectoryTableEvent::Closed {
                            reason: DirectorySubscriptionCloseReason::Failed,
                        }
                        .encode(),
                    ),
                )
                .await?;
                return Ok(());
            }
            None => {
                write_reqres_message(
                    send,
                    stream_chunk_payload_message(
                        DirectoryTableEvent::Closed {
                            reason: DirectorySubscriptionCloseReason::Failed,
                        }
                        .encode(),
                    ),
                )
                .await?;
                return Ok(());
            }
        }

        tokio::time::sleep(SUBSCRIPTION_DEBOUNCE).await;
        while let Ok(event) = events.try_recv() {
            if let Err(err) = event {
                warn!(
                    ?err,
                    path, "filesystem subscription watcher failed during debounce"
                );
            }
        }

        match files.list_directory(path.clone()).await {
            Ok(next_rows) => {
                if let Some(event) = directory_patch(&rows, &next_rows) {
                    write_reqres_message(send, stream_chunk_payload_message(event.encode()))
                        .await?;
                    rows = next_rows;
                }
            }
            Err(err) => {
                let reason = directory_close_reason_for_error(&err);
                write_reqres_message(
                    send,
                    stream_chunk_payload_message(DirectoryTableEvent::Closed { reason }.encode()),
                )
                .await?;
                return Ok(());
            }
        }
    }
}

fn create_subscription_watcher(
    path: &Path,
) -> Result<(
    notify::RecommendedWatcher,
    tokio::sync::mpsc::UnboundedReceiver<notify::Result<Event>>,
)> {
    let (tx, rx) = tokio::sync::mpsc::unbounded_channel();
    let mut watcher = notify::recommended_watcher(move |event| {
        let _ = tx.send(event);
    })?;
    watcher.watch(path, RecursiveMode::NonRecursive)?;
    Ok((watcher, rx))
}

fn roots_patch(previous: &[FsEntry], next: &[FsEntry]) -> Option<RootsTableEvent> {
    let previous_by_path: BTreeMap<&str, &FsEntry> = previous
        .iter()
        .map(|entry| (entry.path.as_str(), entry))
        .collect();
    let next_by_path: BTreeMap<&str, &FsEntry> = next
        .iter()
        .map(|entry| (entry.path.as_str(), entry))
        .collect();

    let removes = previous_by_path
        .keys()
        .filter(|path| !next_by_path.contains_key(**path))
        .map(|path| RootEntryKey {
            path: (*path).to_string(),
        })
        .collect::<Vec<_>>();
    let upserts = next_by_path
        .iter()
        .filter_map(|(path, entry)| {
            if previous_by_path.get(path).copied() == Some(*entry) {
                None
            } else {
                Some((*entry).clone())
            }
        })
        .collect::<Vec<_>>();

    if removes.is_empty() && upserts.is_empty() {
        None
    } else {
        Some(RootsTableEvent::Patch { removes, upserts })
    }
}

fn directory_patch(previous: &[FsEntry], next: &[FsEntry]) -> Option<DirectoryTableEvent> {
    let previous_by_name: BTreeMap<&str, &FsEntry> = previous
        .iter()
        .map(|entry| (entry.name.as_str(), entry))
        .collect();
    let next_by_name: BTreeMap<&str, &FsEntry> = next
        .iter()
        .map(|entry| (entry.name.as_str(), entry))
        .collect();

    let removes = previous_by_name
        .keys()
        .filter(|name| !next_by_name.contains_key(**name))
        .map(|name| DirectoryEntryKey {
            name: (*name).to_string(),
        })
        .collect::<Vec<_>>();
    let upserts = next_by_name
        .iter()
        .filter_map(|(name, entry)| {
            if previous_by_name.get(name).copied() == Some(*entry) {
                None
            } else {
                Some((*entry).clone())
            }
        })
        .collect::<Vec<_>>();

    if removes.is_empty() && upserts.is_empty() {
        None
    } else {
        Some(DirectoryTableEvent::Patch { removes, upserts })
    }
}

fn roots_close_reason_for_error(err: &ServiceError) -> RootsSubscriptionCloseReason {
    match err {
        ServiceError::PermissionDenied => RootsSubscriptionCloseReason::PermissionLost,
        ServiceError::OperationFailed(_) => RootsSubscriptionCloseReason::Failed,
        _ => RootsSubscriptionCloseReason::Unknown,
    }
}

fn directory_close_reason_for_error(err: &ServiceError) -> DirectorySubscriptionCloseReason {
    match err {
        ServiceError::NotFound => DirectorySubscriptionCloseReason::Deleted,
        ServiceError::NotDirectory | ServiceError::NotFile => {
            DirectorySubscriptionCloseReason::ReplacedByNonDirectory
        }
        ServiceError::PermissionDenied => DirectorySubscriptionCloseReason::PermissionLost,
        ServiceError::OperationFailed(_) => DirectorySubscriptionCloseReason::Failed,
        _ => DirectorySubscriptionCloseReason::Unknown,
    }
}

async fn write_reqres_messages(
    send: &mut web_transport_quinn::SendStream,
    messages: &[ReqResMessage],
) -> Result<()> {
    let encoded = ReqResMessage::encode_sequence(messages);
    send.write_all(&encoded).await?;
    Ok(())
}

async fn write_reqres_message(
    send: &mut web_transport_quinn::SendStream,
    message: ReqResMessage,
) -> Result<()> {
    write_reqres_messages(send, &[message]).await
}

async fn handle_session_control_messages(
    mut messages: Vec<ReqResMessage>,
    config_state: SharedSystemConfig,
    session_state: SharedRpcSessionState,
) -> Result<Vec<ReqResMessage>> {
    if messages.len() != 1 {
        return Ok(vec![session_auth_error_message(
            SessionAuthErrorCode::MalformedPayload,
            "session authentication expects exactly one control message",
        )]);
    }

    match messages.remove(0) {
        ReqResMessage::SessionAuthenticate { mechanism, payload } => Ok(vec![
            authenticate_session_control(config_state, session_state, mechanism, payload).await?,
        ]),
        _ => Ok(vec![session_auth_error_message(
            SessionAuthErrorCode::MalformedPayload,
            "client must send SessionAuthenticate on a session-control stream",
        )]),
    }
}

async fn authenticate_session_control(
    config_state: SharedSystemConfig,
    session_state: SharedRpcSessionState,
    mechanism: String,
    payload: Vec<u8>,
) -> Result<ReqResMessage> {
    if is_authenticated(&session_state).await {
        return Ok(session_auth_error_message(
            SessionAuthErrorCode::AlreadyAuthenticated,
            "session is already authenticated",
        ));
    }
    if mechanism != PAIRED_SECRET_AUTH_MECHANISM {
        return Ok(session_auth_error_message(
            SessionAuthErrorCode::UnsupportedMechanism,
            "unsupported session authentication mechanism",
        ));
    }
    let credential = match PairedSecretCredential::decode(&payload) {
        Ok(credential) => credential,
        Err(_) => {
            return Ok(session_auth_error_message(
                SessionAuthErrorCode::MalformedPayload,
                "session authentication payload is malformed",
            ));
        }
    };
    if !verify_session_credentials(&credential, &config_state).await {
        return Ok(session_auth_error_message(
            SessionAuthErrorCode::InvalidCredentials,
            "paired credential verification failed",
        ));
    }
    session_state.lock().await.authenticated_client_id = Some(credential.credential_id);
    Ok(ReqResMessage::SessionAuthenticated)
}

async fn handle_rpc_messages(
    mut messages: Vec<ReqResMessage>,
    config_path: &Path,
    config_state: SharedSystemConfig,
    session_state: SharedRpcSessionState,
) -> Result<Vec<ReqResMessage>> {
    if messages.len() != 1 {
        return Ok(vec![generic_error_message(
            0,
            RpcErrorCode::BadMessage,
            "RPC handler expects exactly one request message",
        )]);
    }
    let (proc_id, payload) = match messages.remove(0) {
        ReqResMessage::RequestUnary { proc_id, payload } => (proc_id, payload),
        _ => {
            return Ok(vec![generic_error_message(
                0,
                RpcErrorCode::BadMessage,
                "RPC handler expects RequestUnary",
            )]);
        }
    };
    let payload = payload.as_deref();
    let files = WindowsFileService::default();
    if is_subscription_proc(proc_id) {
        return Ok(vec![stream_generic_error_message(
            proc_id,
            RpcErrorCode::BadMessage,
            "subscription RPCs must be handled by the reqres stream handler",
        )]);
    }
    if requires_authentication(proc_id) && !is_authenticated(&session_state).await {
        return Ok(vec![unauthorized_message(proc_id)]);
    }

    let response = match proc_id {
        id if id == ProcId::StartPairing.as_u64() => {
            let now = now_unix();
            let mut config = load_runtime_config(config_path, &config_state).await?;
            let Some(pairing) = config.pairing.clone() else {
                return Ok(vec![error_message(
                    proc_id,
                    "pairing_not_started",
                    "create a local pairing code before starting remote pairing",
                )]);
            };
            if now >= pairing.expires_at_unix {
                config.pairing = None;
                store_runtime_config(config_path, &config_state, config).await?;
                return Ok(vec![error_message(
                    proc_id,
                    "pairing_expired",
                    "pairing code expired",
                )]);
            }
            ok_payload_message(
                proc_id,
                StartPairingResponse {
                    expires_at_unix: pairing.expires_at_unix,
                }
                .encode(),
            )
        }
        id if id == ProcId::CompletePairing.as_u64() => {
            let Some(payload) = payload else {
                return Ok(vec![error_message(
                    proc_id,
                    "missing_payload",
                    "CompletePairing requires a payload",
                )]);
            };
            let request = match CompletePairingRequest::decode(payload) {
                Ok(request) => request,
                Err(_) => {
                    return Ok(vec![generic_error_message(
                        proc_id,
                        RpcErrorCode::MalformedPayload,
                        "CompletePairing payload is malformed",
                    )]);
                }
            };
            let now = now_unix();
            let mut config = load_runtime_config(config_path, &config_state).await?;
            let Some(pairing) = config.pairing.clone() else {
                return Ok(vec![error_message(
                    proc_id,
                    "pairing_not_started",
                    "create a local pairing code before completing pairing",
                )]);
            };
            if now >= pairing.expires_at_unix {
                config.pairing = None;
                store_runtime_config(config_path, &config_state, config).await?;
                return Ok(vec![error_message(
                    proc_id,
                    "pairing_expired",
                    "pairing code expired",
                )]);
            }
            if !verify_pairing_code(&pairing, request.code.trim(), now) {
                return Ok(vec![error_message(
                    proc_id,
                    "invalid_pairing_code",
                    "pairing code is invalid",
                )]);
            }

            let label = request.client_label.trim();
            let issued = issue_client_secret(if label.is_empty() { "browser" } else { label }, now);
            let client_id = issued.client_id.clone();
            config.clients.push(issued.record);
            config.pairing = None;
            store_runtime_config(config_path, &config_state, config).await?;

            ok_payload_message(
                proc_id,
                CompletePairingResponse {
                    client_id,
                    client_secret: issued.client_secret,
                }
                .encode(),
            )
        }
        id if id == ProcId::ReadFile.as_u64() => {
            let Some(payload) = payload else {
                return Ok(vec![error_message(
                    proc_id,
                    "missing_payload",
                    "ReadFile requires a payload",
                )]);
            };
            let request = match ReadFileReq::decode(payload) {
                Ok(request) => request,
                Err(_) => {
                    return Ok(vec![generic_error_message(
                        proc_id,
                        RpcErrorCode::MalformedPayload,
                        "ReadFile payload is malformed",
                    )]);
                }
            };
            let bytes = match files.read_file(request.path).await {
                Ok(bytes) => bytes,
                Err(err) => return Ok(vec![service_error_message(proc_id, err)]),
            };
            ok_payload_message(proc_id, ReadFileRes { bytes }.encode())
        }
        id if id == ProcId::WriteFile.as_u64() => {
            let Some(payload) = payload else {
                return Ok(vec![error_message(
                    proc_id,
                    "missing_payload",
                    "WriteFile requires a payload",
                )]);
            };
            let request = match WriteFileReq::decode(payload) {
                Ok(request) => request,
                Err(_) => {
                    return Ok(vec![generic_error_message(
                        proc_id,
                        RpcErrorCode::MalformedPayload,
                        "WriteFile payload is malformed",
                    )]);
                }
            };
            if let Err(err) = files
                .write_file(request.path, request.mode, request.bytes)
                .await
            {
                return Ok(vec![service_error_message(proc_id, err)]);
            }
            ok_void_message(proc_id)
        }
        id if id == ProcId::CreateNodes.as_u64() => {
            let Some(payload) = payload else {
                return Ok(vec![error_message(
                    proc_id,
                    "missing_payload",
                    "CreateNodes requires a payload",
                )]);
            };
            let request = match CreateNodesReq::decode(payload) {
                Ok(request) => request,
                Err(_) => {
                    return Ok(vec![generic_error_message(
                        proc_id,
                        RpcErrorCode::MalformedPayload,
                        "CreateNodes payload is malformed",
                    )]);
                }
            };
            ok_payload_message(proc_id, create_nodes(&files, request).await.encode())
        }
        id if id == ProcId::RenamePaths.as_u64() => {
            let Some(payload) = payload else {
                return Ok(vec![error_message(
                    proc_id,
                    "missing_payload",
                    "RenamePaths requires a payload",
                )]);
            };
            let request = match RenamePathsReq::decode(payload) {
                Ok(request) => request,
                Err(_) => {
                    return Ok(vec![generic_error_message(
                        proc_id,
                        RpcErrorCode::MalformedPayload,
                        "RenamePaths payload is malformed",
                    )]);
                }
            };
            ok_payload_message(proc_id, rename_paths(&files, request).await.encode())
        }
        id if id == ProcId::DeletePaths.as_u64() => {
            let Some(payload) = payload else {
                return Ok(vec![error_message(
                    proc_id,
                    "missing_payload",
                    "DeletePaths requires a payload",
                )]);
            };
            let request = match DeletePathsReq::decode(payload) {
                Ok(request) => request,
                Err(_) => {
                    return Ok(vec![generic_error_message(
                        proc_id,
                        RpcErrorCode::MalformedPayload,
                        "DeletePaths payload is malformed",
                    )]);
                }
            };
            ok_payload_message(proc_id, delete_paths(&files, request).await.encode())
        }
        _ => error_message(
            proc_id,
            "not_implemented",
            "this RPC is reserved but not implemented in the first cut",
        ),
    };
    Ok(vec![response])
}

fn requires_authentication(proc_id: u64) -> bool {
    proc_id != ProcId::StartPairing.as_u64() && proc_id != ProcId::CompletePairing.as_u64()
}

async fn create_nodes(files: &WindowsFileService, request: CreateNodesReq) -> BulkMutationRes {
    let mut results = Vec::with_capacity(request.nodes.len());
    for (index, op) in request.nodes.into_iter().enumerate() {
        match files.create_node(op).await {
            Ok(()) => results.push(BulkMutationItemResult::ok(index)),
            Err(err) => results.push(BulkMutationItemResult::failed(index, err)),
        }
    }
    BulkMutationRes { results }
}

async fn rename_paths(files: &WindowsFileService, request: RenamePathsReq) -> BulkMutationRes {
    let mut results = Vec::with_capacity(request.ops.len());
    for (index, op) in request.ops.into_iter().enumerate() {
        match files.rename_path(op.from, op.to).await {
            Ok(()) => results.push(BulkMutationItemResult::ok(index)),
            Err(err) => results.push(BulkMutationItemResult::failed(index, err)),
        }
    }
    BulkMutationRes { results }
}

async fn delete_paths(files: &WindowsFileService, request: DeletePathsReq) -> BulkMutationRes {
    let mut results = Vec::with_capacity(request.paths.len());
    for (index, path) in request.paths.into_iter().enumerate() {
        match files.delete_path(path, request.mode).await {
            Ok(()) => results.push(BulkMutationItemResult::ok(index)),
            Err(err) => results.push(BulkMutationItemResult::failed(index, err)),
        }
    }
    BulkMutationRes { results }
}

async fn is_authenticated(session_state: &SharedRpcSessionState) -> bool {
    session_state.lock().await.authenticated_client_id.is_some()
}

async fn verify_session_credentials(
    credential: &PairedSecretCredential,
    config_state: &SharedSystemConfig,
) -> bool {
    let config = config_state.lock().await;
    config.clients.iter().any(|record| {
        record.client_id == credential.credential_id
            && verify_client_secret(record, &credential.credential_secret)
    })
}

async fn load_runtime_config(
    config_path: &Path,
    config_state: &SharedSystemConfig,
) -> Result<SystemConfig> {
    let config = load_or_default(config_path)?;
    *config_state.lock().await = config.clone();
    Ok(config)
}

async fn store_runtime_config(
    config_path: &Path,
    config_state: &SharedSystemConfig,
    config: SystemConfig,
) -> Result<()> {
    save(config_path, &config)?;
    *config_state.lock().await = config;
    Ok(())
}

fn unauthorized_message(proc_id: u64) -> ReqResMessage {
    generic_error_message(
        proc_id,
        RpcErrorCode::Unauthorized,
        "valid paired client credentials are required",
    )
}

fn now_unix() -> i64 {
    OffsetDateTime::now_utc().unix_timestamp()
}

fn ok_payload_message(_proc_id: u64, payload: Vec<u8>) -> ReqResMessage {
    ReqResMessage::ResponseUnaryOk {
        payload: Some(payload),
    }
}

fn ok_void_message(_proc_id: u64) -> ReqResMessage {
    ReqResMessage::ResponseUnaryOk { payload: None }
}

fn stream_start_payload_message(payload: Vec<u8>) -> ReqResMessage {
    ReqResMessage::ResponseStreamStart {
        payload: Some(payload),
    }
}

fn stream_chunk_payload_message(payload: Vec<u8>) -> ReqResMessage {
    ReqResMessage::ResponseStreamChunk { payload }
}

fn service_error_message(proc_id: u64, err: ServiceError) -> ReqResMessage {
    let code = service_error_code(&err);
    error_message(proc_id, code, &err.to_string())
}

fn stream_service_error_message(proc_id: u64, err: ServiceError) -> ReqResMessage {
    let code = service_error_code(&err);
    stream_error_message(proc_id, code, &err.to_string())
}

fn service_error_code(err: &ServiceError) -> &'static str {
    match err {
        ServiceError::PermissionDenied => "permission_denied",
        ServiceError::NotFound => "not_found",
        ServiceError::AlreadyExists => "already_exists",
        ServiceError::NotDirectory => "not_directory",
        ServiceError::NotFile => "not_file",
        ServiceError::InvalidPath => "invalid_path",
        ServiceError::Unsupported => "unsupported",
        ServiceError::OperationFailed(_) => "failed",
    }
}

fn error_message(proc_id: u64, code: &str, message: &str) -> ReqResMessage {
    let (error_kind, error) = match method_error_payload(proc_id, code, message) {
        Some(error) => (RpcErrorKind::Method, error),
        None => (
            RpcErrorKind::System,
            RpcErrorPayload {
                code: rpc_error_code(code),
                message: message.to_string(),
            }
            .encode(),
        ),
    };

    ReqResMessage::ResponseUnaryError { error, error_kind }
}

fn stream_error_message(proc_id: u64, code: &str, message: &str) -> ReqResMessage {
    let (error_kind, error) = match method_error_payload(proc_id, code, message) {
        Some(error) => (RpcErrorKind::Method, error),
        None => (
            RpcErrorKind::System,
            RpcErrorPayload {
                code: rpc_error_code(code),
                message: message.to_string(),
            }
            .encode(),
        ),
    };

    ReqResMessage::ResponseStreamErrorEnd { error, error_kind }
}

fn generic_error_message(_proc_id: u64, code: RpcErrorCode, message: &str) -> ReqResMessage {
    ReqResMessage::ResponseUnaryError {
        error_kind: RpcErrorKind::System,
        error: RpcErrorPayload {
            code,
            message: message.to_string(),
        }
        .encode(),
    }
}

fn stream_generic_error_message(_proc_id: u64, code: RpcErrorCode, message: &str) -> ReqResMessage {
    ReqResMessage::ResponseStreamErrorEnd {
        error_kind: RpcErrorKind::System,
        error: RpcErrorPayload {
            code,
            message: message.to_string(),
        }
        .encode(),
    }
}

fn session_auth_error_message(code: SessionAuthErrorCode, message: &str) -> ReqResMessage {
    ReqResMessage::SessionAuthError {
        code,
        message: message.to_string(),
    }
}

fn rpc_error_code(code: &str) -> RpcErrorCode {
    match code {
        "bad_message" => RpcErrorCode::BadMessage,
        "unauthorized" => RpcErrorCode::Unauthorized,
        "missing_payload" => RpcErrorCode::MissingPayload,
        "not_implemented" => RpcErrorCode::NotImplemented,
        "permission_denied" => RpcErrorCode::PermissionDenied,
        "not_found" => RpcErrorCode::NotFound,
        "already_exists" => RpcErrorCode::AlreadyExists,
        "failed" | "operation_failed" => RpcErrorCode::OperationFailed,
        "malformed_payload" => RpcErrorCode::MalformedPayload,
        _ => RpcErrorCode::OperationFailed,
    }
}

fn method_error_payload(proc_id: u64, code: &str, message: &str) -> Option<Vec<u8>> {
    let variant_id = method_error_variant(proc_id, code)?;
    Some(
        Value::Array(vec![
            Value::U64(variant_id),
            Value::Map(std::collections::BTreeMap::from([(
                1,
                Value::Text(message.to_string()),
            )])),
        ])
        .encode(),
    )
}

fn method_error_variant(proc_id: u64, code: &str) -> Option<u64> {
    match proc_id {
        id if id == ProcId::StartPairing.as_u64() => match code {
            "pairing_not_started" => Some(1),
            "pairing_expired" => Some(2),
            _ => None,
        },
        id if id == ProcId::CompletePairing.as_u64() => match code {
            "pairing_not_started" => Some(1),
            "pairing_expired" => Some(2),
            "invalid_pairing_code" => Some(3),
            _ => None,
        },
        id if id == ProcId::SubscribeRoots.as_u64() => match code {
            "failed" => Some(0),
            _ => None,
        },
        id if id == ProcId::SubscribeDirectory.as_u64() => match code {
            "failed" => Some(0),
            "permission_denied" => Some(1),
            "not_found" => Some(2),
            "not_directory" => Some(3),
            _ => None,
        },
        id if id == ProcId::ReadFile.as_u64() => match code {
            "failed" => Some(0),
            "permission_denied" => Some(1),
            "not_found" => Some(2),
            "not_file" => Some(3),
            "invalid_path" => Some(4),
            _ => None,
        },
        id if id == ProcId::WriteFile.as_u64() => match code {
            "failed" => Some(0),
            "permission_denied" => Some(1),
            "not_found" => Some(2),
            "already_exists" => Some(3),
            "not_directory" => Some(4),
            "not_file" => Some(5),
            "invalid_path" => Some(6),
            _ => None,
        },
        id if id == ProcId::CreateNodes.as_u64()
            || id == ProcId::RenamePaths.as_u64()
            || id == ProcId::DeletePaths.as_u64() =>
        {
            match code {
                "failed" => Some(0),
                _ => None,
            }
        }
        _ => None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use wgo_daemon_core::pairing::create_pairing_code;
    use wgo_daemon_core::rpc::FsEntryKind;

    #[tokio::test]
    async fn complete_pairing_reads_config_written_after_server_start() {
        let dir = tempfile::tempdir().unwrap();
        let config_path = dir.path().join("wgo.yaml");
        let pairing = create_pairing_code(now_unix());
        let config = SystemConfig {
            pairing: Some(pairing.record.clone()),
            ..SystemConfig::default()
        };
        save(&config_path, &config).unwrap();

        let state = Arc::new(Mutex::new(SystemConfig::default()));
        let request = request_message(
            ProcId::CompletePairing,
            Some(
                CompletePairingRequest {
                    code: pairing.code,
                    client_label: "test-browser".to_string(),
                }
                .encode(),
            ),
        );
        let session_state = Arc::new(Mutex::new(RpcSessionState::default()));
        let responses = handle_rpc_messages(
            vec![request],
            &config_path,
            state.clone(),
            session_state.clone(),
        )
        .await
        .unwrap();
        assert_eq!(responses.len(), 1);
        let response = &responses[0];

        assert!(matches!(response, ReqResMessage::ResponseUnaryOk { .. }));
        let credentials = CompletePairingResponse::decode(payload(response)).unwrap();
        let stored = load_or_default(&config_path).unwrap();
        assert_eq!(stored.pairing, None);
        assert_eq!(stored.clients.len(), 1);
        assert!(verify_client_secret(
            &stored.clients[0],
            &credentials.client_secret
        ));
        assert_eq!(state.lock().await.clients.len(), 1);
        assert_eq!(session_state.lock().await.authenticated_client_id, None);
    }

    #[tokio::test]
    async fn filesystem_unary_rpc_requires_paired_client_credentials() {
        let dir = tempfile::tempdir().unwrap();
        let config_path = dir.path().join("wgo.yaml");
        save(&config_path, &SystemConfig::default()).unwrap();
        let state = Arc::new(Mutex::new(SystemConfig::default()));

        let responses = handle_rpc_messages(
            vec![request_message(ProcId::ReadFile, None)],
            &config_path,
            state,
            Arc::new(Mutex::new(RpcSessionState::default())),
        )
        .await
        .unwrap();
        assert_eq!(responses.len(), 1);
        let response = &responses[0];

        assert!(matches!(response, ReqResMessage::ResponseUnaryError { .. }));
        let error = RpcErrorPayload::decode(error(response)).unwrap();
        assert_eq!(error.code, RpcErrorCode::Unauthorized);
    }

    #[test]
    fn filesystem_method_errors_use_schema_variant_ids() {
        let response = service_error_message(ProcId::ReadFile.as_u64(), ServiceError::NotFile);

        assert_eq!(response.error_kind(), Some(RpcErrorKind::Method));
        let Value::Array(error_items) = Value::decode(error(&response)).unwrap() else {
            panic!("expected method error union");
        };
        assert_eq!(error_items.first(), Some(&Value::U64(3)));
    }

    #[test]
    fn wire_datagram_ping_returns_pong() {
        let request = DatagramMessage::Ping { ping_id: 7 }.encode();
        let response = handle_wire_datagram(&request).unwrap();

        assert_eq!(
            DatagramMessage::decode(&response).unwrap(),
            DatagramMessage::Pong { ping_id: 7 }
        );
    }

    #[test]
    fn wire_datagram_pong_is_consumed() {
        let request = DatagramMessage::Pong { ping_id: 7 }.encode();

        assert_eq!(handle_wire_datagram(&request), None);
    }

    #[test]
    fn roots_patch_reports_removed_and_changed_rows() {
        let previous = vec![
            fs_entry("System", "C:\\", FsEntryKind::Directory, Some(10)),
            fs_entry("Data", "D:\\", FsEntryKind::Directory, Some(20)),
        ];
        let next = vec![
            fs_entry("Data", "D:\\", FsEntryKind::Directory, Some(21)),
            fs_entry("Backup", "E:\\", FsEntryKind::Directory, Some(30)),
        ];

        let Some(RootsTableEvent::Patch { removes, upserts }) = roots_patch(&previous, &next)
        else {
            panic!("expected roots patch");
        };

        assert_eq!(
            removes,
            vec![RootEntryKey {
                path: "C:\\".to_string()
            }]
        );
        assert_eq!(upserts, next);
    }

    #[test]
    fn directory_patch_reports_removed_and_changed_rows() {
        let previous = vec![
            fs_entry("a.txt", "C:\\dir\\a.txt", FsEntryKind::File, Some(10)),
            fs_entry("b.txt", "C:\\dir\\b.txt", FsEntryKind::File, Some(20)),
        ];
        let next = vec![
            fs_entry("b.txt", "C:\\dir\\b.txt", FsEntryKind::File, Some(21)),
            fs_entry("c.txt", "C:\\dir\\c.txt", FsEntryKind::File, Some(30)),
        ];

        let Some(DirectoryTableEvent::Patch { removes, upserts }) =
            directory_patch(&previous, &next)
        else {
            panic!("expected directory patch");
        };

        assert_eq!(
            removes,
            vec![DirectoryEntryKey {
                name: "a.txt".to_string()
            }]
        );
        assert_eq!(upserts, next);
    }

    #[test]
    fn subscription_patch_returns_none_when_rows_are_unchanged() {
        let rows = vec![fs_entry(
            "a.txt",
            "C:\\dir\\a.txt",
            FsEntryKind::File,
            Some(10),
        )];

        assert_eq!(roots_patch(&rows, &rows), None);
        assert_eq!(directory_patch(&rows, &rows), None);
    }

    #[tokio::test]
    async fn session_authenticate_marks_session_authenticated() {
        let dir = tempfile::tempdir().unwrap();
        let config_path = dir.path().join("wgo.yaml");
        let issued = issue_client_secret("test-browser", now_unix());
        save(
            &config_path,
            &SystemConfig {
                clients: vec![issued.record],
                ..SystemConfig::default()
            },
        )
        .unwrap();
        let state = Arc::new(Mutex::new(load_or_default(&config_path).unwrap()));
        let session_state = Arc::new(Mutex::new(RpcSessionState::default()));

        let responses = handle_reqres_messages(
            vec![ReqResMessage::SessionAuthenticate {
                mechanism: PAIRED_SECRET_AUTH_MECHANISM.to_string(),
                payload: PairedSecretCredential {
                    credential_id: issued.client_id.clone(),
                    credential_secret: issued.client_secret,
                }
                .encode(),
            }],
            &config_path,
            state,
            session_state.clone(),
        )
        .await
        .unwrap();
        assert_eq!(responses.len(), 1);
        let response = &responses[0];

        assert!(matches!(response, ReqResMessage::SessionAuthenticated));
        assert_eq!(
            session_state.lock().await.authenticated_client_id,
            Some(issued.client_id)
        );
    }

    fn request_message(proc_id: ProcId, payload: Option<Vec<u8>>) -> ReqResMessage {
        ReqResMessage::RequestUnary {
            proc_id: proc_id.as_u64(),
            payload,
        }
    }

    fn payload(message: &ReqResMessage) -> &[u8] {
        message.payload().unwrap()
    }

    fn error(message: &ReqResMessage) -> &[u8] {
        message.error().unwrap()
    }

    fn fs_entry(name: &str, path: &str, kind: FsEntryKind, size: Option<u64>) -> FsEntry {
        FsEntry {
            name: name.to_string(),
            path: path.to_string(),
            kind,
            size,
            modified_at_ms: None,
            readonly: false,
        }
    }
}
