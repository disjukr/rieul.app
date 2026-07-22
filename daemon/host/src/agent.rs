use std::collections::{BTreeMap, HashMap, HashSet};
use std::env;
use std::fs;
use std::hash::{Hash, Hasher};
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex as StdMutex};
use std::time::{SystemTime, UNIX_EPOCH};

use agent_client_protocol::schema::v1::{
    ContentBlock as AcpContentBlock, StopReason as AcpStopReason, TextContent as AcpTextContent,
};
use anyhow::Result;
use rieul_daemon_core::config::{AgentServerConfig, SystemConfig};
use rieul_daemon_core::generated::rpc::{
    AgentAttachmentState, AgentContent, AgentFailure, AgentMessage, AgentMessageRole,
    AgentMessageState, AgentProjectAvailability, AgentProjectInfo, AgentProjectsTableEvent,
    AgentProviderAuthentication, AgentProviderAvailability, AgentProviderCapabilities,
    AgentProviderInfo, AgentProvidersTableEvent, AgentSessionArchiveFilter, AgentSessionEvent,
    AgentSessionInfo, AgentSessionLiveSnapshot, AgentSessionRecoverability, AgentSessionSummary,
    AgentSessionTurnState, AgentSessionWorkspaceFilter, AgentStopReason, AgentTaskWorkspaceSource,
    AgentTaskWorkspaceState, AgentTurnInfo, AgentTurnRecord, AgentTurnState, AgentUsage,
    AgentWorkspaceBinding, CreateAgentProjectReq, CreateAgentSessionReq, CreateAgentTurnReq,
    CreateAgentWorkspace, ListAgentSessionsReq, ListAgentSessionsRes,
};
use tokio::sync::{broadcast, mpsc, watch};

use crate::agent_runtime::{
    start_agent_runtime, AgentRuntimeConfig, AgentRuntimeEvent, AgentRuntimeHandle,
};
use crate::state_db::{
    DaemonStateDb, NewAgentSession, NewAgentTaskWorkspace, StoredAgentArchiveFilter,
    StoredAgentProject, StoredAgentSession, StoredAgentSessionQuery, StoredAgentTurn,
    StoredAgentWorkspaceFilter,
};

const MAX_SESSION_PAGE_SIZE: usize = 100;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum AgentErrorKind {
    Failed,
    NotFound,
    InvalidArgument,
    Conflict,
    Unavailable,
    PermissionDenied,
}

#[derive(Debug)]
pub struct AgentError {
    pub kind: AgentErrorKind,
    pub message: String,
}

impl AgentError {
    fn new(kind: AgentErrorKind, message: impl Into<String>) -> Self {
        Self {
            kind,
            message: message.into(),
        }
    }

    fn failed(message: impl Into<String>) -> Self {
        Self::new(AgentErrorKind::Failed, message)
    }

    fn not_found(message: impl Into<String>) -> Self {
        Self::new(AgentErrorKind::NotFound, message)
    }

    fn invalid_argument(message: impl Into<String>) -> Self {
        Self::new(AgentErrorKind::InvalidArgument, message)
    }

    fn unavailable(message: impl Into<String>) -> Self {
        Self::new(AgentErrorKind::Unavailable, message)
    }

    fn permission_denied(message: impl Into<String>) -> Self {
        Self::new(AgentErrorKind::PermissionDenied, message)
    }
}

#[derive(Clone)]
pub struct AgentManager {
    db: Arc<StdMutex<DaemonStateDb>>,
    task_workspace_root: PathBuf,
    project_events: watch::Sender<u64>,
    catalog_events: watch::Sender<u64>,
    runtimes: Arc<StdMutex<HashMap<String, AgentRuntimeEntry>>>,
}

#[derive(Clone)]
struct AgentRuntimeEntry {
    handle: AgentRuntimeHandle,
    live: Arc<AgentLiveSession>,
}

struct AgentLiveSession {
    snapshot: StdMutex<AgentSessionLiveSnapshot>,
    events: broadcast::Sender<AgentSessionEvent>,
}

pub struct AgentSessionSubscription {
    pub snapshot: AgentSessionLiveSnapshot,
    pub events: Option<broadcast::Receiver<AgentSessionEvent>>,
}

impl AgentManager {
    pub fn open(db: DaemonStateDb, task_workspace_root: PathBuf) -> Result<Self> {
        let catalog_revision = db.agent_session_catalog_revision()?;
        let (project_events, _) = watch::channel(0);
        let (catalog_events, _) = watch::channel(catalog_revision);
        Ok(Self {
            db: Arc::new(StdMutex::new(db)),
            task_workspace_root,
            project_events,
            catalog_events,
            runtimes: Arc::new(StdMutex::new(HashMap::new())),
        })
    }

    pub fn subscribe_project_events(&self) -> watch::Receiver<u64> {
        self.project_events.subscribe()
    }

    pub fn subscribe_catalog_events(&self) -> watch::Receiver<u64> {
        self.catalog_events.subscribe()
    }

    pub fn projects_snapshot(&self) -> Result<Vec<AgentProjectInfo>, AgentError> {
        self.with_db(|db| db.load_agent_projects())
            .map(|projects| projects.into_iter().map(project_info).collect())
    }

    pub fn create_project(
        &self,
        request: CreateAgentProjectReq,
    ) -> Result<AgentProjectInfo, AgentError> {
        let root_path = canonical_project_path(&request.root_path)?;
        if let Some(existing) = self.with_db(|db| db.find_agent_project_by_root_path(&root_path))? {
            return Ok(project_info(existing));
        }
        let title = request
            .title
            .filter(|title| !title.trim().is_empty())
            .unwrap_or_else(|| default_project_title(&root_path));
        let project = StoredAgentProject {
            project_id: random_id("project"),
            title,
            root_path,
            created_at_ms: current_unix_ms(),
            last_opened_at_ms: None,
        };
        self.with_db(|db| db.insert_agent_project(&project))?;
        notify_watch(&self.project_events);
        Ok(project_info(project))
    }

    pub fn remove_project(&self, project_id: &str) -> Result<(), AgentError> {
        if project_id.is_empty() {
            return Err(AgentError::invalid_argument("projectId must not be empty"));
        }
        let removed = self.with_db(|db| db.remove_agent_project(project_id))?;
        if !removed {
            return Err(AgentError::not_found("agent project was not found"));
        }
        notify_watch(&self.project_events);
        Ok(())
    }

