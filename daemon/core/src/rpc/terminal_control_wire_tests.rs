use super::*;
#[path = "fixtures/terminal_legacy.rs"]
mod legacy;

fn bytes(name: &str) -> Vec<u8> {
    let value: serde_json::Value = serde_json::from_str(include_str!(
        "../../../../protocol/tests/fixtures/terminal-control-wire.json"
    ))
    .unwrap();
    value[name]
        .as_str()
        .unwrap()
        .as_bytes()
        .chunks_exact(2)
        .map(|pair| u8::from_str_radix(std::str::from_utf8(pair).unwrap(), 16).unwrap())
        .collect()
}
fn session(primary: &str) -> TerminalSessionInfo {
    TerminalSessionInfo {
        terminal_session_id: "session".into(),
        creator_client_id: "client".into(),
        cols: 80,
        rows: 24,
        primary_attach_id: Some(primary.into()),
        launch: TerminalLaunchSpec {
            command: "shell".into(),
            args: vec![],
        },
        ..Default::default()
    }
}

#[test]
fn typescript_requests_decode_with_actual_legacy_and_new_rust_codecs() {
    assert_eq!(
        legacy::AttachTerminalSessionReq::type_name(),
        "AttachTerminalSessionReq"
    );
    let old = legacy::AttachTerminalSessionReq::decode(&bytes("requestLegacy")).unwrap();
    let ignored_option =
        legacy::AttachTerminalSessionReq::decode(&bytes("requestControl")).unwrap();
    assert_eq!(ignored_option, old);
    assert_eq!(old.encode(), bytes("requestLegacy"));
    assert_eq!((old.viewport_cols, old.viewport_rows), (80, 24));
    let new = AttachTerminalSessionReq::decode(&bytes("requestControl")).unwrap();
    assert_eq!(new.request_control, Some(true));
    assert_eq!(new.encode(), bytes("requestControl"));
    let compatible = AttachTerminalSessionReq::decode(&bytes("requestLegacy")).unwrap();
    assert_eq!(compatible.request_control, None);
    assert_eq!(compatible.encode(), bytes("requestLegacy"));
}

#[test]
fn rust_host_events_equal_typescript_wire_goldens_including_typed_errors() {
    let cases = [
        ("attachedLegacy", None, "other"),
        (
            "attachedNotAttempted",
            Some(TerminalAttachControlResult::NotAttempted),
            "other",
        ),
        (
            "attachedGranted",
            Some(TerminalAttachControlResult::Granted {
                primary_attach_id: "attach".into(),
            }),
            "attach",
        ),
        (
            "attachedRejected",
            Some(TerminalAttachControlResult::Rejected {
                error: TakeTerminalControlError::InvalidSize {
                    message: "operation failed: terminal size is invalid".into(),
                },
            }),
            "other",
        ),
    ];
    for (name, control_result, primary) in cases {
        let event = TerminalEvent::Attached {
            attach_id: "attach".into(),
            primary_attach_id: Some(primary.into()),
            session: session(primary),
            control_result,
        };
        let expected = bytes(name);
        assert_eq!(event.encode(), expected, "{name}");
        assert_eq!(TerminalEvent::decode(&expected).unwrap(), event);
    }
}
