use super::*;
use crate::terminal::{HostedTerminal, HostedTerminalControl, TerminalBackend};
use rieul_daemon_core::rpc::{AvailableShellInfo, TerminalLaunchSpec};
use std::sync::mpsc;

struct Backend;
struct Control;
impl TerminalBackend for Backend {
    fn available_shells(&self) -> Result<Vec<AvailableShellInfo>, ServiceError> {
        Ok(vec![])
    }
    fn spawn(&self, _: &CreateTerminalSessionReq) -> Result<HostedTerminal, ServiceError> {
        let (_, events) = mpsc::channel();
        Ok(HostedTerminal {
            initial_cwd: None,
            control: Box::new(Control),
            events,
        })
    }
}
impl HostedTerminalControl for Control {
    fn write_input(&mut self, _: &[u8]) -> Result<(), ServiceError> {
        Ok(())
    }
    fn resize(&mut self, _: u64, _: u64) -> Result<(), ServiceError> {
        Ok(())
    }
    fn close(&mut self) -> Result<(), ServiceError> {
        Ok(())
    }
}
fn fixture() -> (SharedTerminalManager, String) {
    let manager = Arc::new(TerminalManager::with_backend(Arc::new(Backend)));
    let info = manager
        .create_session(
            CreateTerminalSessionReq {
                cols: 80,
                rows: 24,
                cwd: None,
                launch: TerminalLaunchSpec {
                    command: "fixture".into(),
                    args: vec![],
                },
                title: None,
            },
            "client".into(),
        )
        .unwrap();
    (manager, info.terminal_session_id)
}
fn attach(manager: &SharedTerminalManager, id: &str, owner: u64) -> AttachedTerminal {
    manager
        .attach(
            AttachTerminalSessionReq {
                terminal_session_id: id.into(),
                after_seq: None,
                viewport_cols: 80,
                viewport_rows: 24,
                screen_snapshots: None,
            },
            owner,
        )
        .unwrap()
}
fn take(manager: &SharedTerminalManager, id: &str, attach_id: &str, owner: u64) -> u64 {
    manager
        .take_control(
            TakeTerminalControlReq {
                terminal_session_id: id.into(),
                attach_id: attach_id.into(),
                viewport_cols: 80,
                viewport_rows: 24,
            },
            owner,
        )
        .unwrap();
    manager.begin_input(id, attach_id, owner).unwrap()
}
fn guard(
    manager: &SharedTerminalManager,
    attached: &AttachedTerminal,
) -> TerminalAttachmentCleanup {
    TerminalAttachmentCleanup {
        terminals: manager.clone(),
        terminal_session_id: attached.terminal_session_id.clone(),
        attach_id: attached.attach_id.clone(),
    }
}

#[test]
fn cleanup_removes_only_its_exact_attachment_and_is_idempotent() {
    let (manager, id) = fixture();
    let old = attach(&manager, &id, 1);
    let old_guard = guard(&manager, &old);
    let current = attach(&manager, &id, 2);
    let epoch = take(&manager, &id, &current.attach_id, 2);
    let mut changes = manager.subscribe_sessions();
    drop(old_guard);
    changes.try_recv().unwrap();
    assert!(manager.begin_input(&id, &old.attach_id, 1).is_err());
    assert_eq!(
        manager.begin_input(&id, &current.attach_id, 2).unwrap(),
        epoch
    );
    manager
        .write_input(&id, &current.attach_id, b"still primary", 2, epoch)
        .unwrap();
    manager.detach(&id, &old.attach_id);
    assert!(matches!(
        changes.try_recv(),
        Err(tokio::sync::broadcast::error::TryRecvError::Empty)
    ));
    assert_eq!(
        manager.begin_input(&id, &current.attach_id, 2).unwrap(),
        epoch
    );
}

#[tokio::test]
async fn aborted_stream_future_drops_attachment_without_revoking_new_primary() {
    let (manager, id) = fixture();
    let old = attach(&manager, &id, 1);
    take(&manager, &id, &old.attach_id, 1);
    let cleanup = guard(&manager, &old);
    let (installed, ready) = tokio::sync::oneshot::channel();
    let task = tokio::spawn(async move {
        let _cleanup = cleanup;
        installed.send(()).unwrap();
        std::future::pending::<()>().await;
    });
    ready.await.unwrap();
    let current = attach(&manager, &id, 2);
    let epoch = take(&manager, &id, &current.attach_id, 2);
    task.abort();
    assert!(task.await.unwrap_err().is_cancelled());
    assert!(manager.begin_input(&id, &old.attach_id, 1).is_err());
    assert_eq!(
        manager.begin_input(&id, &current.attach_id, 2).unwrap(),
        epoch
    );
    manager
        .write_input(&id, &current.attach_id, b"new stream", 2, epoch)
        .unwrap();
}