    pub fn create_session(
        &self,
        request: CreateAgentSessionReq,
        configured_provider_ids: &HashSet<String>,
    ) -> Result<AgentSessionInfo, AgentError> {
        if request.creation_request_id.is_empty() {
            return Err(AgentError::invalid_argument(
                "creationRequestId must not be empty",
            ));
        }
        if let Some(existing) = self
            .with_db(|db| db.find_agent_session_by_creation_request(&request.creation_request_id))?
        {
            return if session_matches_create_request(&existing, &request) {
                Ok(session_info(existing))
            } else {
                Err(AgentError::new(
                    AgentErrorKind::Conflict,
                    "creationRequestId was already used for a different session creation request",
                ))
            };
        }
        if !configured_provider_ids.contains(&request.provider_id) {
            return Err(AgentError::invalid_argument(
                "providerId is not configured in agentServers",
            ));
        }

        let creation_request = request.clone();
        let now = current_unix_ms();
        let session_id = random_id("session");
        let (workspace_kind, project_id, task_workspace_id, cwd, task_workspace) =
            match request.workspace {
                CreateAgentWorkspace::Project { project_id } => {
                    let project = self
                        .with_db(|db| db.find_agent_project_by_id(&project_id))?
                        .ok_or_else(|| AgentError::not_found("agent project was not found"))?;
                    if !Path::new(&project.root_path).is_dir() {
                        return Err(AgentError::unavailable(
                            "agent project directory is unavailable",
                        ));
                    }
                    (
                        "project".to_string(),
                        Some(project_id),
                        None,
                        project.root_path,
                        None,
                    )
                }
                CreateAgentWorkspace::Task {
                    source: AgentTaskWorkspaceSource::Empty,
                } => {
                    let task_workspace_id = random_id("task");
                    let root = self.task_workspace_root.join(&task_workspace_id);
                    fs::create_dir_all(&root).map_err(|error| {
                        AgentError::failed(format!("create task workspace: {error}"))
                    })?;
                    let root_path = path_text(&root);
                    let workspace = NewAgentTaskWorkspace {
                        task_workspace_id: task_workspace_id.clone(),
                        root_path: root_path.clone(),
                        source_kind: "empty".to_string(),
                        source_project_id: None,
                        git_base_ref: None,
                        copy_include_untracked: None,
                        state_kind: "ready".to_string(),
                        created_at_ms: now,
                        updated_at_ms: now,
                    };
                    (
                        "task".to_string(),
                        None,
                        Some(task_workspace_id),
                        root_path,
                        Some(workspace),
                    )
                }
                CreateAgentWorkspace::Task { .. } => {
                    return Err(AgentError::invalid_argument(
                        "project-based task workspaces are not implemented yet",
                    ));
                }
            };
        let session = NewAgentSession {
            session_id,
            provider_id: request.provider_id,
            title: request.title,
            workspace_kind,
            project_id,
            task_workspace_id,
            cwd,
            creation_request_id: request.creation_request_id,
            created_at_ms: now,
            updated_at_ms: now,
        };
        let created = session.clone();
        let revision = match self
            .with_db_mut(|db| db.create_agent_session(&session, task_workspace.as_ref()))
        {
            Ok(revision) => revision,
            Err(error) => {
                if let Some(workspace) = &task_workspace {
                    let _ = fs::remove_dir(&workspace.root_path);
                }
                if let Some(existing) = self.with_db(|db| {
                    db.find_agent_session_by_creation_request(&session.creation_request_id)
                })? {
                    return if session_matches_create_request(&existing, &creation_request) {
                        Ok(session_info(existing))
                    } else {
                        Err(AgentError::new(
                            AgentErrorKind::Conflict,
                            "creationRequestId was already used for a different session creation request",
                        ))
                    };
                }
                return Err(error);
            }
        };
        let _ = self.catalog_events.send(revision);
        Ok(session_info(StoredAgentSession {
            session_id: created.session_id,
            provider_id: created.provider_id,
            provider_session_id: None,
            title: created.title,
            workspace_kind: created.workspace_kind,
            project_id: created.project_id,
            task_workspace_id: created.task_workspace_id,
            task_source_project_id: None,
            task_state_kind: task_workspace.map(|workspace| workspace.state_kind),
            cwd: created.cwd,
            archived: false,
            latest_seq: 0,
            last_message_preview: None,
            created_at_ms: created.created_at_ms,
            updated_at_ms: created.updated_at_ms,
            active_turn_state_kind: None,
        }))
    }

