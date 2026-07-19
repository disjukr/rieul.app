use std::fs::{File, OpenOptions};
use std::io::{Read, Write};
use std::os::windows::io::{AsRawHandle, RawHandle};
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{mpsc, Arc};
use std::thread;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use anyhow::{anyhow, bail, Context, Result};
use rieul_daemon_core::ipc::{
    IpcProcError, ProcId, SnapshotUserTerminalShellsRes, SnapshotWindowsRes,
    UserAvailableShellInfo, UserProcessInfo, UserTerminalCloseReason, UserTerminalCommand,
    UserTerminalEvent, UserTerminalLaunchSpec,
};
use rieul_daemon_core::rpc::{AvailableShellInfo, CreateTerminalSessionReq, TerminalLaunchSpec};
use rieul_daemon_core::socket_wire::{
    SocketReqResMessage, SocketRpcErrorKind, MAX_SOCKET_WIRE_SEQUENCE_SIZE,
};
use rieul_daemon_core::traits::ServiceError;
use rieul_daemon_host::terminal::{
    HostedTerminal, HostedTerminalControl, HostedTerminalEvent, LocalTerminalBackend,
    TerminalBackend,
};
use tokio::io::{AsyncRead, AsyncReadExt, AsyncWrite, AsyncWriteExt};
use tokio::net::windows::named_pipe::{
    ClientOptions, NamedPipeClient, NamedPipeServer, ServerOptions,
};
use windows::Win32::Foundation::{CloseHandle, HANDLE};
use windows::Win32::Security::{
    GetTokenInformation, IsWellKnownSid, RevertToSelf, TokenUser, WinLocalSystemSid, TOKEN_QUERY,
    TOKEN_USER,
};
use windows::Win32::System::Pipes::{GetNamedPipeServerProcessId, ImpersonateNamedPipeClient};
use windows::Win32::System::RemoteDesktop::{
    ProcessIdToSessionId, WTSActive, WTSEnumerateSessionsW, WTSFreeMemory,
    WTSGetActiveConsoleSessionId, WTS_SESSION_INFOW,
};
use windows::Win32::System::Threading::{GetCurrentProcessId, GetCurrentThread, OpenThreadToken};

const PIPE_BUSY_RETRY_DELAY: Duration = Duration::from_millis(25);
const PIPE_BUSY_RETRY_COUNT: usize = 120;
const ERROR_FILE_NOT_FOUND: i32 = 2;
const ERROR_PIPE_BUSY: i32 = 231;
const MAX_USER_PIPE_INSTANCES: usize = 32;
const MAX_TERMINAL_IO_CHUNK: usize = 64 * 1024;
const STREAM_ID: u64 = 1;

#[derive(Clone)]
struct UserProcessServerContext {
    info: UserProcessInfo,
    terminal_backend: Arc<LocalTerminalBackend>,
}

pub struct WindowsUserTerminalBackend {
    profile_id: String,
}

impl WindowsUserTerminalBackend {
    pub fn new(profile_id: impl Into<String>) -> Self {
        Self {
            profile_id: profile_id.into(),
        }
    }
}

pub fn user_pipe_name(profile_id: &str, session_id: u32) -> String {
    format!(r"\\.\pipe\rieul-user-profile-{profile_id}-session-{session_id}")
}

pub fn active_console_session_id() -> Result<u32> {
    let mut sessions: *mut WTS_SESSION_INFOW = std::ptr::null_mut();
    let mut count = 0;
    unsafe { WTSEnumerateSessionsW(None, 0, 1, &mut sessions, &mut count) }
        .context("enumerate active Windows login sessions")?;
    let active = if sessions.is_null() {
        Vec::new()
    } else {
        unsafe { std::slice::from_raw_parts(sessions, count as usize) }
            .iter()
            .filter(|session| session.State == WTSActive)
            .map(|session| session.SessionId)
            .collect::<Vec<_>>()
    };
    if !sessions.is_null() {
        unsafe { WTSFreeMemory(sessions.cast()) };
    }

    let console_session = unsafe { WTSGetActiveConsoleSessionId() };
    if console_session != u32::MAX && active.contains(&console_session) {
        return Ok(console_session);
    }
    match active.as_slice() {
        [session_id] => Ok(*session_id),
        [] => bail!("Windows has no active interactive login session"),
        _ => bail!("Windows has multiple active login sessions; terminal user is ambiguous"),
    }
}

pub fn current_process_session_id() -> Result<u32> {
    let mut session_id = 0;
    unsafe { ProcessIdToSessionId(GetCurrentProcessId(), &mut session_id) }
        .context("resolve current Windows login session")?;
    Ok(session_id)
}

