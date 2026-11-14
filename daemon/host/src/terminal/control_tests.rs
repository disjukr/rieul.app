use super::*;

#[derive(Default)]
struct ControlState {
    resizes: Vec<(u64, u64)>,
    inputs: Vec<Vec<u8>>,
    reject_resize: bool,
}
struct Backend(Arc<Mutex<ControlState>>);
struct Control(Arc<Mutex<ControlState>>);
impl TerminalBackend for Backend {
    fn available_shells(&self) -> Result<Vec<AvailableShellInfo>, ServiceError> {
        Ok(vec![])
    }
    fn spawn(&self, _: &CreateTerminalSessionReq) -> Result<HostedTerminal, ServiceError> {
        let (_, events) = mpsc::channel();
        Ok(HostedTerminal {
            initial_cwd: None,
            control: Box::new(Control(self.0.clone())),
            events,
        })
    }
}
impl HostedTerminalControl for Control {
    fn write_input(&mut self, bytes: &[u8]) -> Result<(), ServiceError> {
        self.0.lock().unwrap().inputs.push(bytes.into());
        Ok(())
    }
    fn resize(&mut self, cols: u64, rows: u64) -> Result<(), ServiceError> {
        let mut state = self.0.lock().unwrap();
        if state.reject_resize {
            return Err(ServiceError::OperationFailed(
                "fixture resize rejected".into(),
            ));
        }
        state.resizes.push((cols, rows));
        Ok(())
    }
    fn close(&mut self) -> Result<(), ServiceError> {
        Ok(())
    }
}
fn fixture() -> (TerminalManager, String, Arc<Mutex<ControlState>>) {
    let state = Arc::new(Mutex::new(ControlState::default()));
    let manager = TerminalManager::with_backend(Arc::new(Backend(state.clone())));
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
    (manager, info.terminal_session_id, state)
}
fn attach(
    manager: &TerminalManager,
    id: &str,
    owner: u64,
    requested: Option<bool>,
    cols: u64,
    rows: u64,
) -> AttachedTerminal {
    manager
        .attach(
            AttachTerminalSessionReq {
                terminal_session_id: id.into(),
                after_seq: None,
                viewport_cols: cols,
                viewport_rows: rows,
                screen_snapshots: Some(true),
                request_control: requested,
            },
            owner,
        )
        .unwrap()
}
fn take(manager: &TerminalManager, id: &str, attach_id: &str, owner: u64) {
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
}

