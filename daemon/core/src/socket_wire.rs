use crate::cbor::{CborError, Value};
use crate::generated::socket_wire::CodecError;
pub use crate::generated::socket_wire::{
    SocketPairedSecretCredential, SocketReqResMessage, SocketRpcErrorCode, SocketRpcErrorKind,
    SocketRpcErrorPayload, SocketSessionAuthErrorCode,
};

pub const MAX_SOCKET_WIRE_SEQUENCE_SIZE: usize = 64 * 1024 * 1024;

#[derive(Debug, thiserror::Error)]
pub enum SocketWireError {
    #[error("cbor error: {0}")]
    Cbor(#[from] CborError),
    #[error("codec error: {0}")]
    Codec(CodecError),
    #[error("message sequence is empty")]
    EmptySequence,
    #[error("socket-wire reqres sequence ended with an incomplete kind/map pair")]
    IncompleteMessagePair,
    #[error("socket-wire sequence exceeds implementation limit")]
    SequenceTooLarge,
}

impl From<CodecError> for SocketWireError {
    fn from(value: CodecError) -> Self {
        Self::Codec(value)
    }
}

impl SocketReqResMessage {
    pub fn encode(&self) -> Vec<u8> {
        let (kind, fields) = self
            .to_flattened_parts()
            .expect("generated socket reqres message failed to encode");
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

    pub fn decode(bytes: &[u8]) -> Result<Self, SocketWireError> {
        if bytes.len() > MAX_SOCKET_WIRE_SEQUENCE_SIZE {
            return Err(SocketWireError::SequenceTooLarge);
        }
        let mut values = Value::decode_sequence(bytes)?;
        if values.len() != 2 {
            return Err(SocketWireError::IncompleteMessagePair);
        }
        let fields = values.pop().ok_or(SocketWireError::IncompleteMessagePair)?;
        let kind = values.pop().ok_or(SocketWireError::IncompleteMessagePair)?;
        Self::from_flattened_parts(kind, fields)
    }

    pub fn decode_prefix(bytes: &[u8]) -> Result<Option<(Self, usize)>, SocketWireError> {
        if bytes.len() > MAX_SOCKET_WIRE_SEQUENCE_SIZE {
            return Err(SocketWireError::SequenceTooLarge);
        }
        let Some((kind, kind_len)) = Value::decode_prefix(bytes)? else {
            return Ok(None);
        };
        let Some((fields, fields_len)) = Value::decode_prefix(&bytes[kind_len..])? else {
            return Ok(None);
        };
        let message = Self::from_flattened_parts(kind, fields)?;
        Ok(Some((message, kind_len + fields_len)))
    }

    pub fn decode_sequence(bytes: &[u8]) -> Result<Vec<Self>, SocketWireError> {
        if bytes.len() > MAX_SOCKET_WIRE_SEQUENCE_SIZE {
            return Err(SocketWireError::SequenceTooLarge);
        }
        let values = Value::decode_sequence(bytes)?;
        if values.is_empty() {
            return Err(SocketWireError::EmptySequence);
        }
        if values.len() % 2 != 0 {
            return Err(SocketWireError::IncompleteMessagePair);
        }

        let mut messages = Vec::with_capacity(values.len() / 2);
        let mut values = values.into_iter();
        while let Some(kind) = values.next() {
            let fields = values
                .next()
                .ok_or(SocketWireError::IncompleteMessagePair)?;
            messages.push(Self::from_flattened_parts(kind, fields)?);
        }
        Ok(messages)
    }

    pub fn stream_id(&self) -> u64 {
        match self {
            Self::RequestUnary { stream_id, .. }
            | Self::RequestStreamStart { stream_id, .. }
            | Self::RequestStreamChunk { stream_id, .. }
            | Self::ResponseUnaryOk { stream_id, .. }
            | Self::ResponseUnaryError { stream_id, .. }
            | Self::ResponseStreamStart { stream_id, .. }
            | Self::ResponseStreamChunk { stream_id, .. }
            | Self::ResponseStreamErrorEnd { stream_id, .. }
            | Self::SessionAuthenticate { stream_id, .. }
            | Self::SessionAuthenticated { stream_id }
            | Self::SessionAuthError { stream_id, .. }
            | Self::RequestStreamEnd { stream_id }
            | Self::ResponseStreamEnd { stream_id } => *stream_id,
        }
    }

    pub fn proc_id(&self) -> Option<u64> {
        match self {
            Self::RequestUnary { proc_id, .. } | Self::RequestStreamStart { proc_id, .. } => {
                Some(*proc_id)
            }
            _ => None,
        }
    }

    pub fn payload(&self) -> Option<&[u8]> {
        match self {
            Self::RequestUnary { payload, .. }
            | Self::RequestStreamStart { payload, .. }
            | Self::ResponseUnaryOk { payload, .. }
            | Self::ResponseStreamStart { payload, .. } => payload.as_deref(),
            Self::RequestStreamChunk { payload, .. }
            | Self::ResponseStreamChunk { payload, .. }
            | Self::SessionAuthenticate { payload, .. } => Some(payload),
            _ => None,
        }
    }

    pub fn error(&self) -> Option<&[u8]> {
        match self {
            Self::ResponseUnaryError { error, .. } | Self::ResponseStreamErrorEnd { error, .. } => {
                Some(error)
            }
            _ => None,
        }
    }

    pub fn error_kind(&self) -> Option<SocketRpcErrorKind> {
        match self {
            Self::ResponseUnaryError { error_kind, .. }
            | Self::ResponseStreamErrorEnd { error_kind, .. } => Some(*error_kind),
            _ => None,
        }
    }

    fn to_flattened_parts(&self) -> Result<(Value, Value), CodecError> {
        let Value::Array(mut items) = self.encode_value()? else {
            return Err(CodecError::ExpectedArray);
        };
        if items.len() != 2 {
            return Err(CodecError::ExpectedArray);
        }
        let fields = items.pop().ok_or(CodecError::ExpectedArray)?;
        let kind = items.pop().ok_or(CodecError::ExpectedArray)?;
        Ok((kind, fields))
    }

    fn from_flattened_parts(kind: Value, fields: Value) -> Result<Self, SocketWireError> {
        Ok(Self::decode_value(&Value::Array(vec![kind, fields]))?)
    }
}

impl SocketRpcErrorPayload {
    pub fn encode(&self) -> Vec<u8> {
        self.encode_value()
            .expect("generated socket rpc error payload failed to encode")
            .encode()
    }