pub async fn run_user_ipc_server(profile_id: String, shell_integration_dir: PathBuf) -> Result<()> {
    let session_id = current_process_session_id()?;
    let pipe_name = user_pipe_name(&profile_id, session_id);
    let context = Arc::new(UserProcessServerContext {
        info: UserProcessInfo {
            user_process_instance_id: new_user_process_instance_id(),
            profile_id,
            login_session_id: session_id.to_string(),
            user_name: current_user_name(),
            supported_proc_ids: vec![
                ProcId::SnapshotWindows.as_u64(),
                ProcId::GetUserProcessInfo.as_u64(),
                ProcId::SnapshotUserTerminalShells.as_u64(),
                ProcId::HostUserTerminal.as_u64(),
            ],
        },
        terminal_backend: Arc::new(LocalTerminalBackend::new(shell_integration_dir)),
    });

    let mut first = true;
    let mut server = create_user_pipe(&pipe_name, first)?;
    first = false;
    loop {
        server.connect().await?;
        let connected = server;
        server = create_user_pipe(&pipe_name, first)?;
        let context = context.clone();
        tokio::spawn(async move {
            if let Err(err) = handle_user_connection(connected, context).await {
                tracing::warn!(?err, "user process IPC connection failed");
            }
        });
    }
}

fn create_user_pipe(pipe_name: &str, first: bool) -> Result<NamedPipeServer> {
    let mut options = ServerOptions::new();
    options.max_instances(MAX_USER_PIPE_INSTANCES);
    if first {
        options.first_pipe_instance(true);
    }
    options
        .create(pipe_name)
        .with_context(|| format!("create user process pipe {pipe_name}"))
}

async fn handle_user_connection(
    pipe: NamedPipeServer,
    context: Arc<UserProcessServerContext>,
) -> Result<()> {
    verify_user_pipe_client(&pipe)?;
    let (mut reader, mut writer) = tokio::io::split(pipe);
    let mut messages = AsyncSocketWireReader::new();
    let first = messages.read_next(&mut reader).await?;
    match first {
        SocketReqResMessage::RequestUnary {
            proc_id,
            payload,
            stream_id,
        } => {
            expect_request_end(&mut messages, &mut reader, stream_id).await?;
            handle_user_unary(proc_id, payload, stream_id, &context, &mut writer).await
        }
        SocketReqResMessage::RequestStreamStart {
            proc_id,
            payload,
            stream_id,
        } if ProcId::from_u64(proc_id) == Some(ProcId::HostUserTerminal) => {
            handle_host_terminal(
                payload,
                stream_id,
                context.terminal_backend.clone(),
                messages,
                reader,
                writer,
            )
            .await
        }
        other => bail!("unsupported first user process IPC message {other:?}"),
    }
}

async fn handle_user_unary<W: AsyncWrite + Unpin>(
    proc_id: u64,
    payload: Option<Vec<u8>>,
    stream_id: u64,
    context: &UserProcessServerContext,
    writer: &mut W,
) -> Result<()> {
    if payload.is_some() {
        return write_unary_error(
            writer,
            stream_id,
            IpcProcError::Rejected {
                message: "unary user process request must not include a payload".to_string(),
            },
        )
        .await;
    }

    let response = match ProcId::from_u64(proc_id) {
        Some(ProcId::SnapshotWindows) => {
            let windows = tokio::task::spawn_blocking(crate::windows::snapshot)
                .await
                .map_err(|err| anyhow!(err))??;
            SnapshotWindowsRes {
                windows: windows.into_iter().map(Into::into).collect(),
            }
            .encode()
        }
        Some(ProcId::GetUserProcessInfo) => context.info.encode(),
        Some(ProcId::SnapshotUserTerminalShells) => {
            let shells = context
                .terminal_backend
                .available_shells()
                .map_err(service_error)?;
            SnapshotUserTerminalShellsRes {
                shells: shells.into_iter().map(user_shell_info).collect(),
            }
            .encode()
        }
        _ => {
            return write_unary_error(
                writer,
                stream_id,
                IpcProcError::Unsupported {
                    message: format!("user process IPC proc {proc_id} is not implemented"),
                },
            )
            .await;
        }
    };

    write_messages(
        writer,
        &[
            SocketReqResMessage::ResponseUnaryOk {
                payload: Some(response),
                stream_id,
            },
            SocketReqResMessage::ResponseStreamEnd { stream_id },
        ],
    )
    .await
}

