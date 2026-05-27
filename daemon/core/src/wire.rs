use std::collections::BTreeMap;

use thiserror::Error;

use crate::cbor::{CborError, Value};

pub const MAX_MESSAGE_SEQUENCE_SIZE: usize = 64 * 1024 * 1024;
pub const PAIRED_SECRET_AUTH_MECHANISM: &str = "wgo.paired-secret.v1";

#[derive(Debug, Error)]
pub enum WireError {
    #[error("cbor error: {0}")]
    Cbor(#[from] CborError),
    #[error("message sequence is empty")]
    EmptySequence,
    #[error("expected message kind")]
    ExpectedMessageKind,
    #[error("expected message fields map")]
    ExpectedFieldsMap,
    #[error("reqres message sequence ended with an incomplete kind/map pair")]
    IncompleteMessagePair,
    #[error("unknown reqres message variant {0}")]
    UnknownMessageVariant(u64),
    #[error("expected datagram message union tuple")]
    ExpectedDatagramMessage,
    #[error("unknown datagram message variant {0}")]
    UnknownDatagramMessageVariant(u64),
    #[error("missing field {0}")]
    MissingField(u64),
    #[error("unexpected field type for field {0}")]
    WrongFieldType(u64),
    #[error("message sequence exceeds implementation limit")]
    SequenceTooLarge,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
#[repr(u64)]
pub enum ReqResMessageKind {
    RequestUnary = 0,
    RequestStreamStart = 1,
    RequestStreamChunk = 2,
    ResponseUnaryOk = 3,
    ResponseUnaryError = 4,
    ResponseStreamStart = 5,
    ResponseStreamChunk = 6,
    ResponseStreamErrorEnd = 7,
    SessionAuthenticate = 8,
    SessionAuthenticated = 9,
    SessionAuthError = 10,
}

impl ReqResMessageKind {
    pub fn from_u64(value: u64) -> Option<Self> {
        match value {
            0 => Some(Self::RequestUnary),
            1 => Some(Self::RequestStreamStart),
            2 => Some(Self::RequestStreamChunk),
            3 => Some(Self::ResponseUnaryOk),
            4 => Some(Self::ResponseUnaryError),
            5 => Some(Self::ResponseStreamStart),
            6 => Some(Self::ResponseStreamChunk),
            7 => Some(Self::ResponseStreamErrorEnd),
            8 => Some(Self::SessionAuthenticate),
            9 => Some(Self::SessionAuthenticated),
            10 => Some(Self::SessionAuthError),
            _ => None,
        }
    }

    pub fn as_u64(self) -> u64 {
        self as u64
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
#[repr(u64)]
pub enum DatagramMessageKind {
    Ping = 1,
    Pong = 2,
}

impl DatagramMessageKind {
    pub fn from_u64(value: u64) -> Option<Self> {
        match value {
            1 => Some(Self::Ping),
            2 => Some(Self::Pong),
            _ => None,
        }
    }

    pub fn as_u64(self) -> u64 {
        self as u64
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
#[repr(u64)]
pub enum RpcErrorKind {
    System = 1,
    Method = 2,
}

impl RpcErrorKind {
    pub fn from_u64(value: u64) -> Option<Self> {
        match value {
            1 => Some(Self::System),
            2 => Some(Self::Method),
            _ => None,
        }
    }

    pub fn as_u64(self) -> u64 {
        self as u64
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
#[repr(u64)]
pub enum SessionAuthErrorCode {
    UnsupportedMechanism = 1,
    InvalidCredentials = 2,
    MalformedPayload = 3,
    AlreadyAuthenticated = 4,
}

impl SessionAuthErrorCode {
    pub fn from_u64(value: u64) -> Option<Self> {
        match value {
            1 => Some(Self::UnsupportedMechanism),
            2 => Some(Self::InvalidCredentials),
            3 => Some(Self::MalformedPayload),
            4 => Some(Self::AlreadyAuthenticated),
            _ => None,
        }
    }

    pub fn as_u64(self) -> u64 {
        self as u64
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ReqResMessage {
    RequestUnary {
        proc_id: u64,
        payload: Option<Vec<u8>>,
    },
    RequestStreamStart {
        proc_id: u64,
        payload: Option<Vec<u8>>,
    },
    RequestStreamChunk {
        payload: Vec<u8>,
    },
    ResponseUnaryOk {
        payload: Option<Vec<u8>>,
    },
    ResponseUnaryError {
        error: Vec<u8>,
        error_kind: RpcErrorKind,
    },
    ResponseStreamStart {
        payload: Option<Vec<u8>>,
    },
    ResponseStreamChunk {
        payload: Vec<u8>,
    },
    ResponseStreamErrorEnd {
        error: Vec<u8>,
        error_kind: RpcErrorKind,
    },
    SessionAuthenticate {
        mechanism: String,
        payload: Vec<u8>,
    },
    SessionAuthenticated,
    SessionAuthError {
        code: SessionAuthErrorCode,
        message: String,
    },
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum DatagramMessage {
    Ping { ping_id: u64 },
    Pong { ping_id: u64 },
}

impl ReqResMessage {
    pub fn encode(&self) -> Vec<u8> {
        let (kind, fields) = self.to_parts();
        let mut out = kind.encode();
        out.extend_from_slice(&fields.encode());
        out
    }

    pub fn encode_sequence(messages: &[Self]) -> Vec<u8> {
        let mut out = Vec::new();
        for message in messages {
            out.extend_from_slice(&message.encode());
        }
        out
    }

    pub fn decode(bytes: &[u8]) -> Result<Self, WireError> {
        if bytes.len() > MAX_MESSAGE_SEQUENCE_SIZE {
            return Err(WireError::SequenceTooLarge);
        }
        let mut values = Value::decode_sequence(bytes)?;
        if values.len() != 2 {
            return Err(WireError::IncompleteMessagePair);
        }
        let fields = values.pop().ok_or(WireError::IncompleteMessagePair)?;
        let kind = values.pop().ok_or(WireError::IncompleteMessagePair)?;
        Self::from_parts(kind, fields)
    }

    pub fn decode_sequence(bytes: &[u8]) -> Result<Vec<Self>, WireError> {
        if bytes.len() > MAX_MESSAGE_SEQUENCE_SIZE {
            return Err(WireError::SequenceTooLarge);
        }
        let values = Value::decode_sequence(bytes)?;
        if values.is_empty() {
            return Err(WireError::EmptySequence);
        }
        if values.len() % 2 != 0 {
            return Err(WireError::IncompleteMessagePair);
        }
        let mut messages = Vec::with_capacity(values.len() / 2);
        let mut values = values.into_iter();
        while let Some(kind) = values.next() {
            let fields = values.next().ok_or(WireError::IncompleteMessagePair)?;
            messages.push(Self::from_parts(kind, fields)?);
        }
        Ok(messages)
    }

    pub fn proc_id(&self) -> Option<u64> {
        match self {
            Self::RequestUnary { proc_id, .. } | Self::RequestStreamStart { proc_id, .. } => {
                Some(*proc_id)
            }
            Self::RequestStreamChunk { .. }
            | Self::ResponseUnaryOk { .. }
            | Self::ResponseUnaryError { .. }
            | Self::ResponseStreamStart { .. }
            | Self::ResponseStreamChunk { .. }
            | Self::ResponseStreamErrorEnd { .. }
            | Self::SessionAuthenticate { .. }
            | Self::SessionAuthenticated
            | Self::SessionAuthError { .. } => None,
        }
    }

    pub fn payload(&self) -> Option<&[u8]> {
        match self {
            Self::RequestUnary { payload, .. }
            | Self::RequestStreamStart { payload, .. }
            | Self::ResponseUnaryOk { payload }
            | Self::ResponseStreamStart { payload } => payload.as_deref(),
            Self::RequestStreamChunk { payload }
            | Self::ResponseStreamChunk { payload }
            | Self::SessionAuthenticate { payload, .. } => Some(payload),
            Self::ResponseUnaryError { .. }
            | Self::ResponseStreamErrorEnd { .. }
            | Self::SessionAuthenticated
            | Self::SessionAuthError { .. } => None,
        }
    }

    pub fn error(&self) -> Option<&[u8]> {
        match self {
            Self::ResponseUnaryError { error, .. } | Self::ResponseStreamErrorEnd { error, .. } => {
                Some(error)
            }
            Self::RequestUnary { .. }
            | Self::RequestStreamStart { .. }
            | Self::RequestStreamChunk { .. }
            | Self::ResponseUnaryOk { .. }
            | Self::ResponseStreamStart { .. }
            | Self::ResponseStreamChunk { .. }
            | Self::SessionAuthenticate { .. }
            | Self::SessionAuthenticated
            | Self::SessionAuthError { .. } => None,
        }
    }

    pub fn error_kind(&self) -> Option<RpcErrorKind> {
        match self {
            Self::ResponseUnaryError { error_kind, .. }
            | Self::ResponseStreamErrorEnd { error_kind, .. } => Some(*error_kind),
            Self::RequestUnary { .. }
            | Self::RequestStreamStart { .. }
            | Self::RequestStreamChunk { .. }
            | Self::ResponseUnaryOk { .. }
            | Self::ResponseStreamStart { .. }
            | Self::ResponseStreamChunk { .. }
            | Self::SessionAuthenticate { .. }
            | Self::SessionAuthenticated
            | Self::SessionAuthError { .. } => None,
        }
    }

    pub fn is_rpc_request(&self) -> bool {
        matches!(
            self,
            Self::RequestUnary { .. }
                | Self::RequestStreamStart { .. }
                | Self::RequestStreamChunk { .. }
        )
    }

    pub fn is_rpc_response(&self) -> bool {
        matches!(
            self,
            Self::ResponseUnaryOk { .. }
                | Self::ResponseUnaryError { .. }
                | Self::ResponseStreamStart { .. }
                | Self::ResponseStreamChunk { .. }
                | Self::ResponseStreamErrorEnd { .. }
        )
    }

    pub fn is_session_control(&self) -> bool {
        matches!(
            self,
            Self::SessionAuthenticate { .. }
                | Self::SessionAuthenticated
                | Self::SessionAuthError { .. }
        )
    }

    fn to_parts(&self) -> (Value, Value) {
        match self {
            Self::RequestUnary { proc_id, payload } => message_parts(
                ReqResMessageKind::RequestUnary,
                BTreeMap::from_iter(
                    [(1, Some(Value::U64(*proc_id))), (2, payload_value(payload))]
                        .into_iter()
                        .filter_map(|(field, value)| value.map(|value| (field, value))),
                ),
            ),
            Self::RequestStreamStart { proc_id, payload } => message_parts(
                ReqResMessageKind::RequestStreamStart,
                BTreeMap::from_iter(
                    [(1, Some(Value::U64(*proc_id))), (2, payload_value(payload))]
                        .into_iter()
                        .filter_map(|(field, value)| value.map(|value| (field, value))),
                ),
            ),
            Self::RequestStreamChunk { payload } => message_parts(
                ReqResMessageKind::RequestStreamChunk,
                BTreeMap::from([(2, Value::Bytes(payload.clone()))]),
            ),
            Self::ResponseUnaryOk { payload } => message_parts(
                ReqResMessageKind::ResponseUnaryOk,
                optional_payload_fields(payload),
            ),
            Self::ResponseUnaryError { error, error_kind } => message_parts(
                ReqResMessageKind::ResponseUnaryError,
                BTreeMap::from([
                    (3, Value::Bytes(error.clone())),
                    (4, Value::U64(error_kind.as_u64())),
                ]),
            ),
            Self::ResponseStreamStart { payload } => message_parts(
                ReqResMessageKind::ResponseStreamStart,
                optional_payload_fields(payload),
            ),
            Self::ResponseStreamChunk { payload } => message_parts(
                ReqResMessageKind::ResponseStreamChunk,
                BTreeMap::from([(2, Value::Bytes(payload.clone()))]),
            ),
            Self::ResponseStreamErrorEnd { error, error_kind } => message_parts(
                ReqResMessageKind::ResponseStreamErrorEnd,
                BTreeMap::from([
                    (3, Value::Bytes(error.clone())),
                    (4, Value::U64(error_kind.as_u64())),
                ]),
            ),
            Self::SessionAuthenticate { mechanism, payload } => message_parts(
                ReqResMessageKind::SessionAuthenticate,
                BTreeMap::from([
                    (1, Value::Text(mechanism.clone())),
                    (2, Value::Bytes(payload.clone())),
                ]),
            ),
            Self::SessionAuthenticated => {
                message_parts(ReqResMessageKind::SessionAuthenticated, BTreeMap::new())
            }
            Self::SessionAuthError { code, message } => message_parts(
                ReqResMessageKind::SessionAuthError,
                BTreeMap::from([
                    (1, Value::U64(code.as_u64())),
                    (2, Value::Text(message.clone())),
                ]),
            ),
        }
    }

    fn from_parts(kind_value: Value, fields_value: Value) -> Result<Self, WireError> {
        let Value::U64(variant) = kind_value else {
            return Err(WireError::ExpectedMessageKind);
        };
        let Value::Map(fields) = fields_value else {
            return Err(WireError::ExpectedFieldsMap);
        };
        match ReqResMessageKind::from_u64(variant)
            .ok_or(WireError::UnknownMessageVariant(variant))?
        {
            ReqResMessageKind::RequestUnary => Ok(Self::RequestUnary {
                proc_id: require_u64(&fields, 1)?,
                payload: optional_bytes(&fields, 2)?,
            }),
            ReqResMessageKind::RequestStreamStart => Ok(Self::RequestStreamStart {
                proc_id: require_u64(&fields, 1)?,
                payload: optional_bytes(&fields, 2)?,
            }),
            ReqResMessageKind::RequestStreamChunk => Ok(Self::RequestStreamChunk {
                payload: require_bytes(&fields, 2)?,
            }),
            ReqResMessageKind::ResponseUnaryOk => Ok(Self::ResponseUnaryOk {
                payload: optional_bytes(&fields, 2)?,
            }),
            ReqResMessageKind::ResponseUnaryError => Ok(Self::ResponseUnaryError {
                error: require_bytes(&fields, 3)?,
                error_kind: require_rpc_error_kind(&fields, 4)?,
            }),
            ReqResMessageKind::ResponseStreamStart => Ok(Self::ResponseStreamStart {
                payload: optional_bytes(&fields, 2)?,
            }),
            ReqResMessageKind::ResponseStreamChunk => Ok(Self::ResponseStreamChunk {
                payload: require_bytes(&fields, 2)?,
            }),
            ReqResMessageKind::ResponseStreamErrorEnd => Ok(Self::ResponseStreamErrorEnd {
                error: require_bytes(&fields, 3)?,
                error_kind: require_rpc_error_kind(&fields, 4)?,
            }),
            ReqResMessageKind::SessionAuthenticate => Ok(Self::SessionAuthenticate {
                mechanism: require_text(&fields, 1)?,
                payload: require_bytes(&fields, 2)?,
            }),
            ReqResMessageKind::SessionAuthenticated => Ok(Self::SessionAuthenticated),
            ReqResMessageKind::SessionAuthError => Ok(Self::SessionAuthError {
                code: require_session_auth_error_code(&fields, 1)?,
                message: require_text(&fields, 2)?,
            }),
        }
    }
}

impl DatagramMessage {
    pub fn encode(&self) -> Vec<u8> {
        let (kind, fields) = self.to_parts();
        Value::Array(vec![kind, fields]).encode()
    }

    pub fn decode(bytes: &[u8]) -> Result<Self, WireError> {
        let Value::Array(items) = Value::decode(bytes)? else {
            return Err(WireError::ExpectedDatagramMessage);
        };
        let [kind, fields]: [Value; 2] = items
            .try_into()
            .map_err(|_| WireError::ExpectedDatagramMessage)?;
        Self::from_parts(kind, fields)
    }

    fn to_parts(&self) -> (Value, Value) {
        match self {
            Self::Ping { ping_id } => message_parts(
                DatagramMessageKind::Ping,
                BTreeMap::from([(1, Value::U64(*ping_id))]),
            ),
            Self::Pong { ping_id } => message_parts(
                DatagramMessageKind::Pong,
                BTreeMap::from([(1, Value::U64(*ping_id))]),
            ),
        }
    }

    fn from_parts(kind_value: Value, fields_value: Value) -> Result<Self, WireError> {
        let Value::U64(variant) = kind_value else {
            return Err(WireError::ExpectedMessageKind);
        };
        let Value::Map(fields) = fields_value else {
            return Err(WireError::ExpectedFieldsMap);
        };
        match DatagramMessageKind::from_u64(variant)
            .ok_or(WireError::UnknownDatagramMessageVariant(variant))?
        {
            DatagramMessageKind::Ping => Ok(Self::Ping {
                ping_id: require_u64(&fields, 1)?,
            }),
            DatagramMessageKind::Pong => Ok(Self::Pong {
                ping_id: require_u64(&fields, 1)?,
            }),
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PairedSecretCredential {
    pub credential_id: String,
    pub credential_secret: String,
}

impl PairedSecretCredential {
    pub fn encode(&self) -> Vec<u8> {
        Value::Map(BTreeMap::from([
            (1, Value::Text(self.credential_id.clone())),
            (2, Value::Text(self.credential_secret.clone())),
        ]))
        .encode()
    }

    pub fn decode(bytes: &[u8]) -> Result<Self, WireError> {
        let Value::Map(fields) = Value::decode(bytes)? else {
            return Err(WireError::ExpectedFieldsMap);
        };
        Ok(Self {
            credential_id: require_text(&fields, 1)?,
            credential_secret: require_text(&fields, 2)?,
        })
    }
}

fn message_parts(kind: impl IntoMessageKind, fields: BTreeMap<u64, Value>) -> (Value, Value) {
    (Value::U64(kind.as_u64()), Value::Map(fields))
}

trait IntoMessageKind {
    fn as_u64(self) -> u64;
}

impl IntoMessageKind for ReqResMessageKind {
    fn as_u64(self) -> u64 {
        ReqResMessageKind::as_u64(self)
    }
}

impl IntoMessageKind for DatagramMessageKind {
    fn as_u64(self) -> u64 {
        DatagramMessageKind::as_u64(self)
    }
}

fn optional_payload_fields(payload: &Option<Vec<u8>>) -> BTreeMap<u64, Value> {
    match payload {
        Some(payload) => BTreeMap::from([(2, Value::Bytes(payload.clone()))]),
        None => BTreeMap::new(),
    }
}

fn payload_value(payload: &Option<Vec<u8>>) -> Option<Value> {
    payload
        .as_ref()
        .map(|payload| Value::Bytes(payload.clone()))
}

fn require_u64(map: &BTreeMap<u64, Value>, field: u64) -> Result<u64, WireError> {
    match map.get(&field).ok_or(WireError::MissingField(field))? {
        Value::U64(value) => Ok(*value),
        _ => Err(WireError::WrongFieldType(field)),
    }
}

fn require_rpc_error_kind(
    map: &BTreeMap<u64, Value>,
    field: u64,
) -> Result<RpcErrorKind, WireError> {
    RpcErrorKind::from_u64(require_u64(map, field)?).ok_or(WireError::WrongFieldType(field))
}

fn require_session_auth_error_code(
    map: &BTreeMap<u64, Value>,
    field: u64,
) -> Result<SessionAuthErrorCode, WireError> {
    SessionAuthErrorCode::from_u64(require_u64(map, field)?).ok_or(WireError::WrongFieldType(field))
}

fn require_text(map: &BTreeMap<u64, Value>, field: u64) -> Result<String, WireError> {
    match map.get(&field).ok_or(WireError::MissingField(field))? {
        Value::Text(value) => Ok(value.clone()),
        _ => Err(WireError::WrongFieldType(field)),
    }
}

fn optional_bytes(map: &BTreeMap<u64, Value>, field: u64) -> Result<Option<Vec<u8>>, WireError> {
    match map.get(&field) {
        None => Ok(None),
        Some(Value::Bytes(value)) => Ok(Some(value.clone())),
        Some(_) => Err(WireError::WrongFieldType(field)),
    }
}

fn require_bytes(map: &BTreeMap<u64, Value>, field: u64) -> Result<Vec<u8>, WireError> {
    optional_bytes(map, field)?.ok_or(WireError::MissingField(field))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::rpc::ProcId;

    #[test]
    fn encodes_and_decodes_reqres_message() {
        let message = ReqResMessage::RequestUnary {
            proc_id: ProcId::StartPairing.as_u64(),
            payload: Some(b"hello".to_vec()),
        };
        assert_eq!(ReqResMessage::decode(&message.encode()).unwrap(), message);
    }

    #[test]
    fn decodes_cbor_message_sequence() {
        let first = ReqResMessage::RequestStreamStart {
            proc_id: ProcId::StartPairing.as_u64(),
            payload: None,
        };
        let second = ReqResMessage::RequestStreamChunk {
            payload: b"done".to_vec(),
        };
        let bytes = ReqResMessage::encode_sequence(&[first.clone(), second.clone()]);
        assert_eq!(
            ReqResMessage::decode_sequence(&bytes).unwrap(),
            vec![first, second]
        );
    }

    #[test]
    fn request_unary_vector_is_stable() {
        let message = ReqResMessage::RequestUnary {
            proc_id: ProcId::StartPairing.as_u64(),
            payload: None,
        };
        assert_eq!(
            ReqResMessage::encode_sequence(&[message]),
            vec![0x00, 0xa1, 0x01, 0x01]
        );
    }

    #[test]
    fn session_authenticate_roundtrip() {
        let credential = PairedSecretCredential {
            credential_id: "client".to_string(),
            credential_secret: "secret".to_string(),
        };
        let message = ReqResMessage::SessionAuthenticate {
            mechanism: PAIRED_SECRET_AUTH_MECHANISM.to_string(),
            payload: credential.encode(),
        };
        assert_eq!(ReqResMessage::decode(&message.encode()).unwrap(), message);
    }

    #[test]
    fn datagram_ping_roundtrip() {
        let message = DatagramMessage::Ping { ping_id: 42 };
        assert_eq!(DatagramMessage::decode(&message.encode()).unwrap(), message);
        assert_eq!(message.encode(), vec![0x82, 0x01, 0xa1, 0x01, 0x18, 0x2a]);
    }
}
