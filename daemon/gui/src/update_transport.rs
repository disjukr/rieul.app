//! Fixed installed-helper transport. No web credentials or configurable command.
use crate::updates::{Action, Request};
use rieul_daemon_core::generated::rpc::UpdateStatus;
use tokio::sync::mpsc;
pub enum Event {
    Connecting,
    Snapshot(UpdateStatus),
    Disconnected(String),
    Complete(Request, Result<UpdateStatus, String>),
}
pub struct Bridge {
    pub events: mpsc::Receiver<Event>,
    commands: mpsc::Sender<Request>,
    tasks: Vec<tokio::task::JoinHandle<()>>,
}
impl Bridge {
    pub fn start(runtime: &tokio::runtime::Handle) -> Self {
        let (tx, events) = mpsc::channel(16);
        let (commands, mut requests) = mpsc::channel::<Request>(1);
        let mut tasks = vec![];
        if std::env::var("RIEUL_PAIRING_AUTOMATION").as_deref() != Ok("1") {
            #[cfg(target_os = "macos")]
            {
                let subscription = tx.clone();
                tasks.push(runtime.spawn(async move {
                    loop {
                        if subscription.send(Event::Connecting).await.is_err() {
                            break;
                        }
                        let result = macos::exchange("subscribe", Some(&subscription)).await;
                        if subscription
                            .send(Event::Disconnected(
                                result
                                    .err()
                                    .map(|e| e.to_string())
                                    .unwrap_or_else(|| "Local updater disconnected".into()),
                            ))
                            .await
                            .is_err()
                        {
                            break;
                        }
                        tokio::time::sleep(std::time::Duration::from_secs(2)).await;
                    }
                }));
                tasks.push(runtime.spawn(async move {
                    while let Some(request) = requests.recv().await {
                        let action = match request.action {
                            Action::Check => "check",
                            Action::Install => "install",
                            Action::Restart => "restart",
                        };
                        let result = macos::exchange(action, None)
                            .await
                            .map_err(|e| e.to_string());
                        if tx.send(Event::Complete(request, result)).await.is_err() {
                            break;
                        }
                    }
                }));
            }
            #[cfg(not(target_os = "macos"))]
            {
                let _ = (&runtime, &mut requests);
                let _ = tx.try_send(Event::Disconnected(
                    "Local updates and restart are not supported on this platform".into(),
                ));
            }
        }
        Self {
            events,
            commands,
            tasks,
        }
    }
    pub fn request(&self, request: Request) -> Result<(), String> {
        self.commands
            .try_send(request)
            .map_err(|_| "Local updater is busy or disconnected".into())
    }
}
impl Drop for Bridge {
    fn drop(&mut self) {
        for task in &self.tasks {
            task.abort();
        }
    }
}
#[cfg(target_os = "macos")]
mod macos {
    use super::*;
    use anyhow::{Result, ensure};
    use rieul_daemon_core::{local_update as wire, socket_wire::SocketReqResMessage as Message};
    use std::{os::unix::fs::MetadataExt, process::Stdio};
    use tokio::io::{AsyncReadExt, BufReader};
    pub async fn exchange(
        action: &str,
        events: Option<&mpsc::Sender<Event>>,
    ) -> Result<UpdateStatus> {
        let path = crate::desktop_helper::helper_path(&std::env::current_exe()?)?;
        let metadata = std::fs::symlink_metadata(&path)?;
        ensure!(
            metadata.is_file() && metadata.uid() == 0 && metadata.mode() & 0o022 == 0,
            "Updater helper must be installed and root-owned"
        );
        let mut child = tokio::process::Command::new(path)
            .args(["local-update", action])
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::inherit())
            .kill_on_drop(true)
            .spawn()?;
        let mut reader = BufReader::new(child.stdout.take().unwrap());
        loop {
            let len = reader.read_u32().await? as usize;
            ensure!(
                (1..=wire::MAX_FRAME).contains(&len),
                "Invalid updater frame length"
            );
            let mut bytes = vec![0; len];
            reader.read_exact(&mut bytes).await?;
            let message =
                wire::decode(&bytes).ok_or_else(|| anyhow::anyhow!("Invalid updater frame"))?;
            let payload = match message {
                Message::ResponseStreamStart {
                    stream_id: 1,
                    payload: Some(payload),
                } if events.is_some() => payload,
                Message::ResponseStreamChunk {
                    stream_id: 1,
                    payload,
                } if events.is_some() => payload,
                Message::ResponseUnaryOk {
                    stream_id: 1,
                    payload: Some(payload),
                } if events.is_none() => payload,
                Message::ResponseUnaryError {
                    stream_id: 1,
                    error,
                    ..
                } => {
                    use rieul_daemon_core::generated::ipc::IpcProcError;
                    let error = IpcProcError::decode(&error)
                        .map_err(|_| anyhow::anyhow!("Invalid local updater error"))?;
                    let message = match error {
                        IpcProcError::Failed { message }
                        | IpcProcError::Unsupported { message }
                        | IpcProcError::PermissionDenied { message }
                        | IpcProcError::Rejected { message } => message,
                    };
                    anyhow::bail!("{message}");
                }
                _ => anyhow::bail!("Unexpected local updater response"),
            };
            let status = UpdateStatus::decode(&payload)
                .map_err(|e| anyhow::anyhow!("Invalid updater status: {e:?}"))?;
            ensure!(
                !status.ordering.epoch.is_empty(),
                "Missing updater identity"
            );
            if let Some(events) = events {
                events.send(Event::Snapshot(status)).await?;
            } else {
                return Ok(status);
            }
        }
    }
}