    pub async fn create_and_attach_session(
        &self,
        request: CreateAgentSessionReq,
        provider: AgentServerConfig,
    ) -> Result<AgentSessionInfo, AgentError> {
        let provider_id = request.provider_id.clone();
        let persisted = self.create_session(request, &HashSet::from([provider_id]))?;
        let session_id = persisted.summary.session_id.clone();
        if let Some(runtime) = self.runtime(&session_id)? {
            return runtime
                .live
                .snapshot
                .lock()
                .map(|snapshot| snapshot.session.clone())
                .map_err(|_| AgentError::failed("agent live state lock was poisoned"));
        }
        if persisted.provider_session_id.is_some() {
            return Err(AgentError::unavailable(
                "reattaching persisted ACP sessions is not implemented yet",
            ));
        }

        let persisted_seq = self
            .with_db(|db| db.find_agent_session_by_id(&session_id))?
            .map(|session| session.latest_seq)
            .unwrap_or(0);
        let mut starting = persisted.clone();
        starting.summary.attachment = AgentAttachmentState::Starting;
        let (event_tx, _) = broadcast::channel(256);
        let live = Arc::new(AgentLiveSession {
            snapshot: StdMutex::new(AgentSessionLiveSnapshot {
                session: starting,
                active_turn: None,
                usage: None,
                config_options: Vec::new(),
                latest_seq: persisted_seq,
            }),
            events: event_tx,
        });
        let (runtime_events, runtime_receiver) = mpsc::unbounded_channel();
        let runtime = start_agent_runtime(
            AgentRuntimeConfig {
                command: provider.command,
                args: provider.args,
                env: provider.env,
                cwd: PathBuf::from(&persisted.summary.cwd),
            },
            runtime_events,
        )
        .await;
        let (handle, ready) = match runtime {
            Ok(runtime) => runtime,
            Err(message) => {
                if let Ok(mut snapshot) = live.snapshot.lock() {
                    snapshot.session.summary.attachment = AgentAttachmentState::Failed;
                    snapshot.session.failure = Some(AgentFailure {
                        message: message.clone(),
                        code: Some("acp_initialization_failed".to_string()),
                        retryable: true,
                    });
                }
                return Err(AgentError::unavailable(format!(
                    "initialize ACP agent: {message}"
                )));
            }
        };
        let attached_at_ms = current_unix_ms();
        self.with_db(|db| {
            db.set_agent_provider_session_id(
                &session_id,
                &ready.provider_session_id,
                attached_at_ms,
            )
        })?;
        if let Ok(mut snapshot) = live.snapshot.lock() {
            snapshot.session.provider_session_id = Some(ready.provider_session_id);
            snapshot.session.attached_at_ms = Some(attached_at_ms);
            snapshot.session.summary.attachment = AgentAttachmentState::Attached;
            snapshot.session.summary.recoverability = if ready.load_session {
                AgentSessionRecoverability::Loadable
            } else {
                AgentSessionRecoverability::ProcessLocal
            };
            snapshot.session.summary.updated_at_ms = attached_at_ms;
        }
        self.runtimes
            .lock()
            .map_err(|_| AgentError::failed("agent runtimes lock was poisoned"))?
            .insert(
                session_id.clone(),
                AgentRuntimeEntry {
                    handle,
                    live: live.clone(),
                },
            );
        let manager = self.clone();
        let event_live = live.clone();
        tokio::spawn(async move {
            manager
                .consume_runtime_events(session_id, event_live, runtime_receiver)
                .await;
        });
        live.snapshot
            .lock()
            .map(|snapshot| snapshot.session.clone())
            .map_err(|_| AgentError::failed("agent live state lock was poisoned"))
    }

    pub fn subscribe_session(
        &self,
        session_id: &str,
    ) -> Result<AgentSessionSubscription, AgentError> {
        if let Some(runtime) = self.runtime(session_id)? {
            // Subscribe before reading the snapshot so an update cannot fall into
            // the gap between the two operations. Events already represented by
            // latestSeq may be delivered again and are safe for clients to ignore.
            let events = runtime.live.events.subscribe();
            let snapshot = runtime
                .live
                .snapshot
                .lock()
                .map_err(|_| AgentError::failed("agent live state lock was poisoned"))?
                .clone();
            return Ok(AgentSessionSubscription {
                snapshot,
                events: Some(events),
            });
        }
        let session = self
            .with_db(|db| db.find_agent_session_by_id(session_id))?
            .ok_or_else(|| AgentError::not_found("agent session was not found"))?;
        Ok(AgentSessionSubscription {
            snapshot: AgentSessionLiveSnapshot {
                latest_seq: session.latest_seq,
                session: session_info(session),
                active_turn: None,
                usage: None,
                config_options: Vec::new(),
            },
            events: None,
        })
    }

    pub fn create_turn(&self, request: CreateAgentTurnReq) -> Result<AgentTurnInfo, AgentError> {
        if request.client_request_id.is_empty() {
            return Err(AgentError::invalid_argument(
                "clientRequestId must not be empty",
            ));
        }
        if let Some(existing) = self.with_db(|db| {
            db.find_agent_turn_by_client_request(&request.session_id, &request.client_request_id)
        })? {
            return Ok(stored_turn_info(existing));
        }
        let text = request
            .content
            .iter()
            .map(|content| match content {
                AgentContent::Text { text } => Ok(text.as_str()),
                _ => Err(AgentError::invalid_argument(
                    "only text content is supported by CreateAgentTurn for now",
                )),
            })
            .collect::<Result<Vec<_>, _>>()?
            .join("\n");
        if text.is_empty() {
            return Err(AgentError::invalid_argument(
                "CreateAgentTurn content must not be empty",
            ));
        }
        let runtime = self
            .runtime(&request.session_id)?
            .ok_or_else(|| AgentError::unavailable("agent session is not attached"))?;
        {
            let snapshot = runtime
                .live
                .snapshot
                .lock()
                .map_err(|_| AgentError::failed("agent live state lock was poisoned"))?;
            if snapshot.session.summary.attachment != AgentAttachmentState::Attached {
                return Err(AgentError::unavailable("agent session is not attached"));
            }
            if snapshot.active_turn.is_some() {
                return Err(AgentError::new(
                    AgentErrorKind::Conflict,
                    "agent session already has an active turn",
                ));
            }
        }
        let now = current_unix_ms();
        let turn_id = random_id("turn");
        let user_message_id = random_id("message");
        let assistant_message_id = random_id("message");
        let created = match self.with_db_mut(|db| {
            db.create_agent_text_turn(
                &request.session_id,
                &request.client_request_id,
                &turn_id,
                &user_message_id,
                &assistant_message_id,
                &text,
                now,
            )
        }) {
            Ok(created) => created,
            Err(error) => {
                if let Some(existing) = self.with_db(|db| {
                    db.find_agent_turn_by_client_request(
                        &request.session_id,
                        &request.client_request_id,
                    )
                })? {
                    return Ok(stored_turn_info(existing));
                }
                return Err(error);
            }
        };
        let turn = AgentTurnInfo {
            turn_id: turn_id.clone(),
            session_id: request.session_id.clone(),
            state: AgentTurnState::Running,
            created_at_ms: now,
            started_at_ms: Some(now),
            finished_at_ms: None,
            context: None,
        };
        let user_message = AgentMessage {
            message_id: user_message_id,
            turn_id: Some(turn_id.clone()),
            role: AgentMessageRole::User,
            content: vec![AgentContent::Text { text: text.clone() }],
            state: AgentMessageState::Complete,
            created_at_ms: now,
        };
        let assistant_message = AgentMessage {
            message_id: assistant_message_id,
            turn_id: Some(turn_id.clone()),
            role: AgentMessageRole::Assistant,
            content: Vec::new(),
            state: AgentMessageState::Streaming,
            created_at_ms: now,
        };
        {
            let mut snapshot = runtime
                .live
                .snapshot
                .lock()
                .map_err(|_| AgentError::failed("agent live state lock was poisoned"))?;
            snapshot.latest_seq = created.assistant_message_seq;
            snapshot.session.summary.turn_state = AgentSessionTurnState::Running;
            snapshot.session.summary.updated_at_ms = now;
            snapshot.active_turn = Some(AgentTurnRecord {
                turn: turn.clone(),
                messages: vec![user_message.clone(), assistant_message.clone()],
                tool_calls: Vec::new(),
                permissions: Vec::new(),
                plan: None,
                terminals: Vec::new(),
            });
        }
        let _ = runtime.live.events.send(AgentSessionEvent::TurnUpsert {
            seq: created.turn_seq,
            turn: turn.clone(),
        });
        let _ = runtime.live.events.send(AgentSessionEvent::MessageUpsert {
            seq: created.user_message_seq,
            message: user_message,
        });
        let _ = runtime.live.events.send(AgentSessionEvent::MessageUpsert {
            seq: created.assistant_message_seq,
            message: assistant_message,
        });
        let _ = self.catalog_events.send(created.catalog_revision);
        if let Err(message) = runtime.handle.prompt(
            turn_id.clone(),
            vec![AcpContentBlock::Text(AcpTextContent::new(text))],
        ) {
            let _ = self.finish_live_turn(
                &request.session_id,
                &turn_id,
                Err(AgentFailure {
                    message: message.clone(),
                    code: Some("acp_runtime_unavailable".to_string()),
                    retryable: true,
                }),
                &runtime.live,
            );
            return Err(AgentError::unavailable(message));
        }
        Ok(turn)
    }