async fn handle_host_terminal<R, W>(
    payload: Option<Vec<u8>>,
    stream_id: u64,
    backend: Arc<LocalTerminalBackend>,
    mut messages: AsyncSocketWireReader,
    mut reader: R,
    mut writer: W,
) -> Result<()>
where
    R: AsyncRead + Unpin,
    W: AsyncWrite + Unpin,
{
    let start = match decode_user_command(payload.as_deref()) {
        Ok(UserTerminalCommand::Start {
            cols,
            rows,
            cwd,
            launch,
        }) => CreateTerminalSessionReq {
            cols,
            rows,
            cwd,
            launch: TerminalLaunchSpec {
                command: launch.command,
                args: launch.args,
            },
            title: None,
        },
        Ok(_) => {
            return write_stream_error(
                &mut writer,
                stream_id,
                IpcProcError::Rejected {
                    message: "HostUserTerminal must start with Start".to_string(),
                },
            )
            .await;
        }
        Err(err) => {
            return write_stream_error(
                &mut writer,
                stream_id,
                IpcProcError::Rejected {
                    message: err.to_string(),
                },
            )
            .await;
        }
    };

    let mut hosted = match backend.spawn(&start) {
        Ok(hosted) => hosted,
        Err(err) => {
            return write_stream_error(
                &mut writer,
                stream_id,
                IpcProcError::Failed {
                    message: service_error(err).to_string(),
                },
            )
            .await;
        }
    };
    write_messages(
        &mut writer,
        &[SocketReqResMessage::ResponseStreamStart {
            payload: Some(
                UserTerminalEvent::Started {
                    cwd: hosted.initial_cwd.clone(),
                }
                .encode(),
            ),
            stream_id,
        }],
    )
    .await?;

    let (event_tx, mut event_rx) = tokio::sync::mpsc::unbounded_channel();
    thread::spawn(move || {
        while let Ok(event) = hosted.events.recv() {
            if event_tx.send(event).is_err() {
                break;
            }
        }
    });

    loop {
        tokio::select! {
            message = messages.read_next(&mut reader) => {
                let message = match message {
                    Ok(message) => message,
                    Err(err) => {
                        let _ = hosted.control.close();
                        return Err(err);
                    }
                };
                match message {
                    SocketReqResMessage::RequestStreamChunk { payload, stream_id: next }
                        if next == stream_id =>
                    {
                        match UserTerminalCommand::decode(&payload)
                            .map_err(|err| anyhow!("decode terminal command: {err}"))?
                        {
                            UserTerminalCommand::Input { bytes } => {
                                if bytes.len() > MAX_TERMINAL_IO_CHUNK {
                                    return finish_host_with_error(
                                        &mut hosted.control,
                                        &mut writer,
                                        stream_id,
                                        "terminal input chunk is too large",
                                    ).await;
                                }
                                hosted.control.write_input(&bytes).map_err(service_error)?;
                            }
                            UserTerminalCommand::Resize { cols, rows } => {
                                hosted.control.resize(cols, rows).map_err(service_error)?;
                            }
                            UserTerminalCommand::Close => {
                                hosted.control.close().map_err(service_error)?;
                                return finish_host_closed(&mut writer, stream_id).await;
                            }
                            UserTerminalCommand::Start { .. } => {
                                return finish_host_with_error(
                                    &mut hosted.control,
                                    &mut writer,
                                    stream_id,
                                    "terminal Start may only appear once",
                                ).await;
                            }
                        }
                    }
                    SocketReqResMessage::RequestStreamEnd { stream_id: next }
                        if next == stream_id =>
                    {
                        hosted.control.close().map_err(service_error)?;
                        return finish_host_closed(&mut writer, stream_id).await;
                    }
                    other => {
                        return finish_host_with_error(
                            &mut hosted.control,
                            &mut writer,
                            stream_id,
                            &format!("unexpected terminal IPC message {other:?}"),
                        ).await;
                    }
                }
            }
            event = event_rx.recv() => {
                let Some(event) = event else {
                    return finish_host_with_error(
                        &mut hosted.control,
                        &mut writer,
                        stream_id,
                        "terminal host event channel closed",
                    ).await;
                };
                match event {
                    HostedTerminalEvent::Output(bytes) => {
                        write_terminal_event(
                            &mut writer,
                            stream_id,
                            UserTerminalEvent::Output { bytes },
                        ).await?;
                    }
                    HostedTerminalEvent::Exited { code, signal } => {
                        write_terminal_event(
                            &mut writer,
                            stream_id,
                            UserTerminalEvent::Exited { code, signal },
                        ).await?;
                        return write_response_end(&mut writer, stream_id).await;
                    }
                    HostedTerminalEvent::Closed { message } => {
                        write_terminal_event(
                            &mut writer,
                            stream_id,
                            UserTerminalEvent::Closed {
                                reason: UserTerminalCloseReason::Failed { message },
                            },
                        ).await?;
                        return write_response_end(&mut writer, stream_id).await;
                    }
                }
            }
        }
    }
}

impl TerminalBackend for WindowsUserTerminalBackend {
    fn available_shells(&self) -> Result<Vec<AvailableShellInfo>, ServiceError> {
        verify_user_capability(&self.profile_id, ProcId::SnapshotUserTerminalShells)?;
        let payload = call_user_unary(&self.profile_id, ProcId::SnapshotUserTerminalShells)?;
        let response = SnapshotUserTerminalShellsRes::decode(&payload)
            .map_err(|err| ServiceError::OperationFailed(err.to_string()))?;
        Ok(response.shells.into_iter().map(public_shell_info).collect())
    }

    fn spawn(&self, request: &CreateTerminalSessionReq) -> Result<HostedTerminal, ServiceError> {
        verify_user_capability(&self.profile_id, ProcId::HostUserTerminal)?;
        let start = UserTerminalCommand::Start {
            cols: request.cols,
            rows: request.rows,
            cwd: request.cwd.clone(),
            launch: UserTerminalLaunchSpec {
                command: request.launch.command.clone(),
                args: request.launch.args.clone(),
            },
        };
        let profile_id = self.profile_id.clone();
        let (command_tx, command_rx) = tokio::sync::mpsc::unbounded_channel();
        let (startup_tx, startup_rx) = mpsc::channel();
        let (event_tx, events) = mpsc::channel();
        let closed = Arc::new(AtomicBool::new(false));
        let task_closed = closed.clone();
        thread::spawn(move || {
            let runtime = match tokio::runtime::Builder::new_current_thread()
                .enable_io()
                .build()
            {
                Ok(runtime) => runtime,
                Err(err) => {
                    let _ = startup_tx.send(Err(operation_failed(err)));
                    return;
                }
            };
            runtime.block_on(run_user_terminal_client(
                profile_id,
                start,
                command_rx,
                startup_tx,
                event_tx,
                task_closed,
            ));
        });
        let initial_cwd = startup_rx
            .recv_timeout(Duration::from_secs(10))
            .map_err(|err| {
                ServiceError::OperationFailed(format!(
                    "user process terminal startup timed out: {err}"
                ))
            })??;

        Ok(HostedTerminal {
            initial_cwd,
            control: Box::new(UserHostedTerminalControl {
                commands: command_tx,
                closed,
            }),
            events,
        })
    }
}