    pub fn decode(bytes: &[u8]) -> Result<Self, SocketWireError> {
        Ok(Self::decode_value(&Value::decode(bytes)?)?)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn request_unary_vector_has_stream_id_field() {
        let message = SocketReqResMessage::RequestUnary {
            proc_id: 1,
            payload: None,
            stream_id: 7,
        };

        assert_eq!(
            SocketReqResMessage::encode_sequence(&[message]),
            vec![0x00, 0xa2, 0x01, 0x01, 0x18, 0x64, 0x07]
        );
    }

    #[test]
    fn decodes_flattened_cbor_sequence() {
        let messages = vec![
            SocketReqResMessage::RequestUnary {
                proc_id: 1,
                payload: Some(b"hello".to_vec()),
                stream_id: 1,
            },
            SocketReqResMessage::RequestStreamEnd { stream_id: 1 },
        ];
        let bytes = SocketReqResMessage::encode_sequence(&messages);

        assert_eq!(
            SocketReqResMessage::decode_sequence(&bytes).unwrap(),
            messages
        );
    }

    #[test]
    fn decodes_prefix_when_next_message_is_partial() {
        let first = SocketReqResMessage::ResponseUnaryOk {
            payload: None,
            stream_id: 1,
        };
        let second = SocketReqResMessage::ResponseStreamEnd { stream_id: 1 };
        let mut bytes = first.encode();
        bytes.extend_from_slice(&second.encode()[..1]);

        let (decoded, used) = SocketReqResMessage::decode_prefix(&bytes).unwrap().unwrap();
        assert_eq!(decoded, first);
        assert_eq!(used, first.encode().len());
    }
}
