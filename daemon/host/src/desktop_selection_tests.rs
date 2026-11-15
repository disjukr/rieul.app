use super::*;
use rieul_daemon_core::generated::rpc::*;
use std::sync::{
    atomic::{AtomicBool, Ordering},
    Mutex,
};

struct Auth(AtomicBool);
impl Credentials for Auth {
    fn valid(&self, _: &str, _: u64) -> bool {
        self.0.load(Ordering::SeqCst)
    }
}
struct Native {
    displays: Mutex<Vec<DesktopDisplay>>,
    events: Mutex<Vec<DesktopInputEvent>>,
    permitted: AtomicBool,
    input_source: Mutex<String>,
    input_source_calls: std::sync::atomic::AtomicU64,
}
impl Backend for Native {
    fn input_sources(&self) -> Result<DesktopInputSources, Error> {
        Ok(DesktopInputSources {
            sources: ["english", "korean"].into_iter().map(|id| DesktopInputSource { id: id.into(), name: id.into() }).collect(),
            current_id: Some(self.input_source.lock().unwrap().clone()),
        })
    }
    fn select_input_source(&self, id: &str) -> Result<DesktopInputSources, Error> {
        self.input_source_calls.fetch_add(1, Ordering::SeqCst);
        if id != "english" && id != "korean" { return Err(Error::Invalid); }
        *self.input_source.lock().unwrap() = id.into();
        self.input_sources()
    }