#[test]
fn default_observers_never_acquire_control_or_resize() {
    let (manager, id, state) = fixture();
    for request in [None, Some(false)] {
        let attached = attach(&manager, &id, 1, request, 100, 30);
        assert!(attached.control_result.is_none());
        assert!(attached.primary_attach_id.is_none());
        assert!(manager.begin_input(&id, &attached.attach_id, 1).is_err());
    }
    assert!(state.lock().unwrap().resizes.is_empty());
}
#[test]
fn vacant_primary_grants_only_the_new_session_owned_attachment() {
    let (manager, id, state) = fixture();
    let mut attached = attach(&manager, &id, 7, Some(true), 100, 30);
    assert!(
        matches!(&attached.control_result,Some(TerminalAttachControlResult::Granted{primary_attach_id}) if primary_attach_id==&attached.attach_id)
    );
    assert_eq!(
        attached.primary_attach_id.as_deref(),
        Some(attached.attach_id.as_str())
    );
    assert_eq!((attached.session.cols, attached.session.rows), (100, 30));
    assert!(matches!(
        attached.receiver.try_recv(),
        Err(broadcast::error::TryRecvError::Empty)
    ));
    assert!(manager.begin_input(&id, &attached.attach_id, 8).is_err());
    let epoch = manager.begin_input(&id, &attached.attach_id, 7).unwrap();
    manager
        .write_input(&id, &attached.attach_id, b"a", 7, epoch)
        .unwrap();
    assert_eq!(state.lock().unwrap().inputs, vec![b"a".to_vec()]);
}
#[test]
fn live_primary_is_never_preempted_even_on_the_same_rpc_session() {
    let (manager, id, state) = fixture();
    let first = attach(&manager, &id, 1, None, 80, 24);
    take(&manager, &id, &first.attach_id, 1);
    let epoch = manager.begin_input(&id, &first.attach_id, 1).unwrap();
    for owner in [1, 2] {
        let attached = attach(&manager, &id, owner, Some(true), 100, 30);
        assert!(matches!(
            attached.control_result,
            Some(TerminalAttachControlResult::NotAttempted)
        ));
        assert_eq!(attached.primary_attach_id, Some(first.attach_id.clone()));
        assert_eq!((attached.session.cols, attached.session.rows), (80, 24));
        assert!(manager
            .begin_input(&id, &attached.attach_id, owner)
            .is_err());
    }
    assert_eq!(
        manager.begin_input(&id, &first.attach_id, 1).unwrap(),
        epoch
    );
    assert_eq!(state.lock().unwrap().resizes, vec![(80, 24)]);
}
#[test]
fn detached_stale_primary_is_reacquired_and_old_input_stays_fenced() {
    let (manager, id, _) = fixture();
    let first = attach(&manager, &id, 1, None, 80, 24);
    take(&manager, &id, &first.attach_id, 1);
    let epoch = manager.begin_input(&id, &first.attach_id, 1).unwrap();
    manager.detach(&id, &first.attach_id);
    let attached = attach(&manager, &id, 2, Some(true), 80, 24);
    assert!(matches!(
        attached.control_result,
        Some(TerminalAttachControlResult::Granted { .. })
    ));
    assert!(manager
        .write_input(&id, &first.attach_id, b"old", 1, epoch)
        .is_err());
    assert_ne!(
        manager.begin_input(&id, &attached.attach_id, 2).unwrap(),
        epoch
    );
}
#[test]
fn exited_attachment_never_attempts_control_or_resize() {
    let (manager, id, state) = fixture();
    manager.mark_exited(&id, Some(0), None);
    let attached = attach(&manager, &id, 1, Some(true), 100, 30);
    assert!(attached.session.exit.is_some());
    assert!(matches!(
        attached.control_result,
        Some(TerminalAttachControlResult::NotAttempted)
    ));
    assert!(attached.primary_attach_id.is_none());
    assert!(state.lock().unwrap().resizes.is_empty());
}
#[test]
fn resize_rejection_preserves_view_attachment_authority_epoch_and_checkpoint() {
    let (manager, id, state) = fixture();
    let first = attach(&manager, &id, 1, None, 80, 24);
    take(&manager, &id, &first.attach_id, 1);
    let epoch = manager.begin_input(&id, &first.attach_id, 1).unwrap();
    manager.record_output(&id, b"before".to_vec());
    manager.detach(&id, &first.attach_id);
    state.lock().unwrap().reject_resize = true;
    let attached = attach(&manager, &id, 2, Some(true), 100, 30);
    assert!(
        matches!(&attached.control_result,Some(TerminalAttachControlResult::Rejected{error:TakeTerminalControlError::Failed{message}}) if message.contains("fixture resize rejected"))
    );
    assert_eq!(attached.primary_attach_id, Some(first.attach_id));
    assert_eq!((attached.session.cols, attached.session.rows), (80, 24));
    assert!(matches!(
        &attached.replay[0],
        TerminalEvent::ScreenSnapshot {
            cols: 80,
            rows: 24,
            ..
        }
    ));
    let session = manager.get_session(&id).unwrap();
    let guard = session.lock().unwrap();
    assert_eq!(guard.input_epoch, epoch);
    assert_eq!(guard.attach_owners.get(&attached.attach_id), Some(&2));
    drop(guard);
    assert!(manager.begin_input(&id, &attached.attach_id, 2).is_err());
}
#[test]
fn successful_resize_precedes_checkpoint_and_later_takeover_wins_in_order() {
    let (manager, id, _) = fixture();
    manager.record_output(&id, b"before".to_vec());
    let mut attached = attach(&manager, &id, 1, Some(true), 100, 30);
    assert!(matches!(
        &attached.replay[0],
        TerminalEvent::ScreenSnapshot {
            cols: 100,
            rows: 30,
            ..
        }
    ));
    let epoch = manager.begin_input(&id, &attached.attach_id, 1).unwrap();
    let next = attach(&manager, &id, 2, None, 80, 24);
    take(&manager, &id, &next.attach_id, 2);
    assert!(
        matches!(attached.receiver.try_recv().unwrap(),TerminalEvent::ControlChanged{primary_attach_id} if primary_attach_id==next.attach_id)
    );
    assert!(matches!(
        attached.receiver.try_recv().unwrap(),
        TerminalEvent::PseudoTerminalResized { cols: 80, rows: 24 }
    ));
    assert!(manager
        .write_input(&id, &attached.attach_id, b"old", 1, epoch)
        .is_err());
}