    pub fn list_sessions(
        &self,
        request: ListAgentSessionsReq,
    ) -> Result<ListAgentSessionsRes, AgentError> {
        let limit = usize::try_from(request.limit)
            .ok()
            .filter(|limit| (1..=MAX_SESSION_PAGE_SIZE).contains(limit))
            .ok_or_else(|| {
                AgentError::invalid_argument(format!(
                    "limit must be between 1 and {MAX_SESSION_PAGE_SIZE}"
                ))
            })?;
        let fingerprint = session_filter_fingerprint(
            &request.workspace,
            request.archived,
            request.query.as_deref(),
        );
        let cursor = request
            .cursor
            .as_deref()
            .map(|cursor| decode_session_cursor(cursor, fingerprint))
            .transpose()?;
        let workspace = match request.workspace {
            AgentSessionWorkspaceFilter::Any => StoredAgentWorkspaceFilter::Any,
            AgentSessionWorkspaceFilter::Project { project_id } => {
                StoredAgentWorkspaceFilter::Project(project_id)
            }
            AgentSessionWorkspaceFilter::Task { source_project_id } => {
                StoredAgentWorkspaceFilter::Task(source_project_id)
            }
        };
        let archived = match request.archived {
            AgentSessionArchiveFilter::ActiveOnly => StoredAgentArchiveFilter::ActiveOnly,
            AgentSessionArchiveFilter::ArchivedOnly => StoredAgentArchiveFilter::ArchivedOnly,
            AgentSessionArchiveFilter::All => StoredAgentArchiveFilter::All,
        };
        let mut rows = self.with_db(|db| {
            db.list_agent_sessions(&StoredAgentSessionQuery {
                workspace,
                archived,
                query: request.query,
                cursor,
                limit: limit + 1,
            })
        })?;
        let has_more = rows.len() > limit;
        rows.truncate(limit);
        let next_cursor = has_more.then(|| {
            let last = rows.last().expect("non-empty paginated agent session page");
            encode_session_cursor(fingerprint, last.updated_at_ms, &last.session_id)
        });
        let catalog_revision = self.with_db(|db| db.agent_session_catalog_revision())?;
        Ok(ListAgentSessionsRes {
            rows: rows.into_iter().map(session_summary).collect(),
            next_cursor,
            catalog_revision,
        })
    }

    async fn consume_runtime_events(
        &self,
        session_id: String,
        live: Arc<AgentLiveSession>,
        mut events: mpsc::UnboundedReceiver<AgentRuntimeEvent>,
    ) {
        while let Some(event) = events.recv().await {
            let result = match event {
                AgentRuntimeEvent::AgentTextChunk { turn_id, text } => {
                    self.apply_agent_text_chunk(&session_id, &turn_id, &text, &live)
                }
                AgentRuntimeEvent::Usage { used, size } => {
                    self.apply_agent_usage(&session_id, used, size, &live)
                }
                AgentRuntimeEvent::PromptFinished {
                    turn_id,
                    stop_reason,
                } => self.finish_live_turn(
                    &session_id,
                    &turn_id,
                    Ok(acp_stop_reason(stop_reason)),
                    &live,
                ),
                AgentRuntimeEvent::PromptFailed { turn_id, message } => self.finish_live_turn(
                    &session_id,
                    &turn_id,
                    Err(AgentFailure {
                        message,
                        code: Some("acp_prompt_failed".to_string()),
                        retryable: true,
                    }),
                    &live,
                ),
                AgentRuntimeEvent::Exited { message } => {
                    let active_turn_id = live.snapshot.lock().ok().and_then(|snapshot| {
                        snapshot
                            .active_turn
                            .as_ref()
                            .map(|turn| turn.turn.turn_id.clone())
                    });
                    if let Some(turn_id) = active_turn_id {
                        let failure_message = message
                            .clone()
                            .unwrap_or_else(|| "ACP agent exited during the prompt".to_string());
                        let _ = self.finish_live_turn(
                            &session_id,
                            &turn_id,
                            Err(AgentFailure {
                                message: failure_message,
                                code: Some("acp_process_exited".to_string()),
                                retryable: true,
                            }),
                            &live,
                        );
                    }
                    self.apply_runtime_exit(&session_id, message, &live)
                }
            };
            if result.is_err() {
                break;
            }
        }
    }