    fn capabilities(&self) -> DesktopCapabilities {
        DesktopCapabilities {
            profile: PROFILE,
            capture: if self.permitted.load(Ordering::SeqCst) {
                DesktopAvailability::Available
            } else {
                DesktopAvailability::PermissionRequired
            },
            input: DesktopAvailability::Available,
            codecs: vec![DesktopCodec {
                codec: "fixture".into(),
                ..Default::default()
            }],
            ..Default::default()
        }
    }
    fn displays(&self) -> Vec<DesktopDisplay> {
        self.displays.lock().unwrap().clone()
    }
    fn input(&self, event: &DesktopInputEvent) -> Result<(), Error> {
        self.events.lock().unwrap().push(event.clone());
        Ok(())
    }
    fn probe_video(&self, _: &DesktopTrack) -> DesktopQualityVerification {
        DesktopQualityVerification::Verified
    }
}
fn setup() -> (Arc<Runtime>, Arc<Native>, Auth, String) {
    let native = Arc::new(Native {
        displays: Mutex::new(
            ["left", "right"]
                .into_iter()
                .enumerate()
                .map(|(i, id)| DesktopDisplay {
                    display_id: id.into(),
                    bounds: DesktopRect {
                        x: i as i64 * 1280 - 1280,
                        width: 1280,
                        height: 720,
                        ..Default::default()
                    },
                    scale: 1.0,
                    dpi: 96.0,
                    arrangement_bounds: None,
                })
                .collect(),
        ),
        events: Mutex::new(vec![]),
        permitted: AtomicBool::new(true),
        input_source: Mutex::new("english".into()),
        input_source_calls: Default::default(),
    });
    let runtime = Runtime::new(Arc::new(WorkGate::default()), Some(native.clone()));
    let auth = Auth(AtomicBool::new(true));
    let DesktopEvent::Attached {
        attach_id,
        displays,
        ..
    } = runtime
        .attach(
            &auth,
            1,
            "paired",
            0,
            &AttachDesktopReq {
                profile: PROFILE,
                codecs: vec!["fixture".into()],
                media_uni_streams: true,
                keyboard_mode: DesktopKeyboardMode::Physical,
            },
        )
        .unwrap()
    else {
        panic!()
    };
    assert_eq!(displays.len(), 2);
    assert!(runtime.configuration(&attach_id).is_none());
    (runtime, native, auth, attach_id)
}
fn select(
    r: &Runtime,
    a: &Auth,
    id: &str,
    display: Option<&str>,
) -> Result<DesktopConfiguration, Error> {
    let DesktopEvent::Layout { layout_epoch, .. } = r.layout_event()? else {
        unreachable!()
    };
    r.select_existing(
        a,
        1,
        0,
        SelectExistingDesktopReq {
            attach_id: id.into(),
            expected_layout_epoch: layout_epoch,
            selection: display
                .map(|id| DesktopDisplaySelection::Display {
                    display_id: id.into(),
                })
                .unwrap_or(DesktopDisplaySelection::Clear {}),
        },
    )
}
#[test]
fn selected_existing_geometry_quality_and_legacy_ownership() {
    let (r, _, a, id) = setup();
    assert!(!r.automatically_configured(&id).unwrap());
    let config = select(&r, &a, &id, Some("right")).unwrap();
    assert_eq!(config.tracks.len(), 1);
    assert_eq!(config.tracks[0].viewport.display_id, "right");
    assert_eq!(config.tracks[0].viewport.crop.x, 0);
    let legacy = ConfigureDesktopViewportsReq {
        attach_id: id.clone(),
        layout_epoch: config.layout_epoch,
        viewports: vec![],
        total_bitrate: 1,
    };
    assert_eq!(r.configure(&a, 1, 0, legacy).unwrap_err(), Error::Invalid);
    let support = r
        .query_quality(
            &a,
            1,
            0,
            DesktopQualityQuery {
                attach_id: id.clone(),
                candidates: None,
            },
        )
        .unwrap();
    assert!(support.automatic_available);
    assert!(support
        .candidates
        .iter()
        .all(|c| c.tracks.len() == 1 && c.tracks[0].viewport.display_id == "right"));
    let automatic = r
        .set_quality(
            &a,
            1,
            0,
            SetDesktopQualityReq {
                attach_id: id.clone(),
                layout_epoch: support.layout_epoch,
                revision: support.revision,
                policy: DesktopQualityPolicy::Auto,
            },
        )
        .unwrap();
    assert_eq!(automatic.tracks.len(), 1);
    assert_eq!(automatic.tracks[0].viewport.display_id, "right");
    select(&r, &a, &id, Some("left")).unwrap();
    assert_eq!(
        r.set_quality(
            &a,
            1,
            0,
            SetDesktopQualityReq {
                attach_id: id,
                layout_epoch: support.layout_epoch,
                revision: support.revision,
                policy: DesktopQualityPolicy::Auto
            }
        )
        .unwrap_err(),
        Error::Stale
    );
}
#[test]
fn selection_auth_epoch_permission_and_clear_are_fail_closed() {
    let (r, native, a, id) = setup();
    let config = select(&r, &a, &id, Some("right")).unwrap();
    let req = SelectExistingDesktopReq {
        attach_id: id.clone(),
        expected_layout_epoch: config.layout_epoch,
        selection: DesktopDisplaySelection::Display {
            display_id: "left".into(),
        },
    };
    assert_eq!(
        r.select_existing(&a, 2, 0, req.clone()).unwrap_err(),
        Error::Unauthorized
    );
    assert_eq!(
        r.select_existing(
            &a,
            1,
            0,
            SelectExistingDesktopReq {
                expected_layout_epoch: 0,
                ..req.clone()
            }
        )
        .unwrap_err(),
        Error::Stale
    );
    assert_eq!(
        select(&r, &a, &id, Some("missing")).unwrap_err(),
        Error::NotFound
    );
    assert_eq!(r.configuration(&id).unwrap(), config);
    r.mutate(|d| d.set_control(&a, 1, &id, 0, DesktopControlAction::Acquire))
        .unwrap();
    r.accept_input(
        &a,
        1,
        0,
        DesktopInputFrame {
            attach_id: id.clone(),
            input_epoch: r.control().unwrap().input_epoch,
            layout_epoch: config.layout_epoch,
            sequence: 1,
            event: DesktopInputEvent::PhysicalKey {
                usage: 225,
                down: true,
                repeat: false,
            },
        },
    )
    .unwrap();
    native.permitted.store(false, Ordering::SeqCst);
    assert_eq!(
        r.select_existing(&a, 1, 0, req).unwrap_err(),
        Error::Unsupported
    );
    assert_eq!(
        r.control().unwrap().holder_attach_id.as_deref(),
        Some(id.as_str())
    );
    let cleared = select(&r, &a, &id, None).unwrap();
    assert!(cleared.tracks.is_empty());
    assert!(r.control().unwrap().holder_attach_id.is_none());
    assert!(native.events.lock().unwrap().iter().any(|event| matches!(
        event,
        DesktopInputEvent::ReleaseAll
            | DesktopInputEvent::PhysicalKey {
                usage: 225,
                down: false,
                ..
            }
    )));
    assert_eq!(
        r.mutate(|d| d.set_control(&a, 1, &id, 0, DesktopControlAction::Acquire))
            .unwrap_err(),
        Error::Invalid
    );
    a.0.store(false, Ordering::SeqCst);
    assert!(select(&r, &a, &id, None).is_err());
}
#[test]
fn selected_hotplug_never_substitutes_or_automatically_restores() {
    let (r, native, a, id) = setup();
    select(&r, &a, &id, Some("right")).unwrap();
    r.mutate(|d| d.set_control(&a, 1, &id, 0, DesktopControlAction::Acquire))
        .unwrap();
    let removed = native.displays.lock().unwrap().pop().unwrap();
    r.refresh_layout().unwrap();
    assert!(r.control().unwrap().holder_attach_id.is_none());
    assert!(r.configuration(&id).is_none());
    assert_eq!(
        r.mutate(|d| d.set_control(&a, 1, &id, 0, DesktopControlAction::Acquire))
            .unwrap_err(),
        Error::Invalid
    );
    // Replug before any event-loop reconfiguration must not restore selection.
    native.displays.lock().unwrap().push(removed);
    r.refresh_layout().unwrap();
    assert!(r
        .configure_existing(&a, 1, 0, &id)
        .unwrap()
        .tracks
        .is_empty());
    assert_eq!(select(&r, &a, &id, Some("right")).unwrap().tracks.len(), 1);
}
#[test]
fn clearing_one_attachment_does_not_release_another_controller_and_all_mode_stays_all() {
    let (r, _, a, id) = setup();
    let DesktopEvent::Attached {
        attach_id: other, ..
    } = r
        .attach(
            &a,
            1,
            "paired",
            0,
            &AttachDesktopReq {
                profile: PROFILE,
                codecs: vec!["fixture".into()],
                media_uni_streams: true,
                keyboard_mode: DesktopKeyboardMode::Physical,
            },
        )
        .unwrap()
    else {
        panic!()
    };
    r.configure_existing(&a, 1, 0, &other).unwrap();
    r.mutate(|d| d.set_control(&a, 1, &other, 0, DesktopControlAction::Acquire))
        .unwrap();
    select(&r, &a, &id, None).unwrap();
    assert_eq!(
        r.control().unwrap().holder_attach_id.as_deref(),
        Some(other.as_str())
    );
    assert_eq!(
        select(&r, &a, &other, Some("right")).unwrap_err(),
        Error::Invalid
    );
    assert_eq!(r.configuration(&other).unwrap().tracks.len(), 2);
}

