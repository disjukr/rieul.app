pub mod wire {
    #![allow(dead_code, unused_mut, unused_variables)]

    include!(concat!(env!("OUT_DIR"), "/wire.rs"));
}

pub mod socket_wire {
    #![allow(dead_code, unused_mut, unused_variables)]

    include!(concat!(env!("OUT_DIR"), "/socket_wire.rs"));
}

pub mod rpc {
    #![allow(dead_code, unused_mut, unused_variables)]

    include!(concat!(env!("OUT_DIR"), "/rpc.rs"));
}

pub mod ipc {
    #![allow(dead_code, unused_mut, unused_variables)]

    include!(concat!(env!("OUT_DIR"), "/ipc.rs"));
}

#[cfg(test)]
mod tests {
    use super::{ipc, rpc, socket_wire};

    #[test]
    fn generated_rpc_model_roundtrips() {
        let value = rpc::DaemonInfo {
            supported_proc_ids: vec![1, 2, 3],
            version: "0.1.0".to_string(),
            os: "windows".to_string(),
            instance_id: "1234-5678".to_string(),
            started_at_ms: 1_234,
            server_time_ms: 5_678,
        };

        let encoded = value.encode();
        assert_eq!(rpc::DaemonInfo::decode(&encoded).unwrap(), value);
    }

    #[test]
    fn generated_u53_model_encoding_rejects_large_integer() {
        let value = rpc::DaemonInfo {
            supported_proc_ids: vec![u64::MAX],
            version: String::new(),
            os: String::new(),
            instance_id: String::new(),
            started_at_ms: 0,
            server_time_ms: 0,
        };

        assert!(matches!(
            value.try_encode(),
            Err(rpc::CodecError::IntegerOutOfRange("u53"))
        ));
    }

    #[test]
    fn generated_proc_metadata_decodes_request_payload() {
        let payload = rpc::StartPairingReq {
            confirmation_code: "42".to_string(),
            client_label: "test".to_string(),
            client_id: Some("client-1".to_string()),
        };

        assert_eq!(rpc::ProcId::from_u64(2), Some(rpc::ProcId::StartPairing));
        assert_eq!(rpc::PROC_DEFINITIONS.len(), rpc::ProcId::KNOWN.len());
        assert_eq!(rpc::PROC_DEFINITIONS[1].id, rpc::ProcId::StartPairing);
        assert_eq!(rpc::PROC_DEFINITIONS[1].wire_id, 2);
        assert_eq!(rpc::PROC_DEFINITIONS[1].name, "StartPairing");
        assert_eq!(rpc::ProcId::StartPairing.stream(), rpc::ProcStream::Unary);
        assert_eq!(
            rpc::RpcRequest::decode(2, Some(&payload.encode())).unwrap(),
            rpc::RpcRequest::StartPairing(payload)
        );
        assert!(matches!(
            rpc::RpcRequest::decode(2, None),
            Err(rpc::RpcRequestDecodeError::MissingPayload {
                proc: rpc::ProcId::StartPairing
            })
        ));
    }

    #[test]
    fn generated_socket_wire_message_roundtrips() {
        let message = socket_wire::SocketReqResMessage::RequestUnary {
            proc_id: ipc::ProcId::ShowPairingCode.as_u64(),
            payload: Some(b"payload".to_vec()),
            stream_id: 1,
        };

        let encoded = message.encode_value().unwrap().encode();
        assert_eq!(
            socket_wire::SocketReqResMessage::decode_value(
                &crate::cbor::Value::decode(&encoded).unwrap()
            )
            .unwrap(),
            message
        );
    }

    #[test]
    fn generated_ipc_proc_metadata_decodes_request_payload() {
        let payload = ipc::ShowPairingCodeReq {
            daemon_url: "https://localhost:9012".to_string(),
            pairing_code: "123456".to_string(),
            expires_in_seconds: 60,
        };

        assert_eq!(ipc::ProcId::from_u64(1), Some(ipc::ProcId::ShowPairingCode));
        assert_eq!(
            ipc::RpcRequest::decode(1, Some(&payload.encode())).unwrap(),
            ipc::RpcRequest::ShowPairingCode(payload)
        );
    }

    #[test]
    fn generated_user_terminal_ipc_contract_roundtrips() {
        let command = ipc::UserTerminalCommand::Start {
            cols: 120,
            rows: 40,
            cwd: Some(r"C:\Users\alice".to_string()),
            launch: ipc::UserTerminalLaunchSpec {
                command: r"C:\Program Files\Git\bin\bash.exe".to_string(),
                args: vec!["--login".to_string(), "-i".to_string()],
            },
        };

        assert_eq!(
            ipc::ProcId::from_u64(7),
            Some(ipc::ProcId::GetUserProcessInfo)
        );
        assert_eq!(
            ipc::ProcId::from_u64(8),
            Some(ipc::ProcId::SnapshotUserTerminalShells)
        );
        assert_eq!(
            ipc::ProcId::from_u64(9),
            Some(ipc::ProcId::HostUserTerminal)
        );
        assert_eq!(
            ipc::ProcId::HostUserTerminal.stream(),
            ipc::ProcStream::Bidi
        );
        assert_eq!(
            ipc::UserTerminalCommand::decode(&command.encode()).unwrap(),
            command
        );

        let event = ipc::UserTerminalEvent::Output {
            bytes: b"hello\r\n".to_vec(),
        };
        assert_eq!(
            ipc::UserTerminalEvent::decode(&event.encode()).unwrap(),
            event
        );
    }
}