struct UserHostedTerminalControl {
    commands: tokio::sync::mpsc::UnboundedSender<UserTerminalCommand>,
    closed: Arc<AtomicBool>,
}

impl HostedTerminalControl for UserHostedTerminalControl {
    fn write_input(&mut self, bytes: &[u8]) -> Result<(), ServiceError> {
        if bytes.len() > MAX_TERMINAL_IO_CHUNK {
            return Err(ServiceError::OperationFailed(
                "terminal input chunk is too large".to_string(),
            ));
        }
        self.send(UserTerminalCommand::Input {
            bytes: bytes.to_vec(),
        })
    }

    fn resize(&mut self, cols: u64, rows: u64) -> Result<(), ServiceError> {
        self.send(UserTerminalCommand::Resize { cols, rows })
    }

    fn close(&mut self) -> Result<(), ServiceError> {
        if self.closed.swap(true, Ordering::SeqCst) {
            return Ok(());
        }
        self.commands.send(UserTerminalCommand::Close).map_err(|_| {
            ServiceError::OperationFailed("user process terminal stream is closed".to_string())
        })
    }
}

impl UserHostedTerminalControl {
    fn send(&self, command: UserTerminalCommand) -> Result<(), ServiceError> {
        if self.closed.load(Ordering::SeqCst) {
            return Err(ServiceError::OperationFailed(
                "user process terminal stream is closed".to_string(),
            ));
        }
        self.commands.send(command).map_err(|_| {
            ServiceError::OperationFailed("user process terminal stream is closed".to_string())
        })
    }
}

impl Drop for UserHostedTerminalControl {
    fn drop(&mut self) {
        if self.closed.swap(true, Ordering::SeqCst) {
            return;
        }
        let _ = self.commands.send(UserTerminalCommand::Close);
    }
}

async fn run_user_terminal_client(
    profile_id: String,
    start: UserTerminalCommand,
    mut commands: tokio::sync::mpsc::UnboundedReceiver<UserTerminalCommand>,
    startup: mpsc::Sender<Result<Option<String>, ServiceError>>,
    events: mpsc::Sender<HostedTerminalEvent>,
    closed: Arc<AtomicBool>,
) {
    let result = run_user_terminal_client_inner(
        &profile_id,
        start,
        &mut commands,
        &startup,
        &events,
        &closed,
    )
    .await;
    if let Err(err) = result {
        if !closed.swap(true, Ordering::SeqCst) {
            let message = match &err {
                ServiceError::OperationFailed(message) => message.clone(),
                _ => format!("{err:?}"),
            };
            if startup.send(Err(err)).is_err() {
                let _ = events.send(HostedTerminalEvent::Closed { message });
            }
        }
    }
}

