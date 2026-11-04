use super::*;
use crate::{desktop::Runtime, maintenance::WorkGate};
use std::sync::{
    Mutex,
    atomic::{AtomicBool, AtomicUsize, Ordering},
};

#[derive(Default)]
struct Native {
    events: Mutex<Vec<DesktopInputEvent>>,
    recovered: Mutex<Vec<(Vec<u64>, Vec<u64>)>>,
    fail_recovery: AtomicBool,
    groups: AtomicUsize,
    recovery_started: AtomicBool,
    block_recovery: Mutex<Option<std::sync::mpsc::Receiver<()>>>,
}
impl Backend for Native {
    fn capabilities(&self) -> DesktopCapabilities {
        DesktopCapabilities {
            capture: DesktopAvailability::Available,
            input: DesktopAvailability::Available,
            codecs: vec![DesktopCodec {
                codec: "fixture".into(),
                hardware: false,
                description: None,
            }],
            ..Default::default()
        }
    }
    fn displays(&self) -> Vec<DesktopDisplay> {
        vec![]
    }
    fn input(&self, event: &DesktopInputEvent) -> Result<(), Error> {
        self.events.lock().unwrap().push(event.clone());
        Ok(())
    }
    fn recover_input(&self, keys: &[u64], buttons: &[u64]) -> Result<(), Error> {
        if let Some(wait) = self.block_recovery.lock().unwrap().take() {
            self.recovery_started.store(true, Ordering::SeqCst);
            wait.recv_timeout(Duration::from_secs(2))
                .map_err(|_| Error::Backend)?;
        }
        self.recovered
            .lock()
            .unwrap()
            .push((keys.to_vec(), buttons.to_vec()));
        if self.fail_recovery.load(Ordering::SeqCst) {
            return Err(Error::Backend);
        }
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
    fn group(&self, _: &DesktopTrack) -> Result<Vec<EncodedFrame>, Error> {
        self.groups.fetch_add(1, Ordering::SeqCst);
        std::thread::sleep(Duration::from_millis(150));
        Ok(vec![EncodedFrame::new(1, true, vec![7])])
    }
}
struct Harness {
    proxy: Arc<Proxy>,
    native: Arc<Native>,
    helpers: Arc<Mutex<Vec<tokio::task::AbortHandle>>>,
    attempts: Arc<AtomicUsize>,
}
impl Harness {
    fn new() -> Self {
        let native = Arc::new(Native::default());
        let helpers = Arc::new(Mutex::new(vec![]));
        let attempts = Arc::new(AtomicUsize::new(0));
        let n = native.clone();
        let h = helpers.clone();
        let a = attempts.clone();
        let proxy = Arc::new(Proxy::new(Arc::new(move || {
            let n = n.clone();
            let h = h.clone();
            a.fetch_add(1, Ordering::SeqCst);
            Box::pin(async move {
                let (client, server) = tokio::io::duplex(65536);
                let task = tokio::spawn(serve(server, n));
                h.lock().unwrap().push(task.abort_handle());
                Ok(Box::new(client) as Connection)
            })
        })));
        Self {
            proxy,
            native,
            helpers,
            attempts,
        }
    }
    async fn crash(&self) {
        let previous = self.proxy.generation();
        self.helpers.lock().unwrap().last().unwrap().abort();
        tokio::time::timeout(Duration::from_secs(5), async {
            while self.proxy.generation() == previous {
                tokio::time::sleep(Duration::from_millis(10)).await;
            }
        })
        .await
        .unwrap();
    }
}
struct Auth;
impl crate::desktop::Credentials for Auth {
    fn valid(&self, _: &str, _: u64) -> bool {
        true
    }
}
fn attach(runtime: &Runtime, connection: u64) -> String {
    let event = runtime
        .attach(
            &Auth,
            connection,
            "paired",
            1,
            &AttachDesktopReq {
                profile: PROFILE,
                codecs: vec!["fixture".into()],
                media_uni_streams: true,
                keyboard_mode: DesktopKeyboardMode::Physical,
            },
        )
        .unwrap();
    let DesktopEvent::Attached { attach_id, .. } = event else {
        panic!()
    };
    attach_id
}
fn key(down: bool) -> DesktopInputEvent {
    DesktopInputEvent::PhysicalKey {
        usage: 4,
        down,
        repeat: false,
    }
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn crash_releases_uncertain_input_then_invalidates_attachments_and_old_tracks() {
    let h = Harness::new();
    let gate = Arc::new(WorkGate::default());
    let runtime = Runtime::new(gate.clone(), Some(h.proxy.clone()));
    let r = runtime.clone();
    let p = h.proxy.clone();
    let (id, epoch) = tokio::task::spawn_blocking(move || {
        let id = attach(&r, 1);
        r.mutate(|d| d.set_control(&Auth, 1, &id, 1, DesktopControlAction::Acquire))
            .unwrap();
        p.input(&key(true)).unwrap();
        p.input(&DesktopInputEvent::Button {
            viewport_id: "v".into(),
            x: 0.0,
            y: 0.0,
            button: 1,
            down: true,
        })
        .unwrap();
        (id, r.control().unwrap().input_epoch)
    })
    .await
    .unwrap();
    h.crash().await;
    h.native.fail_recovery.store(true, Ordering::SeqCst);
    let r = runtime.clone();
    tokio::task::spawn_blocking(move || {
        assert_eq!(r.capabilities().capture, DesktopAvailability::Unsupported);
    })
    .await
    .unwrap();
    assert!(
        gate.active() > 0,
        "uncertain input retains update protection"
    );
    h.native.fail_recovery.store(false, Ordering::SeqCst);
    let r = runtime.clone();
    let p = h.proxy.clone();
    let old = id.clone();
    let new = tokio::task::spawn_blocking(move || {
        assert_eq!(r.capabilities().capture, DesktopAvailability::Available);
        assert!(!r.has(&old));
        assert_eq!(r.control().unwrap().holder_attach_id, None);
        assert!(r.control().unwrap().input_epoch > epoch);
        let new = attach(&r, 2);
        assert_ne!(new, old);
        assert!(
            r.mutate(|d| d.set_control(&Auth, 1, &old, 2, DesktopControlAction::Acquire))
                .is_err()
        );
        assert!(
            p.group(&DesktopTrack {
                viewport: DesktopViewport {
                    bitrate: 1000,
                    ..Default::default()
                },
                codec_epoch: 0,
                ..Default::default()
            })
            .is_err()
        );
        p.end_track(&DesktopTrack {
            viewport: DesktopViewport {
                bitrate: 1000,
                ..Default::default()
            },
            codec_epoch: 0,
            ..Default::default()
        })
        .unwrap();
        r.close(1);
        assert!(r.has(&new)); // delayed old disconnect cannot remove new attachment
        r.close(2);
        new
    })
    .await
    .unwrap();
    assert_ne!(new, id);
    assert_eq!(gate.active(), 0);
    let recovery = h.native.recovered.lock().unwrap();
    assert!(recovery.iter().any(|(k, b)| k == &vec![4] && b == &vec![1]));
    let events = h.native.events.lock().unwrap();
    assert_eq!(
        events.iter().filter(|e| **e == key(true)).count(),
        1,
        "no input replay"
    );
    assert!(events.contains(&key(false)));
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn outstanding_old_frame_is_not_delivered_after_recovery_and_shutdown_does_not_restart() {
    let h = Harness::new();
    let p = h.proxy.clone();
    tokio::task::spawn_blocking(move || p.recover(1).unwrap())
        .await
        .unwrap();
    let p = h.proxy.clone();
    let frame = tokio::task::spawn_blocking(move || {
        p.group(&DesktopTrack {
            viewport: DesktopViewport {
                bitrate: 1000,
                ..Default::default()
            },
            codec_epoch: 1,
            ..Default::default()
        })
    });
    tokio::time::timeout(Duration::from_secs(2), async {
        while h.native.groups.load(Ordering::SeqCst) == 0 {
            tokio::task::yield_now().await;
        }
    })
    .await
    .unwrap();
    h.crash().await;
    assert!(frame.await.unwrap().is_err());
    let p = h.proxy.clone();
    tokio::task::spawn_blocking(move || {
        p.recover(2).unwrap();
        assert!(
            p.group(&DesktopTrack {
                viewport: DesktopViewport {
                    bitrate: 1000,
                    ..Default::default()
                },
                codec_epoch: 1,
                ..Default::default()
            })
            .is_err()
        );
        assert_eq!(
            p.group(&DesktopTrack {
                viewport: DesktopViewport {
                    bitrate: 1000,
                    ..Default::default()
                },
                codec_epoch: 2,
                ..Default::default()
            })
            .unwrap()[0]
                .data,
            vec![7]
        );
    })
    .await
    .unwrap();
    let attempts = h.attempts.clone();
    let before = attempts.load(Ordering::SeqCst);
    let helpers = h.helpers.clone();
    drop(h);
    tokio::time::timeout(Duration::from_secs(3), async {
        loop {
            if helpers.lock().unwrap().iter().all(|h| h.is_finished()) {
                break;
            }
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
    })
    .await
    .unwrap();
    assert_eq!(attempts.load(Ordering::SeqCst), before);
}

#[test]
fn uncertain_ledger_preserves_later_down_when_earlier_release_is_acknowledged() {
    let mut l = Ledger::default();
    let input = |down| UserDesktopCommand::Input {
        event: ipc::DesktopInputEvent::PhysicalKey {
            usage: 4,
            down,
            repeat: false,
        },
        viewport: None,
    };
    l.record(&input(true), 1);
    l.record(&input(true), 3);
    l.ack(&input(false), 2);
    assert_eq!(l.keys.get(&4), Some(&3));
    l.ack(
        &UserDesktopCommand::Input {
            event: ipc::DesktopInputEvent::ReleaseAll,
            viewport: None,
        },
        2,
    );
    assert_eq!(l.keys.get(&4), Some(&3));
    l.ack(&input(false), 4);
    assert!(l.keys.is_empty());
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn disconnect_during_recovery_and_concurrent_attach_do_not_restore_control() {
    let h = Harness::new();
    let gate = Arc::new(WorkGate::default());
    let runtime = Runtime::new(gate.clone(), Some(h.proxy.clone()));
    let r = runtime.clone();
    let old = tokio::task::spawn_blocking(move || attach(&r, 1))
        .await
        .unwrap();
    h.crash().await;
    let (tx, rx) = std::sync::mpsc::channel();
    *h.native.block_recovery.lock().unwrap() = Some(rx);
    let r = runtime.clone();
    let recovery = tokio::task::spawn_blocking(move || r.capabilities());
    tokio::time::timeout(Duration::from_secs(2), async {
        while !h.native.recovery_started.load(Ordering::SeqCst) {
            tokio::task::yield_now().await;
        }
    })
    .await
    .unwrap();
    assert!(
        gate.begin_drain().is_none(),
        "recovery is protected against updater drain"
    );
    let r = runtime.clone();
    let disconnect = tokio::task::spawn_blocking(move || r.close(1));
    let r = runtime.clone();
    let first = tokio::task::spawn_blocking(move || attach(&r, 2));
    let r = runtime.clone();
    let second = tokio::task::spawn_blocking(move || attach(&r, 3));
    tx.send(()).unwrap();
    assert_eq!(
        recovery.await.unwrap().capture,
        DesktopAvailability::Available
    );
    disconnect.await.unwrap();
    let first = first.await.unwrap();
    let second = second.await.unwrap();
    assert_ne!(first, second);
    assert_ne!(first, old);
    assert_ne!(second, old);
    assert_eq!(runtime.control().unwrap().holder_attach_id, None);
    let r = runtime.clone();
    tokio::task::spawn_blocking(move || {
        r.close(2);
        r.close(3);
    })
    .await
    .unwrap();
    assert_eq!(gate.active(), 0);
    let drain = gate.begin_drain().unwrap();
    let r = runtime.clone();
    assert_eq!(
        tokio::task::spawn_blocking(move || r.capabilities().capture)
            .await
            .unwrap(),
        DesktopAvailability::Unsupported
    );
    drop(drain);
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn uncertain_capture_guard_survives_failed_recovery_and_retires_only_after_ack() {
    let h = Harness::new();
    let p = h.proxy.clone();
    tokio::task::spawn_blocking(move || p.recover(1).unwrap())
        .await
        .unwrap();
    h.crash().await;
    let gate = Arc::new(WorkGate::default());
    let track = DesktopTrack {
        viewport: DesktopViewport {
            bitrate: 1000,
            ..Default::default()
        },
        codec_epoch: 1,
        ..Default::default()
    };
    h.proxy.retain_uncertain_capture(&track, gate.enter());
    assert_eq!(gate.active(), 1);
    h.native.fail_recovery.store(true, Ordering::SeqCst);
    let p = h.proxy.clone();
    assert!(
        tokio::task::spawn_blocking(move || p.recover(2))
            .await
            .unwrap()
            .is_err()
    );
    assert_eq!(gate.active(), 1);
    assert!(gate.begin_drain().is_none());
    h.native.fail_recovery.store(false, Ordering::SeqCst);
    let p = h.proxy.clone();
    tokio::task::spawn_blocking(move || p.recover(2).unwrap())
        .await
        .unwrap();
    assert_eq!(gate.active(), 0);
    assert!(gate.begin_drain().is_some());
    // Cleanup arriving late after the recovery acknowledgment must not leak a guard.
    h.proxy.retain_uncertain_capture(&track, gate.enter());
    assert_eq!(gate.active(), 0);
}