    fn apply_agent_text_chunk(
        &self,
        session_id: &str,
        turn_id: &str,
        text: &str,
        live: &AgentLiveSession,
    ) -> Result<(), AgentError> {
        let message_id = {
            let snapshot = live
                .snapshot
                .lock()
                .map_err(|_| AgentError::failed("agent live state lock was poisoned"))?;
            active_assistant_message(&snapshot, turn_id)
                .map(|message| message.message_id.clone())
                .ok_or_else(|| AgentError::failed("active assistant message was not found"))?
        };
        let now = current_unix_ms();
        let seq =
            self.with_db_mut(|db| db.append_agent_text_chunk(session_id, &message_id, text, now))?;
        {
            let mut snapshot = live
                .snapshot
                .lock()
                .map_err(|_| AgentError::failed("agent live state lock was poisoned"))?;
            if let Some(message) = active_assistant_message_mut(&mut snapshot, turn_id) {
                message.content.push(AgentContent::Text {
                    text: text.to_string(),
                });
            }
            snapshot.latest_seq = seq;
            snapshot.session.summary.updated_at_ms = now;
        }
        let _ = live.events.send(AgentSessionEvent::MessageContentAppend {
            seq,
            message_id,
            content: AgentContent::Text {
                text: text.to_string(),
            },
        });
        Ok(())
    }

    fn apply_agent_usage(
        &self,
        session_id: &str,
        used: u64,
        size: u64,
        live: &AgentLiveSession,
    ) -> Result<(), AgentError> {
        let now = current_unix_ms();
        let seq = self.with_db_mut(|db| db.advance_agent_session_sequence(session_id, now))?;
        let usage = AgentUsage {
            input_tokens: Some(used),
            output_tokens: None,
            cached_input_tokens: None,
            context_window_tokens: Some(size),
        };
        {
            let mut snapshot = live
                .snapshot
                .lock()
                .map_err(|_| AgentError::failed("agent live state lock was poisoned"))?;
            snapshot.latest_seq = seq;
            snapshot.usage = Some(usage.clone());
        }
        let _ = live
            .events
            .send(AgentSessionEvent::UsageUpdate { seq, usage });
        Ok(())
    }

    fn finish_live_turn(
        &self,
        session_id: &str,
        turn_id: &str,
        outcome: Result<AgentStopReason, AgentFailure>,
        live: &AgentLiveSession,
    ) -> Result<(), AgentError> {
        let (message_id, preview) = {
            let snapshot = live
                .snapshot
                .lock()
                .map_err(|_| AgentError::failed("agent live state lock was poisoned"))?;
            let message = active_assistant_message(&snapshot, turn_id)
                .ok_or_else(|| AgentError::failed("active assistant message was not found"))?;
            (message.message_id.clone(), message_preview(message))
        };
        let now = current_unix_ms();
        let (state_kind, stop_kind, stop_other, failure_message, failure_code, retryable) =
            match &outcome {
                Ok(reason) => {
                    let (kind, other) = stop_reason_db(reason);
                    ("completed", Some(kind), other, None, None, None)
                }
                Err(failure) => (
                    "failed",
                    None,
                    None,
                    Some(failure.message.as_str()),
                    failure.code.as_deref(),
                    Some(failure.retryable),
                ),
            };
        let finished = self.with_db_mut(|db| {
            db.finish_agent_turn(
                session_id,
                turn_id,
                &message_id,
                state_kind,
                stop_kind,
                stop_other.as_deref(),
                failure_message,
                failure_code,
                retryable,
                preview.as_deref(),
                now,
            )
        })?;
        let (message, turn) = {
            let mut snapshot = live
                .snapshot
                .lock()
                .map_err(|_| AgentError::failed("agent live state lock was poisoned"))?;
            let active = snapshot
                .active_turn
                .as_mut()
                .ok_or_else(|| AgentError::failed("active agent turn was not found"))?;
            let message = active
                .messages
                .iter_mut()
                .find(|message| message.message_id == message_id)
                .ok_or_else(|| AgentError::failed("active assistant message was not found"))?;
            message.state = AgentMessageState::Complete;
            active.turn.state = match outcome {
                Ok(stop_reason) => AgentTurnState::Completed { stop_reason },
                Err(failure) => AgentTurnState::Failed { failure },
            };
            active.turn.finished_at_ms = Some(now);
            let message = message.clone();
            let turn = active.turn.clone();
            snapshot.latest_seq = finished.turn_seq;
            snapshot.session.summary.turn_state = AgentSessionTurnState::Idle;
            snapshot.session.summary.updated_at_ms = now;
            snapshot.session.summary.last_message_preview = preview;
            snapshot.active_turn = None;
            (message, turn)
        };
        let _ = live.events.send(AgentSessionEvent::MessageUpsert {
            seq: finished.assistant_message_seq,
            message,
        });
        let _ = live.events.send(AgentSessionEvent::TurnUpsert {
            seq: finished.turn_seq,
            turn,
        });
        let _ = self.catalog_events.send(finished.catalog_revision);
        Ok(())
    }

    fn apply_runtime_exit(
        &self,
        session_id: &str,
        message: Option<String>,
        live: &AgentLiveSession,
    ) -> Result<(), AgentError> {
        let now = current_unix_ms();
        let seq = self.with_db_mut(|db| db.advance_agent_session_sequence(session_id, now))?;
        let session = {
            let mut snapshot = live
                .snapshot
                .lock()
                .map_err(|_| AgentError::failed("agent live state lock was poisoned"))?;
            snapshot.latest_seq = seq;
            snapshot.session.detached_at_ms = Some(now);
            snapshot.session.summary.updated_at_ms = now;
            if let Some(message) = message {
                snapshot.session.summary.attachment = AgentAttachmentState::Failed;
                snapshot.session.failure = Some(AgentFailure {
                    message,
                    code: Some("acp_process_exited".to_string()),
                    retryable: true,
                });
            } else {
                snapshot.session.summary.attachment = AgentAttachmentState::Dormant;
            }
            snapshot.session.clone()
        };
        let _ = live
            .events
            .send(AgentSessionEvent::SessionUpsert { seq, session });
        Ok(())
    }

    fn runtime(&self, session_id: &str) -> Result<Option<AgentRuntimeEntry>, AgentError> {
        self.runtimes
            .lock()
            .map_err(|_| AgentError::failed("agent runtimes lock was poisoned"))
            .map(|runtimes| runtimes.get(session_id).cloned())
    }

    fn with_db<T>(
        &self,
        operation: impl FnOnce(&DaemonStateDb) -> Result<T>,
    ) -> Result<T, AgentError> {
        let db = self
            .db
            .lock()
            .map_err(|_| AgentError::failed("agent database lock was poisoned"))?;
        operation(&db).map_err(|error| AgentError::failed(format!("agent database: {error:#}")))
    }