async fn run_user_terminal_client_inner(
    profile_id: &str,
    start: UserTerminalCommand,
    commands: &mut tokio::sync::mpsc::UnboundedReceiver<UserTerminalCommand>,
    startup: &mpsc::Sender<Result<Option<String>, ServiceError>>,
    events: &mpsc::Sender<HostedTerminalEvent>,
    closed: &Arc<AtomicBool>,
) -> Result<(), ServiceError> {
    let pipe = open_active_user_pipe_async(profile_id).await?;
    let (mut reader, mut writer) = tokio::io::split(pipe);
    write_messages(
        &mut writer,
        &[SocketReqResMessage::RequestStreamStart {
            proc_id: ProcId::HostUserTerminal.as_u64(),
            payload: Some(start.encode()),
            stream_id: STREAM_ID,
        }],
    )
    .await
    .map_err(operation_failed)?;

    let mut messages = AsyncSocketWireReader::new();
    let first = messages
        .read_next(&mut reader)
        .await
        .map_err(operation_failed)?;
    let initial_cwd = match first {
        SocketReqResMessage::ResponseStreamStart {
            payload: Some(payload),
            stream_id: STREAM_ID,
        } => match UserTerminalEvent::decode(&payload)
            .map_err(|err| ServiceError::OperationFailed(err.to_string()))?
        {
            UserTerminalEvent::Started { cwd } => cwd,
            _ => {
                return Err(ServiceError::OperationFailed(
                    "user terminal response did not start with Started".to_string(),
                ));
            }
        },
        SocketReqResMessage::ResponseStreamErrorEnd { error, .. } => {
            let message = IpcProcError::decode(&error)
                .map(|error| error.message().to_string())
                .unwrap_or_else(|err| err.to_string());
            return Err(ServiceError::OperationFailed(message));
        }
        other => {
            return Err(ServiceError::OperationFailed(format!(
                "unexpected user terminal response {other:?}"
            )));
        }
    };
    startup.send(Ok(initial_cwd)).map_err(|_| {
        ServiceError::OperationFailed("terminal startup receiver was dropped".to_string())
    })?;

    loop {
        tokio::select! {
            command = commands.recv() => {
                let Some(command) = command else {
                    write_messages(
                        &mut writer,
                        &[SocketReqResMessage::RequestStreamEnd { stream_id: STREAM_ID }],
                    ).await.map_err(operation_failed)?;
                    return Ok(());
                };
                let is_close = matches!(command, UserTerminalCommand::Close);
                let mut outgoing = vec![SocketReqResMessage::RequestStreamChunk {
                    payload: command.encode(),
                    stream_id: STREAM_ID,
                }];
                if is_close {
                    outgoing.push(SocketReqResMessage::RequestStreamEnd { stream_id: STREAM_ID });
                }
                write_messages(&mut writer, &outgoing)
                    .await
                    .map_err(operation_failed)?;
                if is_close {
                    closed.store(true, Ordering::SeqCst);
                }
            }
            message = messages.read_next(&mut reader) => {
                let message = message.map_err(operation_failed)?;
                match message {
                    SocketReqResMessage::ResponseStreamChunk {
                        payload,
                        stream_id: STREAM_ID,
                    } => match UserTerminalEvent::decode(&payload)
                        .map_err(|err| ServiceError::OperationFailed(err.to_string()))?
                    {
                        UserTerminalEvent::Output { bytes } => {
                            if events.send(HostedTerminalEvent::Output(bytes)).is_err() {
                                return Ok(());
                            }
                        }
                        UserTerminalEvent::Exited { code, signal } => {
                            closed.store(true, Ordering::SeqCst);
                            let _ = events.send(HostedTerminalEvent::Exited { code, signal });
                            return Ok(());
                        }
                        UserTerminalEvent::Closed { reason } => {
                            closed.store(true, Ordering::SeqCst);
                            let message = match reason {
                                UserTerminalCloseReason::Failed { message } => message,
                                UserTerminalCloseReason::ClosedBySystem => {
                                    "terminal closed by system".to_string()
                                }
                                UserTerminalCloseReason::UserProcessShuttingDown => {
                                    "user process is shutting down".to_string()
                                }
                            };
                            let _ = events.send(HostedTerminalEvent::Closed { message });
                            return Ok(());
                        }
                        UserTerminalEvent::Started { .. } => {
                            return Err(ServiceError::OperationFailed(
                                "user process emitted Started more than once".to_string(),
                            ));
                        }
                    },
                    SocketReqResMessage::ResponseStreamEnd { stream_id: STREAM_ID } => {
                        if !closed.load(Ordering::SeqCst) {
                            return Err(ServiceError::OperationFailed(
                                "user process terminal stream ended unexpectedly".to_string(),
                            ));
                        }
                        return Ok(());
                    }
                    SocketReqResMessage::ResponseStreamErrorEnd { error, .. } => {
                        let message = IpcProcError::decode(&error)
                            .map(|error| error.message().to_string())
                            .unwrap_or_else(|err| err.to_string());
                        return Err(ServiceError::OperationFailed(message));
                    }
                    other => {
                        return Err(ServiceError::OperationFailed(format!(
                            "unexpected user process terminal event {other:?}"
                        )));
                    }
                }
            }
        }
    }
}

async fn open_active_user_pipe_async(profile_id: &str) -> Result<NamedPipeClient, ServiceError> {
    let session_id = active_console_session_id().map_err(operation_failed)?;
    let pipe_name = user_pipe_name(profile_id, session_id);
    for attempt in 0..=PIPE_BUSY_RETRY_COUNT {
        match ClientOptions::new().open(&pipe_name) {
            Ok(pipe) => {
                verify_user_pipe_server_handle(pipe.as_raw_handle(), session_id)?;
                return Ok(pipe);
            }
            Err(err)
                if matches!(
                    err.raw_os_error(),
                    Some(ERROR_PIPE_BUSY) | Some(ERROR_FILE_NOT_FOUND)
                ) && attempt < PIPE_BUSY_RETRY_COUNT =>
            {
                tokio::time::sleep(PIPE_BUSY_RETRY_DELAY).await;
            }
            Err(err) => {
                return Err(ServiceError::OperationFailed(format!(
                    "connect user process pipe {pipe_name}: {err}"
                )));
            }
        }
    }
    Err(ServiceError::OperationFailed(format!(
        "user process pipe was unavailable: {pipe_name}"
    )))
}

fn call_user_unary(profile_id: &str, proc_id: ProcId) -> Result<Vec<u8>, ServiceError> {
    let mut pipe = open_active_user_pipe(profile_id)?;
    pipe.write_all(&SocketReqResMessage::encode_sequence(&[
        SocketReqResMessage::RequestUnary {
            proc_id: proc_id.as_u64(),
            payload: None,
            stream_id: STREAM_ID,
        },
        SocketReqResMessage::RequestStreamEnd {
            stream_id: STREAM_ID,
        },
    ]))
    .map_err(operation_failed)?;
    pipe.flush().map_err(operation_failed)?;
    let mut reader = SyncSocketWireReader::new(pipe);
    let response = reader.read_next().map_err(operation_failed)?;
    match response {
        SocketReqResMessage::ResponseUnaryOk {
            payload: Some(payload),
            stream_id: STREAM_ID,
        } => Ok(payload),
        SocketReqResMessage::ResponseUnaryError { error, .. } => {
            let message = IpcProcError::decode(&error)
                .map(|error| error.message().to_string())
                .unwrap_or_else(|err| err.to_string());
            Err(ServiceError::OperationFailed(message))
        }
        other => Err(ServiceError::OperationFailed(format!(
            "unexpected user process unary response {other:?}"
        ))),
    }
}