#[test]
fn stale_hotplug_rebuild_cannot_override_a_newer_clear() {
    let (r, _, a, id) = setup();
    select(&r, &a, &id, Some("right")).unwrap();
    select(&r, &a, &id, None).unwrap();
    assert_eq!(
        r.configure_existing_mode(
            &a,
            1,
            0,
            &id,
            None,
            AttachmentMode::ExistingOne("right".into()),
            Some(AttachmentMode::ExistingOne("right".into()))
        )
        .unwrap_err(),
        Error::Stale
    );
    assert!(r.configuration(&id).unwrap().tracks.is_empty());
}

#[test]
fn layout_event_updates_for_arrangement_only_changes() {
    let (runtime, native, _, _) = setup();
    let original = DesktopArrangementRect {
        x: -1280.0,
        y: 0.0,
        width: 1280.0,
        height: 720.0,
    };
    native.displays.lock().unwrap()[0].arrangement_bounds = Some(original.clone());
    runtime.refresh_layout().unwrap();
    let DesktopEvent::Layout {
        layout_epoch,
        displays,
    } = runtime.layout_event().unwrap()
    else {
        panic!("expected layout")
    };

    let changed = DesktopArrangementRect {
        width: 960.0,
        height: 540.0,
        ..original
    };
    native.displays.lock().unwrap()[0].arrangement_bounds = Some(changed.clone());
    runtime.refresh_layout().unwrap();
    let expected = DesktopEvent::Layout {
        layout_epoch: layout_epoch + 1,
        displays: vec![
            DesktopDisplay {
                arrangement_bounds: Some(changed),
                ..displays[0].clone()
            },
            displays[1].clone(),
        ],
    };
    assert_eq!(runtime.layout_event().unwrap(), expected);
    runtime.refresh_layout().unwrap();
    assert_eq!(runtime.layout_event().unwrap(), expected);
}