    fn with_db_mut<T>(
        &self,
        operation: impl FnOnce(&mut DaemonStateDb) -> Result<T>,
    ) -> Result<T, AgentError> {
        let mut db = self
            .db
            .lock()
            .map_err(|_| AgentError::failed("agent database lock was poisoned"))?;
        operation(&mut db).map_err(|error| AgentError::failed(format!("agent database: {error:#}")))
    }
}

fn active_assistant_message<'a>(
    snapshot: &'a AgentSessionLiveSnapshot,
    turn_id: &str,
) -> Option<&'a AgentMessage> {
    snapshot
        .active_turn
        .as_ref()
        .filter(|turn| turn.turn.turn_id == turn_id)
        .and_then(|turn| {
            turn.messages
                .iter()
                .find(|message| message.role == AgentMessageRole::Assistant)
        })
}

fn active_assistant_message_mut<'a>(
    snapshot: &'a mut AgentSessionLiveSnapshot,
    turn_id: &str,
) -> Option<&'a mut AgentMessage> {
    snapshot
        .active_turn
        .as_mut()
        .filter(|turn| turn.turn.turn_id == turn_id)
        .and_then(|turn| {
            turn.messages
                .iter_mut()
                .find(|message| message.role == AgentMessageRole::Assistant)
        })
}

fn message_preview(message: &AgentMessage) -> Option<String> {
    let text = message
        .content
        .iter()
        .filter_map(|content| match content {
            AgentContent::Text { text } => Some(text.as_str()),
            _ => None,
        })
        .collect::<String>();
    if text.is_empty() {
        None
    } else {
        Some(text.chars().take(240).collect())
    }
}

fn acp_stop_reason(reason: AcpStopReason) -> AgentStopReason {
    match reason {
        AcpStopReason::EndTurn => AgentStopReason::EndTurn,
        AcpStopReason::MaxTokens => AgentStopReason::MaxTokens,
        AcpStopReason::Refusal => AgentStopReason::Refusal,
        AcpStopReason::Cancelled => AgentStopReason::Cancelled,
        AcpStopReason::MaxTurnRequests => AgentStopReason::Other {
            name: "max_turn_requests".to_string(),
        },
        _ => AgentStopReason::Other {
            name: "unknown".to_string(),
        },
    }
}

fn stop_reason_db(reason: &AgentStopReason) -> (&'static str, Option<String>) {
    match reason {
        AgentStopReason::EndTurn => ("end_turn", None),
        AgentStopReason::MaxTokens => ("max_tokens", None),
        AgentStopReason::Refusal => ("refusal", None),
        AgentStopReason::Cancelled => ("cancelled", None),
        AgentStopReason::Other { name } => ("other", Some(name.clone())),
    }
}

fn stored_turn_info(turn: StoredAgentTurn) -> AgentTurnInfo {
    let state = match turn.state_kind.as_str() {
        "running" => AgentTurnState::Running,
        "awaiting_permission" => AgentTurnState::AwaitingPermission,
        "completed" => AgentTurnState::Completed {
            stop_reason: match turn.stop_reason_kind.as_deref() {
                Some("end_turn") => AgentStopReason::EndTurn,
                Some("max_tokens") => AgentStopReason::MaxTokens,
                Some("refusal") => AgentStopReason::Refusal,
                Some("cancelled") => AgentStopReason::Cancelled,
                Some(_) => AgentStopReason::Other {
                    name: turn
                        .stop_reason_other
                        .unwrap_or_else(|| "other".to_string()),
                },
                None => AgentStopReason::Other {
                    name: "unknown".to_string(),
                },
            },
        },
        "cancelled" => AgentTurnState::Cancelled,
        "failed" => AgentTurnState::Failed {
            failure: AgentFailure {
                message: turn
                    .failure_message
                    .unwrap_or_else(|| "agent turn failed".to_string()),
                code: turn.failure_code,
                retryable: turn.failure_retryable.unwrap_or(false),
            },
        },
        _ => AgentTurnState::Queued,
    };
    AgentTurnInfo {
        turn_id: turn.turn_id,
        session_id: turn.session_id,
        state,
        created_at_ms: turn.created_at_ms,
        started_at_ms: turn.started_at_ms,
        finished_at_ms: turn.finished_at_ms,
        context: None,
    }
}

fn session_matches_create_request(
    session: &StoredAgentSession,
    request: &CreateAgentSessionReq,
) -> bool {
    if session.provider_id != request.provider_id || session.title != request.title {
        return false;
    }
    match &request.workspace {
        CreateAgentWorkspace::Project { project_id } => {
            session.workspace_kind == "project"
                && session.project_id.as_deref() == Some(project_id.as_str())
        }
        CreateAgentWorkspace::Task {
            source: AgentTaskWorkspaceSource::Empty,
        } => session.workspace_kind == "task" && session.task_source_project_id.is_none(),
        CreateAgentWorkspace::Task { .. } => false,
    }
}

pub fn provider_rows(config: &SystemConfig) -> Vec<AgentProviderInfo> {
    config
        .agent_servers
        .iter()
        .map(|(provider_id, server)| AgentProviderInfo {
            provider_id: provider_id.clone(),
            title: provider_id.clone(),
            version: None,
            availability: if command_available(&server.command) {
                AgentProviderAvailability::Available
            } else {
                AgentProviderAvailability::Missing
            },
            authentication: AgentProviderAuthentication::NotRequired,
            capabilities: AgentProviderCapabilities::default(),
        })
        .collect()
}

pub fn provider_ids(config: &SystemConfig) -> HashSet<String> {
    config.agent_servers.keys().cloned().collect()
}

pub fn providers_patch(
    previous: &[AgentProviderInfo],
    next: &[AgentProviderInfo],
) -> Option<AgentProvidersTableEvent> {
    table_patch(previous, next, |row| row.provider_id.as_str())
        .map(|(removes, upserts)| AgentProvidersTableEvent::Patch { removes, upserts })
}

pub fn projects_patch(
    previous: &[AgentProjectInfo],
    next: &[AgentProjectInfo],
) -> Option<AgentProjectsTableEvent> {
    table_patch(previous, next, |row| row.project_id.as_str())
        .map(|(removes, upserts)| AgentProjectsTableEvent::Patch { removes, upserts })
}

