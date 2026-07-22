use std::collections::BTreeMap;
#[cfg(windows)]
use std::path::Path;
use std::path::PathBuf;
use std::sync::{Arc, Mutex};

use agent_client_protocol::schema::v1::{
    ContentBlock, Implementation, InitializeRequest, NewSessionRequest, PromptRequest,
    RequestPermissionOutcome, RequestPermissionRequest, RequestPermissionResponse,
    SessionNotification, SessionUpdate, StopReason,
};
use agent_client_protocol::schema::ProtocolVersion;
use agent_client_protocol::{AcpAgent, Agent, Client, ConnectionTo};
use tokio::sync::{mpsc, oneshot};

#[derive(Debug, Clone)]
pub struct AgentRuntimeConfig {
    pub command: String,
    pub args: Vec<String>,
    pub env: BTreeMap<String, String>,
    pub cwd: PathBuf,
}

#[derive(Debug, Clone)]
pub struct AgentRuntimeReady {
    pub provider_session_id: String,
    pub agent_name: Option<String>,
    pub agent_title: Option<String>,
    pub agent_version: Option<String>,
    pub load_session: bool,
    pub image_prompt: bool,
    pub audio_prompt: bool,
    pub embedded_context: bool,
}

#[derive(Debug)]
pub enum AgentRuntimeEvent {
    AgentTextChunk {
        turn_id: String,
        text: String,
    },
    Usage {
        used: u64,
        size: u64,
    },
    PromptFinished {
        turn_id: String,
        stop_reason: StopReason,
    },
    PromptFailed {
        turn_id: String,
        message: String,
    },
    Exited {
        message: Option<String>,
    },
}

#[derive(Debug)]
enum AgentRuntimeCommand {
    Prompt {
        turn_id: String,
        content: Vec<ContentBlock>,
    },
}

#[derive(Clone)]
pub struct AgentRuntimeHandle {
    commands: mpsc::UnboundedSender<AgentRuntimeCommand>,
}

impl AgentRuntimeHandle {
    pub fn prompt(&self, turn_id: String, content: Vec<ContentBlock>) -> Result<(), String> {
        self.commands
            .send(AgentRuntimeCommand::Prompt { turn_id, content })
            .map_err(|_| "agent runtime is no longer available".to_string())
    }
}

pub async fn start_agent_runtime(
    config: AgentRuntimeConfig,
    events: mpsc::UnboundedSender<AgentRuntimeEvent>,
) -> Result<(AgentRuntimeHandle, AgentRuntimeReady), String> {
    let (commands_tx, commands_rx) = mpsc::unbounded_channel();
    let (ready_tx, ready_rx) = oneshot::channel();
    let handle = AgentRuntimeHandle {
        commands: commands_tx,
    };
    tokio::spawn(async move {
        let result = run_agent_runtime(config, commands_rx, events.clone(), ready_tx).await;
        let _ = events.send(AgentRuntimeEvent::Exited {
            message: result.err(),
        });
    });
    let ready = tokio::time::timeout(std::time::Duration::from_secs(30), ready_rx)
        .await
        .map_err(|_| "agent initialization timed out".to_string())?
        .map_err(|_| "agent exited before initialization completed".to_string())??;
    Ok((handle, ready))
}