fn verify_user_capability(
    profile_id: &str,
    required: ProcId,
) -> Result<UserProcessInfo, ServiceError> {
    let payload = call_user_unary(profile_id, ProcId::GetUserProcessInfo)?;
    let info = UserProcessInfo::decode(&payload)
        .map_err(|err| ServiceError::OperationFailed(err.to_string()))?;
    let expected_session = active_console_session_id().map_err(operation_failed)?;
    if info.profile_id != profile_id {
        return Err(ServiceError::OperationFailed(
            "user process reported a different daemon profile".to_string(),
        ));
    }
    if info.login_session_id != expected_session.to_string() {
        return Err(ServiceError::OperationFailed(
            "user process reported a different Windows login session".to_string(),
        ));
    }
    if !info.supported_proc_ids.contains(&required.as_u64()) {
        return Err(ServiceError::Unsupported);
    }
    Ok(info)
}

fn open_active_user_pipe(profile_id: &str) -> Result<File, ServiceError> {
    let session_id = active_console_session_id().map_err(operation_failed)?;
    let pipe_name = user_pipe_name(profile_id, session_id);
    for attempt in 0..=PIPE_BUSY_RETRY_COUNT {
        match OpenOptions::new().read(true).write(true).open(&pipe_name) {
            Ok(pipe) => {
                verify_user_pipe_server(&pipe, session_id)?;
                return Ok(pipe);
            }
            Err(err)
                if matches!(
                    err.raw_os_error(),
                    Some(ERROR_PIPE_BUSY) | Some(ERROR_FILE_NOT_FOUND)
                ) && attempt < PIPE_BUSY_RETRY_COUNT =>
            {
                thread::sleep(PIPE_BUSY_RETRY_DELAY);
            }
            Err(err) => {
                return Err(ServiceError::OperationFailed(format!(
                    "connect user process pipe {pipe_name}: {err}"
                )));
            }
        }
    }
    Err(ServiceError::OperationFailed(format!(
        "user process pipe was unavailable: {pipe_name}"
    )))
}

fn verify_user_pipe_server(pipe: &File, expected_session_id: u32) -> Result<(), ServiceError> {
    verify_user_pipe_server_handle(pipe.as_raw_handle(), expected_session_id)
}

fn verify_user_pipe_server_handle(
    handle: RawHandle,
    expected_session_id: u32,
) -> Result<(), ServiceError> {
    let mut process_id = 0;
    unsafe { GetNamedPipeServerProcessId(HANDLE(handle), &mut process_id) }
        .map_err(operation_failed)?;
    let mut session_id = 0;
    unsafe { ProcessIdToSessionId(process_id, &mut session_id) }.map_err(operation_failed)?;
    if session_id != expected_session_id {
        return Err(ServiceError::PermissionDenied);
    }
    Ok(())
}

fn verify_user_pipe_client(pipe: &NamedPipeServer) -> Result<()> {
    let impersonation = NamedPipeClientImpersonation::start(pipe)?;
    let verification = verify_impersonated_pipe_client();
    impersonation.revert()?;
    verification
}

fn verify_impersonated_pipe_client() -> Result<()> {
    let mut token = HANDLE::default();
    unsafe { OpenThreadToken(GetCurrentThread(), TOKEN_QUERY, false, &mut token) }
        .context("open impersonated pipe client token")?;
    let token = OwnedTokenHandle(token);
    let is_local_system = token_user_is_local_system(token.0)?;
    // Development runs both daemons as the interactive user. Release builds
    // accept only the LocalSystem service token.
    if !is_local_system && !cfg!(debug_assertions) {
        bail!("user process IPC client is not LocalSystem");
    }
    Ok(())
}

fn token_user_is_local_system(token: HANDLE) -> Result<bool> {
    let mut required_len = 0;
    let size_result = unsafe { GetTokenInformation(token, TokenUser, None, 0, &mut required_len) };
    if required_len == 0 {
        size_result.context("resolve pipe client token user size")?;
        bail!("pipe client token user size is zero");
    }

    let word_size = std::mem::size_of::<usize>();
    let word_count = (required_len as usize).div_ceil(word_size);
    let mut buffer = vec![0_usize; word_count];
    unsafe {
        GetTokenInformation(
            token,
            TokenUser,
            Some(buffer.as_mut_ptr().cast()),
            required_len,
            &mut required_len,
        )
    }
    .context("resolve pipe client token user")?;
    let token_user = unsafe { &*buffer.as_ptr().cast::<TOKEN_USER>() };
    Ok(unsafe { IsWellKnownSid(token_user.User.Sid, WinLocalSystemSid).as_bool() })
}

struct NamedPipeClientImpersonation {
    active: bool,
}