fn table_patch<T: Clone + PartialEq>(
    previous: &[T],
    next: &[T],
    key: impl Fn(&T) -> &str,
) -> Option<(Vec<String>, Vec<T>)> {
    let previous = previous
        .iter()
        .map(|row| (key(row).to_string(), row))
        .collect::<BTreeMap<_, _>>();
    let next = next
        .iter()
        .map(|row| (key(row).to_string(), row))
        .collect::<BTreeMap<_, _>>();
    let removes = previous
        .keys()
        .filter(|id| !next.contains_key(*id))
        .cloned()
        .collect::<Vec<_>>();
    let upserts = next
        .iter()
        .filter(|(id, row)| previous.get(*id).is_none_or(|previous| *previous != **row))
        .map(|(_, row)| (*row).clone())
        .collect::<Vec<_>>();
    (!removes.is_empty() || !upserts.is_empty()).then_some((removes, upserts))
}

fn project_info(project: StoredAgentProject) -> AgentProjectInfo {
    let availability = match fs::metadata(&project.root_path) {
        Ok(metadata) if metadata.is_dir() => AgentProjectAvailability::Available,
        Ok(_) => AgentProjectAvailability::Missing,
        Err(error) if error.kind() == std::io::ErrorKind::PermissionDenied => {
            AgentProjectAvailability::PermissionDenied
        }
        Err(_) => AgentProjectAvailability::Missing,
    };
    AgentProjectInfo {
        project_id: project.project_id,
        title: project.title,
        root_path: project.root_path,
        availability,
        created_at_ms: project.created_at_ms,
        last_opened_at_ms: project.last_opened_at_ms,
    }
}

fn session_info(session: StoredAgentSession) -> AgentSessionInfo {
    let provider_session_id = session.provider_session_id.clone();
    AgentSessionInfo {
        summary: session_summary(session),
        provider_session_id,
        attached_at_ms: None,
        detached_at_ms: None,
        failure: None,
    }
}

fn session_summary(session: StoredAgentSession) -> AgentSessionSummary {
    let workspace = if session.workspace_kind == "project" {
        AgentWorkspaceBinding::Project {
            project_id: session.project_id.unwrap_or_default(),
        }
    } else {
        AgentWorkspaceBinding::Task {
            task_workspace_id: session.task_workspace_id.unwrap_or_default(),
            source_project_id: session.task_source_project_id,
            state: task_workspace_state(session.task_state_kind.as_deref()),
        }
    };
    AgentSessionSummary {
        session_id: session.session_id,
        provider_id: session.provider_id,
        title: session.title,
        cwd: session.cwd,
        workspace,
        attachment: AgentAttachmentState::Dormant,
        turn_state: turn_state(session.active_turn_state_kind.as_deref()),
        recoverability: AgentSessionRecoverability::Unknown,
        archived: session.archived,
        created_at_ms: session.created_at_ms,
        updated_at_ms: session.updated_at_ms,
        last_message_preview: session.last_message_preview,
    }
}

fn task_workspace_state(state: Option<&str>) -> AgentTaskWorkspaceState {
    match state {
        Some("provisioning") => AgentTaskWorkspaceState::Provisioning,
        Some("missing") => AgentTaskWorkspaceState::Missing,
        Some("cleanup_pending") => AgentTaskWorkspaceState::CleanupPending,
        _ => AgentTaskWorkspaceState::Ready,
    }
}

fn turn_state(state: Option<&str>) -> AgentSessionTurnState {
    match state {
        Some("queued") => AgentSessionTurnState::Queued,
        Some("running") => AgentSessionTurnState::Running,
        Some("awaiting_permission") => AgentSessionTurnState::AwaitingPermission,
        _ => AgentSessionTurnState::Idle,
    }
}

fn canonical_project_path(path: &str) -> Result<String, AgentError> {
    if path.trim().is_empty() {
        return Err(AgentError::invalid_argument("rootPath must not be empty"));
    }
    let canonical = fs::canonicalize(path).map_err(|error| match error.kind() {
        std::io::ErrorKind::NotFound => AgentError::not_found("project directory was not found"),
        std::io::ErrorKind::PermissionDenied => {
            AgentError::permission_denied("project directory cannot be accessed")
        }
        _ => AgentError::failed(format!("canonicalize project directory: {error}")),
    })?;
    if !canonical.is_dir() {
        return Err(AgentError::invalid_argument(
            "rootPath must refer to a directory",
        ));
    }
    Ok(path_text(&canonical))
}

fn path_text(path: &Path) -> String {
    let text = path.to_string_lossy();
    #[cfg(windows)]
    {
        if let Some(path) = text.strip_prefix(r"\\?\UNC\") {
            return format!(r"\\{path}");
        }
        if let Some(path) = text.strip_prefix(r"\\?\") {
            return path.to_string();
        }
    }
    text.into_owned()
}

fn default_project_title(root_path: &str) -> String {
    Path::new(root_path)
        .file_name()
        .and_then(|name| name.to_str())
        .filter(|name| !name.is_empty())
        .unwrap_or(root_path)
        .to_string()
}

fn command_available(command: &str) -> bool {
    if command.is_empty() {
        return false;
    }
    let path = Path::new(command);
    if path.is_absolute() || path.components().count() > 1 {
        return path.is_file();
    }
    let Some(search_path) = env::var_os("PATH") else {
        return false;
    };
    let extensions = executable_extensions();
    env::split_paths(&search_path).any(|directory| {
        extensions
            .iter()
            .any(|extension| directory.join(format!("{command}{extension}")).is_file())
    })
}

fn executable_extensions() -> Vec<String> {
    #[cfg(windows)]
    {
        let mut extensions = vec![String::new()];
        extensions.extend(
            env::var_os("PATHEXT")
                .map(|value| {
                    value
                        .to_string_lossy()
                        .split(';')
                        .filter(|value| !value.is_empty())
                        .map(|value| value.to_ascii_lowercase())
                        .collect::<Vec<_>>()
                })
                .unwrap_or_else(|| {
                    vec![".exe".to_string(), ".cmd".to_string(), ".bat".to_string()]
                }),
        );
        extensions
    }
    #[cfg(not(windows))]
    {
        vec![String::new()]
    }
}

fn random_id(prefix: &str) -> String {
    format!("{prefix}-{:032x}", rand::random::<u128>())
}

fn current_unix_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis()
        .try_into()
        .unwrap_or(u64::MAX)
}