async fn run_agent_runtime(
    config: AgentRuntimeConfig,
    mut commands: mpsc::UnboundedReceiver<AgentRuntimeCommand>,
    events: mpsc::UnboundedSender<AgentRuntimeEvent>,
    ready: oneshot::Sender<Result<AgentRuntimeReady, String>>,
) -> Result<(), String> {
    let (command, command_args) = platform_command(&config.command, &config.args, &config.env);
    let mut process_args = config
        .env
        .iter()
        .map(|(name, value)| format!("{name}={value}"))
        .collect::<Vec<_>>();
    process_args.push(command);
    process_args.extend(command_args);
    let agent = AcpAgent::from_args(process_args).map_err(|error| error.to_string())?;
    let active_turn = Arc::new(Mutex::new(None::<String>));
    let notification_turn = active_turn.clone();
    let notification_events = events.clone();
    let ready = Arc::new(Mutex::new(Some(ready)));
    let connection_ready = ready.clone();

    let result = Client
        .builder()
        .name("rieul-daemon")
        .on_receive_notification(
            async move |notification: SessionNotification, _connection| {
                let turn_id = notification_turn.lock().ok().and_then(|turn| turn.clone());
                match notification.update {
                    SessionUpdate::AgentMessageChunk(chunk) => {
                        if let (Some(turn_id), ContentBlock::Text(text)) = (turn_id, chunk.content)
                        {
                            let _ = notification_events.send(AgentRuntimeEvent::AgentTextChunk {
                                turn_id,
                                text: text.text,
                            });
                        }
                    }
                    SessionUpdate::UsageUpdate(usage) => {
                        let _ = notification_events.send(AgentRuntimeEvent::Usage {
                            used: usage.used,
                            size: usage.size,
                        });
                    }
                    _ => {}
                }
                Ok(())
            },
            agent_client_protocol::on_receive_notification!(),
        )
        .on_receive_request(
            async move |_request: RequestPermissionRequest, responder, _connection| {
                responder.respond(RequestPermissionResponse::new(
                    RequestPermissionOutcome::Cancelled,
                ))
            },
            agent_client_protocol::on_receive_request!(),
        )
        .connect_with(agent, |connection: ConnectionTo<Agent>| async move {
            let initialize = connection
                .send_request(
                    InitializeRequest::new(ProtocolVersion::V1).client_info(
                        Implementation::new("rieul-daemon", env!("CARGO_PKG_VERSION"))
                            .title("Rieul Daemon"),
                    ),
                )
                .block_task()
                .await?;
            let session = connection
                .send_request(NewSessionRequest::new(config.cwd))
                .block_task()
                .await?;
            let agent_info = initialize.agent_info;
            let capabilities = initialize.agent_capabilities;
            let runtime_ready = AgentRuntimeReady {
                provider_session_id: session.session_id.to_string(),
                agent_name: agent_info.as_ref().map(|info| info.name.clone()),
                agent_title: agent_info.as_ref().and_then(|info| info.title.clone()),
                agent_version: agent_info.as_ref().map(|info| info.version.clone()),
                load_session: capabilities.load_session,
                image_prompt: capabilities.prompt_capabilities.image,
                audio_prompt: capabilities.prompt_capabilities.audio,
                embedded_context: capabilities.prompt_capabilities.embedded_context,
            };
            let ready = connection_ready
                .lock()
                .ok()
                .and_then(|mut ready| ready.take());
            let Some(ready) = ready else {
                return Ok(());
            };
            if ready.send(Ok(runtime_ready)).is_err() {
                return Ok(());
            }

            while let Some(command) = commands.recv().await {
                match command {
                    AgentRuntimeCommand::Prompt { turn_id, content } => {
                        if let Ok(mut current) = active_turn.lock() {
                            *current = Some(turn_id.clone());
                        }
                        let response = connection
                            .send_request(PromptRequest::new(session.session_id.clone(), content))
                            .block_task()
                            .await;
                        if let Ok(mut current) = active_turn.lock() {
                            *current = None;
                        }
                        match response {
                            Ok(response) => {
                                let _ = events.send(AgentRuntimeEvent::PromptFinished {
                                    turn_id,
                                    stop_reason: response.stop_reason,
                                });
                            }
                            Err(error) => {
                                let _ = events.send(AgentRuntimeEvent::PromptFailed {
                                    turn_id,
                                    message: error.to_string(),
                                });
                            }
                        }
                    }
                }
            }
            Ok(())
        })
        .await
        .map_err(|error| error.to_string());
    if let Err(message) = &result {
        if let Some(ready) = ready.lock().ok().and_then(|mut ready| ready.take()) {
            let _ = ready.send(Err(message.clone()));
        }
    }
    result
}

#[cfg(not(windows))]
fn platform_command(
    command: &str,
    args: &[String],
    _environment: &BTreeMap<String, String>,
) -> (String, Vec<String>) {
    (command.to_string(), args.to_vec())
}

#[cfg(windows)]
fn platform_command(
    command: &str,
    args: &[String],
    environment: &BTreeMap<String, String>,
) -> (String, Vec<String>) {
    let Some(resolved) = resolve_windows_command(command, environment) else {
        return (command.to_string(), args.to_vec());
    };
    let is_batch = resolved
        .extension()
        .and_then(|extension| extension.to_str())
        .is_some_and(|extension| {
            extension.eq_ignore_ascii_case("cmd") || extension.eq_ignore_ascii_case("bat")
        });
    if !is_batch {
        return (resolved.to_string_lossy().into_owned(), args.to_vec());
    }

    let mut command_args = vec![
        "/D".to_string(),
        "/S".to_string(),
        "/C".to_string(),
        resolved.to_string_lossy().into_owned(),
    ];
    command_args.extend_from_slice(args);
    ("cmd.exe".to_string(), command_args)
}

#[cfg(windows)]
fn resolve_windows_command(
    command: &str,
    environment: &BTreeMap<String, String>,
) -> Option<PathBuf> {
    let command_path = Path::new(command);
    let explicit_path = command_path.is_absolute() || command_path.components().count() > 1;
    let extensions = windows_executable_extensions(environment);
    let candidates = if explicit_path {
        vec![PathBuf::new()]
    } else {
        let search_path = environment
            .iter()
            .find(|(name, _)| name.eq_ignore_ascii_case("PATH"))
            .map(|(_, value)| std::ffi::OsString::from(value))
            .or_else(|| std::env::var_os("PATH"))?;
        std::env::split_paths(&search_path).collect()
    };
    for directory in candidates {
        let base = directory.join(command_path);
        if base.is_file() && (explicit_path || base.extension().is_some()) {
            return Some(base);
        }
        if base.extension().is_none() {
            for extension in &extensions {
                let candidate = base.with_extension(extension.trim_start_matches('.'));
                if candidate.is_file() {
                    return Some(candidate);
                }
            }
        }
    }
    None
}