#[test]
fn input_source_query_never_acquires_control_and_selection_is_controller_fenced() {
    let (r, native, a, id) = setup();
    let query = DesktopAttachRef { attach_id: id.clone() };
    assert_eq!(r.query_input_sources(&a, 2, 0, query.clone()).unwrap_err(), Error::Unauthorized);
    assert_eq!(r.query_input_sources(&a, 1, 0, query).unwrap().current_id.as_deref(), Some("english"));
    assert!(r.control().unwrap().holder_attach_id.is_none());
    let mut req = SelectDesktopInputSourceReq { attach_id: id.clone(), input_epoch: r.control().unwrap().input_epoch, source_id: "korean".into() };
    assert_eq!(r.select_input_source(&a, 1, 0, req.clone()).unwrap_err(), Error::Stale);
    select(&r, &a, &id, Some("right")).unwrap();
    r.mutate(|d| d.set_control(&a, 1, &id, 0, DesktopControlAction::Acquire)).unwrap();
    req.input_epoch = r.control().unwrap().input_epoch;
    assert_eq!(r.select_input_source(&a, 2, 0, req.clone()).unwrap_err(), Error::Unauthorized);
    assert_eq!(native.input_source_calls.load(Ordering::SeqCst), 0);
    assert_eq!(r.select_input_source(&a, 1, 0, req.clone()).unwrap().current_id.as_deref(), Some("korean"));
    assert_eq!(native.input_source_calls.load(Ordering::SeqCst), 1);
    r.mutate(|d| d.set_control(&a, 1, &id, 0, DesktopControlAction::Release)).unwrap();
    r.mutate(|d| d.set_control(&a, 1, &id, 0, DesktopControlAction::Acquire)).unwrap();
    assert_eq!(r.select_input_source(&a, 1, 0, req.clone()).unwrap_err(), Error::Stale);
    req.input_epoch = r.control().unwrap().input_epoch;
    req.source_id = "\0bad".into();
    assert_eq!(r.select_input_source(&a, 1, 0, req.clone()).unwrap_err(), Error::Invalid);
    req.source_id = "english".into();
    assert_eq!(r.select_input_source(&a, 1, LEASE_MS, req).unwrap_err(), Error::NotFound);
    assert_eq!(native.input_source_calls.load(Ordering::SeqCst), 1);
}
#[test]
fn input_source_selection_rejects_revoked_credentials_and_stale_helper() {
    for revoke in [false, true] {
        let (r, native, a, id) = setup();
        select(&r, &a, &id, Some("right")).unwrap();
        r.mutate(|d| d.set_control(&a, 1, &id, 0, DesktopControlAction::Acquire)).unwrap();
        let req = SelectDesktopInputSourceReq { attach_id: id, input_epoch: r.control().unwrap().input_epoch, source_id: "korean".into() };
        if revoke { a.0.store(false, Ordering::SeqCst); }
        else { r.state.lock().unwrap().backend_generation += 1; }
        assert!(r.select_input_source(&a, 1, 0, req).is_err());
        assert_eq!(native.input_source_calls.load(Ordering::SeqCst), 0);
    }
}