impl NamedPipeClientImpersonation {
    fn start(pipe: &NamedPipeServer) -> Result<Self> {
        unsafe { ImpersonateNamedPipeClient(HANDLE(pipe.as_raw_handle())) }
            .context("impersonate user process IPC client")?;
        Ok(Self { active: true })
    }

    fn revert(mut self) -> Result<()> {
        unsafe { RevertToSelf() }.context("revert user process IPC client impersonation")?;
        self.active = false;
        Ok(())
    }
}

impl Drop for NamedPipeClientImpersonation {
    fn drop(&mut self) {
        if self.active {
            let _ = unsafe { RevertToSelf() };
        }
    }
}

struct OwnedTokenHandle(HANDLE);

impl Drop for OwnedTokenHandle {
    fn drop(&mut self) {
        let _ = unsafe { CloseHandle(self.0) };
    }
}

struct SyncSocketWireReader<R> {
    reader: R,
    bytes: Vec<u8>,
}

impl<R: Read> SyncSocketWireReader<R> {
    fn new(reader: R) -> Self {
        Self {
            reader,
            bytes: Vec::new(),
        }
    }

    fn read_next(&mut self) -> Result<SocketReqResMessage> {
        let mut buffer = [0_u8; 8192];
        loop {
            if let Some((message, used)) = SocketReqResMessage::decode_prefix(&self.bytes)? {
                self.bytes.drain(..used);
                return Ok(message);
            }
            let count = self.reader.read(&mut buffer)?;
            if count == 0 {
                bail!("user process pipe closed before a complete socket-wire message");
            }
            self.bytes.extend_from_slice(&buffer[..count]);
            if self.bytes.len() > MAX_SOCKET_WIRE_SEQUENCE_SIZE {
                bail!("user process socket-wire sequence is too large");
            }
        }
    }
}

struct AsyncSocketWireReader {
    bytes: Vec<u8>,
}

impl AsyncSocketWireReader {
    fn new() -> Self {
        Self { bytes: Vec::new() }
    }

    async fn read_next<R: AsyncRead + Unpin>(
        &mut self,
        reader: &mut R,
    ) -> Result<SocketReqResMessage> {
        let mut buffer = [0_u8; 8192];
        loop {
            if let Some((message, used)) = SocketReqResMessage::decode_prefix(&self.bytes)? {
                self.bytes.drain(..used);
                return Ok(message);
            }
            let count = reader.read(&mut buffer).await?;
            if count == 0 {
                bail!("user process pipe closed before a complete socket-wire message");
            }
            self.bytes.extend_from_slice(&buffer[..count]);
            if self.bytes.len() > MAX_SOCKET_WIRE_SEQUENCE_SIZE {
                bail!("user process socket-wire sequence is too large");
            }
        }
    }
}

async fn expect_request_end<R: AsyncRead + Unpin>(
    messages: &mut AsyncSocketWireReader,
    reader: &mut R,
    stream_id: u64,
) -> Result<()> {
    match messages.read_next(reader).await? {
        SocketReqResMessage::RequestStreamEnd { stream_id: next } if next == stream_id => Ok(()),
        other => bail!("expected request end, got {other:?}"),
    }
}

async fn write_messages<W: AsyncWrite + Unpin>(
    writer: &mut W,
    messages: &[SocketReqResMessage],
) -> Result<()> {
    writer
        .write_all(&SocketReqResMessage::encode_sequence(messages))
        .await?;
    writer.flush().await?;
    Ok(())
}

async fn write_unary_error<W: AsyncWrite + Unpin>(
    writer: &mut W,
    stream_id: u64,
    error: IpcProcError,
) -> Result<()> {
    write_messages(
        writer,
        &[
            SocketReqResMessage::ResponseUnaryError {
                error: error.encode(),
                error_kind: SocketRpcErrorKind::Method,
                stream_id,
            },
            SocketReqResMessage::ResponseStreamEnd { stream_id },
        ],
    )
    .await
}

async fn write_stream_error<W: AsyncWrite + Unpin>(
    writer: &mut W,
    stream_id: u64,
    error: IpcProcError,
) -> Result<()> {
    write_messages(
        writer,
        &[SocketReqResMessage::ResponseStreamErrorEnd {
            error: error.encode(),
            error_kind: SocketRpcErrorKind::Method,
            stream_id,
        }],
    )
    .await
}

async fn write_terminal_event<W: AsyncWrite + Unpin>(
    writer: &mut W,
    stream_id: u64,
    event: UserTerminalEvent,
) -> Result<()> {
    write_messages(
        writer,
        &[SocketReqResMessage::ResponseStreamChunk {
            payload: event.encode(),
            stream_id,
        }],
    )
    .await
}

async fn write_response_end<W: AsyncWrite + Unpin>(writer: &mut W, stream_id: u64) -> Result<()> {
    write_messages(
        writer,
        &[SocketReqResMessage::ResponseStreamEnd { stream_id }],
    )
    .await
}

async fn finish_host_closed<W: AsyncWrite + Unpin>(writer: &mut W, stream_id: u64) -> Result<()> {
    write_terminal_event(
        writer,
        stream_id,
        UserTerminalEvent::Closed {
            reason: UserTerminalCloseReason::ClosedBySystem,
        },
    )
    .await?;
    write_response_end(writer, stream_id).await
}