#[cfg(windows)]
fn windows_executable_extensions(environment: &BTreeMap<String, String>) -> Vec<String> {
    let value = environment
        .iter()
        .find(|(name, _)| name.eq_ignore_ascii_case("PATHEXT"))
        .map(|(_, value)| value.clone())
        .or_else(|| std::env::var("PATHEXT").ok())
        .unwrap_or_else(|| ".COM;.EXE;.BAT;.CMD".to_string());
    value
        .split(';')
        .filter(|extension| !extension.is_empty())
        .map(ToOwned::to_owned)
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::Value;
    use std::time::Duration;

    const SANITIZED_CODEX_TRANSCRIPT: &str =
        include_str!("../tests/fixtures/codex-acp-text-turn.jsonl");

    #[test]
    fn sanitized_codex_transcript_replays_text_turn() {
        for forbidden in [
            "C:\\\\Users\\\\",
            "/Users/",
            "/home/",
            "@gmail.com",
            "@naver.com",
            "@icloud.com",
        ] {
            assert!(
                !SANITIZED_CODEX_TRANSCRIPT.contains(forbidden),
                "fixture contains private path or account data"
            );
        }

        let messages = SANITIZED_CODEX_TRANSCRIPT
            .lines()
            .map(|line| serde_json::from_str::<Value>(line).unwrap())
            .collect::<Vec<_>>();
        let text = messages
            .iter()
            .filter(|message| message["method"] == "session/update")
            .filter(|message| message["params"]["update"]["sessionUpdate"] == "agent_message_chunk")
            .filter_map(|message| message["params"]["update"]["content"]["text"].as_str())
            .collect::<String>();

        assert_eq!(text, "RIEUL_ACP_PROBE_OK");
        assert!(messages.iter().any(|message| {
            message["id"] == 3 && message["result"]["stopReason"] == "end_turn"
        }));
    }

    #[cfg(windows)]
    #[test]
    fn resolves_windows_batch_agent_from_path() {
        let directory = tempfile::tempdir().unwrap();
        let shim = directory.path().join("synthetic-agent.cmd");
        std::fs::write(&shim, "@echo off\r\n").unwrap();
        let environment = BTreeMap::from([
            (
                "PATH".to_string(),
                directory.path().to_string_lossy().into_owned(),
            ),
            ("PATHEXT".to_string(), ".EXE;.CMD".to_string()),
        ]);

        let (command, args) = platform_command(
            "synthetic-agent",
            &["--mode".to_string(), "text".to_string()],
            &environment,
        );

        assert_eq!(command, "cmd.exe");
        assert_eq!(&args[..3], ["/D", "/S", "/C"]);
        assert!(args[3].eq_ignore_ascii_case(&shim.to_string_lossy()));
        assert_eq!(&args[4..], ["--mode", "text"]);
    }

    #[tokio::test]
    #[ignore = "requires an installed, authenticated Codex ACP adapter"]
    async fn runs_private_data_free_text_turn_against_real_codex_acp() {
        let command = std::env::var("RIEUL_TEST_CODEX_ACP_COMMAND")
            .expect("set RIEUL_TEST_CODEX_ACP_COMMAND to the Codex ACP adapter executable");
        let args = std::env::var("RIEUL_TEST_CODEX_ACP_ARGS")
            .ok()
            .map(|args| serde_json::from_str::<Vec<String>>(&args).unwrap())
            .unwrap_or_default();
        let workspace = tempfile::tempdir().unwrap();
        let (events_tx, mut events_rx) = mpsc::unbounded_channel();
        let (runtime, ready) = start_agent_runtime(
            AgentRuntimeConfig {
                command,
                args,
                env: BTreeMap::new(),
                cwd: workspace.path().to_path_buf(),
            },
            events_tx,
        )
        .await
        .unwrap();
        assert!(!ready.provider_session_id.is_empty());

        runtime
            .prompt(
                "turn-synthetic".to_string(),
                vec![ContentBlock::Text(
                    agent_client_protocol::schema::v1::TextContent::new(
                        "Reply with exactly RIEUL_ACP_PROBE_OK",
                    ),
                )],
            )
            .unwrap();
        let reply = tokio::time::timeout(Duration::from_secs(120), async move {
            let mut reply = String::new();
            while let Some(event) = events_rx.recv().await {
                match event {
                    AgentRuntimeEvent::AgentTextChunk { text, .. } => reply.push_str(&text),
                    AgentRuntimeEvent::PromptFinished { stop_reason, .. } => {
                        assert_eq!(stop_reason, StopReason::EndTurn);
                        return reply;
                    }
                    AgentRuntimeEvent::PromptFailed { message, .. } => panic!("{message}"),
                    AgentRuntimeEvent::Exited { message } => {
                        panic!("Codex ACP exited before completing the turn: {message:?}")
                    }
                    AgentRuntimeEvent::Usage { .. } => {}
                }
            }
            panic!("Codex ACP event stream closed before completing the turn")
        })
        .await
        .expect("Codex ACP text turn timed out");

        assert_eq!(reply, "RIEUL_ACP_PROBE_OK");
    }
}