fn notify_watch(sender: &watch::Sender<u64>) {
    sender.send_modify(|revision| *revision = revision.saturating_add(1));
}

fn session_filter_fingerprint(
    workspace: &AgentSessionWorkspaceFilter,
    archived: AgentSessionArchiveFilter,
    query: Option<&str>,
) -> u64 {
    let mut hasher = std::collections::hash_map::DefaultHasher::new();
    match workspace {
        AgentSessionWorkspaceFilter::Any => "any".hash(&mut hasher),
        AgentSessionWorkspaceFilter::Project { project_id } => {
            "project".hash(&mut hasher);
            project_id.hash(&mut hasher);
        }
        AgentSessionWorkspaceFilter::Task { source_project_id } => {
            "task".hash(&mut hasher);
            source_project_id.hash(&mut hasher);
        }
    }
    match archived {
        AgentSessionArchiveFilter::ActiveOnly => "active".hash(&mut hasher),
        AgentSessionArchiveFilter::ArchivedOnly => "archived".hash(&mut hasher),
        AgentSessionArchiveFilter::All => "all".hash(&mut hasher),
    }
    query.hash(&mut hasher);
    hasher.finish()
}

fn encode_session_cursor(fingerprint: u64, updated_at_ms: u64, session_id: &str) -> String {
    format!("{fingerprint:016x}:{updated_at_ms}:{session_id}")
}

fn decode_session_cursor(
    cursor: &str,
    expected_fingerprint: u64,
) -> Result<(u64, String), AgentError> {
    let mut parts = cursor.splitn(3, ':');
    let fingerprint = parts
        .next()
        .and_then(|value| u64::from_str_radix(value, 16).ok());
    let updated_at_ms = parts.next().and_then(|value| value.parse::<u64>().ok());
    let session_id = parts.next().filter(|value| !value.is_empty());
    if fingerprint != Some(expected_fingerprint) {
        return Err(AgentError::invalid_argument(
            "session cursor does not match the request filters",
        ));
    }
    match (updated_at_ms, session_id) {
        (Some(updated_at_ms), Some(session_id)) => Ok((updated_at_ms, session_id.to_string())),
        _ => Err(AgentError::invalid_argument("session cursor is invalid")),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use rieul_daemon_core::generated::rpc::{
        AgentSessionArchiveFilter, AgentSessionWorkspaceFilter,
    };

    fn manager(root: &Path) -> AgentManager {
        AgentManager::open(
            DaemonStateDb::open_in_memory_for_tests().unwrap(),
            root.join("tasks"),
        )
        .unwrap()
    }

    #[test]
    fn creates_deduplicates_and_removes_projects() {
        let dir = tempfile::tempdir().unwrap();
        let manager = manager(dir.path());
        let first = manager
            .create_project(CreateAgentProjectReq {
                root_path: dir.path().to_string_lossy().into_owned(),
                title: Some("Workspace".to_string()),
            })
            .unwrap();
        let second = manager
            .create_project(CreateAgentProjectReq {
                root_path: dir.path().join(".").to_string_lossy().into_owned(),
                title: Some("Ignored".to_string()),
            })
            .unwrap();

        assert_eq!(first.project_id, second.project_id);
        assert_eq!(manager.projects_snapshot().unwrap().len(), 1);
        manager.remove_project(&first.project_id).unwrap();
        assert!(manager.projects_snapshot().unwrap().is_empty());
    }

    #[test]
    fn creates_idempotent_project_sessions_and_lists_them() {
        let dir = tempfile::tempdir().unwrap();
        let manager = manager(dir.path());
        let project = manager
            .create_project(CreateAgentProjectReq {
                root_path: dir.path().to_string_lossy().into_owned(),
                title: None,
            })
            .unwrap();
        let request = CreateAgentSessionReq {
            provider_id: "test".to_string(),
            workspace: CreateAgentWorkspace::Project {
                project_id: project.project_id,
            },
            title: Some("Session".to_string()),
            creation_request_id: "request-1".to_string(),
        };
        let providers = HashSet::from(["test".to_string()]);
        let first = manager.create_session(request.clone(), &providers).unwrap();
        let second = manager.create_session(request, &providers).unwrap();

        assert_eq!(first.summary.session_id, second.summary.session_id);
        let page = manager
            .list_sessions(ListAgentSessionsReq {
                workspace: AgentSessionWorkspaceFilter::Any,
                archived: AgentSessionArchiveFilter::ActiveOnly,
                query: None,
                cursor: None,
                limit: 20,
            })
            .unwrap();
        assert_eq!(page.rows.len(), 1);
        assert_eq!(page.catalog_revision, 1);
    }

    #[test]
    fn creates_empty_task_workspace() {
        let dir = tempfile::tempdir().unwrap();
        let manager = manager(dir.path());
        let session = manager
            .create_session(
                CreateAgentSessionReq {
                    provider_id: "test".to_string(),
                    workspace: CreateAgentWorkspace::Task {
                        source: AgentTaskWorkspaceSource::Empty,
                    },
                    title: None,
                    creation_request_id: "request-1".to_string(),
                },
                &HashSet::from(["test".to_string()]),
            )
            .unwrap();

        assert!(Path::new(&session.summary.cwd).is_dir());
        assert!(matches!(
            session.summary.workspace,
            AgentWorkspaceBinding::Task { .. }
        ));
    }

    #[test]
    fn rejects_reusing_creation_key_for_different_session() {
        let dir = tempfile::tempdir().unwrap();
        let manager = manager(dir.path());
        let providers = HashSet::from(["test".to_string()]);
        manager
            .create_session(
                CreateAgentSessionReq {
                    provider_id: "test".to_string(),
                    workspace: CreateAgentWorkspace::Task {
                        source: AgentTaskWorkspaceSource::Empty,
                    },
                    title: Some("First".to_string()),
                    creation_request_id: "request-1".to_string(),
                },
                &providers,
            )
            .unwrap();

        let error = manager
            .create_session(
                CreateAgentSessionReq {
                    provider_id: "test".to_string(),
                    workspace: CreateAgentWorkspace::Task {
                        source: AgentTaskWorkspaceSource::Empty,
                    },
                    title: Some("Second".to_string()),
                    creation_request_id: "request-1".to_string(),
                },
                &providers,
            )
            .unwrap_err();

        assert_eq!(error.kind, AgentErrorKind::Conflict);
    }
}