async fn finish_host_with_error<W: AsyncWrite + Unpin>(
    control: &mut Box<dyn HostedTerminalControl>,
    writer: &mut W,
    stream_id: u64,
    message: &str,
) -> Result<()> {
    let _ = control.close();
    write_stream_error(
        writer,
        stream_id,
        IpcProcError::Rejected {
            message: message.to_string(),
        },
    )
    .await
}

fn decode_user_command(payload: Option<&[u8]>) -> Result<UserTerminalCommand> {
    let payload = payload.ok_or_else(|| anyhow!("terminal start payload is missing"))?;
    UserTerminalCommand::decode(payload).map_err(|err| anyhow!(err.to_string()))
}

fn user_shell_info(shell: AvailableShellInfo) -> UserAvailableShellInfo {
    UserAvailableShellInfo {
        shell_id: shell.shell_id,
        name: shell.name,
        command: shell.command,
        args: shell.args,
        is_default: shell.is_default,
    }
}

fn public_shell_info(shell: UserAvailableShellInfo) -> AvailableShellInfo {
    AvailableShellInfo {
        shell_id: shell.shell_id,
        name: shell.name,
        command: shell.command,
        args: shell.args,
        is_default: shell.is_default,
    }
}

fn current_user_name() -> String {
    let user = std::env::var("USERNAME").unwrap_or_else(|_| "unknown".to_string());
    match std::env::var("USERDOMAIN") {
        Ok(domain) if !domain.is_empty() => format!(r"{domain}\{user}"),
        _ => user,
    }
}

fn new_user_process_instance_id() -> String {
    let now = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_nanos();
    format!("user-process-{}-{now}", std::process::id())
}

fn service_error(error: ServiceError) -> anyhow::Error {
    anyhow!(format!("{error:?}"))
}

fn operation_failed(error: impl std::fmt::Display) -> ServiceError {
    ServiceError::OperationFailed(error.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::Instant;

    #[test]
    fn user_pipe_is_profile_and_session_scoped() {
        assert_eq!(
            user_pipe_name("abc123", 7),
            r"\\.\pipe\rieul-user-profile-abc123-session-7"
        );
    }

    #[test]
    fn shell_info_mapping_preserves_launch_data() {
        let shell = UserAvailableShellInfo {
            shell_id: "bash".to_string(),
            name: "Git Bash".to_string(),
            command: r"C:\Program Files\Git\bin\bash.exe".to_string(),
            args: vec!["--login".to_string(), "-i".to_string()],
            is_default: true,
        };

        assert_eq!(public_shell_info(shell.clone()).command, shell.command);
        assert_eq!(public_shell_info(shell.clone()).args, shell.args);
        assert!(public_shell_info(shell).is_default);
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn user_process_hosts_terminal_in_the_interactive_session() {
        let Ok(current_session) = current_process_session_id() else {
            return;
        };
        let Ok(active_session) = active_console_session_id() else {
            return;
        };
        if current_session != active_session {
            return;
        }

        let profile_id = format!("terminal-ipc-test-{}", std::process::id());
        let integration_dir = std::env::temp_dir().join(&profile_id);
        let server_profile = profile_id.clone();
        let server =
            tokio::spawn(async move { run_user_ipc_server(server_profile, integration_dir).await });

        let (spawn_tx, spawn_rx) = mpsc::channel();
        thread::spawn(move || {
            let backend = WindowsUserTerminalBackend::new(profile_id);
            let result = backend.spawn(&CreateTerminalSessionReq {
                cols: 80,
                rows: 24,
                cwd: None,
                launch: TerminalLaunchSpec {
                    command: "powershell.exe".to_string(),
                    args: vec!["-NoLogo".to_string(), "-NoProfile".to_string()],
                },
                title: None,
            });
            let _ = spawn_tx.send(result);
        });
        let mut hosted = spawn_rx
            .recv_timeout(Duration::from_secs(10))
            .expect("user process terminal startup timed out")
            .expect("spawn terminal through user process IPC");
        let deadline = Instant::now() + Duration::from_secs(10);
        let mut output = Vec::new();
        let mut sent_command = false;
        loop {
            let remaining = deadline.saturating_duration_since(Instant::now());
            let event = hosted
                .events
                .recv_timeout(remaining)
                .expect("receive user process terminal event");
            match event {
                HostedTerminalEvent::Output(bytes) => {
                    if bytes.windows(4).any(|window| window == b"\x1b[6n") {
                        hosted
                            .control
                            .write_input(b"\x1b[1;1R")
                            .expect("answer terminal cursor query");
                        if !sent_command {
                            hosted
                                .control
                                .write_input(b"whoami\r\nexit\r\n")
                                .expect("write user process terminal input");
                            sent_command = true;
                        }
                    }
                    output.extend(bytes)
                }
                HostedTerminalEvent::Exited { .. } => break,
                HostedTerminalEvent::Closed { message } => {
                    panic!("user process terminal closed unexpectedly: {message}")
                }
            }
        }
        server.abort();

        let output = String::from_utf8_lossy(&output).to_ascii_lowercase();
        assert!(!output.trim().is_empty());
        assert!(!output.contains(r"nt authority\system"));
    }
}
