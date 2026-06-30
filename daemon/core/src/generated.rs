pub mod wire {
    #![allow(dead_code, unused_mut, unused_variables)]

    include!(concat!(env!("OUT_DIR"), "/wire.rs"));
}

pub mod rpc {
    #![allow(dead_code, unused_mut, unused_variables)]

    include!(concat!(env!("OUT_DIR"), "/rpc.rs"));
}

#[cfg(test)]
mod tests {
    use super::rpc;

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
}
