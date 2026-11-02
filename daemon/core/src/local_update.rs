//! Local updater framing shared by the GUI's inherited pipe and authenticated
//! system-helper socket. One socket-wire message per big-endian length frame.
use crate::{generated::ipc::ProcId, socket_wire::SocketReqResMessage as Message};
pub const MAX_FRAME: usize = 64 * 1024;
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Operation {
    Subscribe,
    Check,
    Install,
    Restart,
}
impl Operation {
    pub fn id(self) -> u64 {
        match self {
            Self::Subscribe => ProcId::SubscribeLocalUpdateStatus,
            Self::Check => ProcId::CheckLocalUpdates,
            Self::Install => ProcId::InstallLocalUpdateConfirmed,
            Self::Restart => ProcId::RestartLocalDaemonConfirmed,
        }
        .as_u64()
    }
    pub fn request(self) -> Message {
        Message::RequestUnary {
            stream_id: 1,
            proc_id: self.id(),
            payload: None,
        }
    }
    pub fn parse(message: Message) -> Option<Self> {
        match message {
            Message::RequestUnary {
                stream_id: 1,
                proc_id,
                payload: None,
            } => [Self::Subscribe, Self::Check, Self::Install, Self::Restart]
                .into_iter()
                .find(|op| op.id() == proc_id),
            _ => None,
        }
    }
}
pub fn encode(message: &Message) -> Option<Vec<u8>> {
    let bytes = Message::encode_sequence(&[message.clone()]);
    if bytes.is_empty() || bytes.len() > MAX_FRAME {
        return None;
    }
    let mut frame = (bytes.len() as u32).to_be_bytes().to_vec();
    frame.extend(bytes);
    Some(frame)
}
pub fn decode(bytes: &[u8]) -> Option<Message> {
    if bytes.is_empty() || bytes.len() > MAX_FRAME {
        return None;
    }
    let mut messages = Message::decode_sequence(bytes).ok()?;
    if messages.len() != 1 {
        return None;
    }
    Some(messages.remove(0))
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn local_profile_has_only_fixed_void_operations_and_one_stream() {
        for operation in [
            Operation::Subscribe,
            Operation::Check,
            Operation::Install,
            Operation::Restart,
        ] {
            let frame = encode(&operation.request()).unwrap();
            assert_eq!(
                Operation::parse(decode(&frame[4..]).unwrap()),
                Some(operation)
            );
        }
        for message in [
            Message::RequestUnary {
                stream_id: 2,
                proc_id: Operation::Install.id(),
                payload: None,
            },
            Message::RequestUnary {
                stream_id: 1,
                proc_id: Operation::Install.id(),
                payload: Some(vec![0]),
            },
            Message::RequestUnary {
                stream_id: 1,
                proc_id: 99,
                payload: None,
            },
        ] {
            assert!(Operation::parse(message).is_none());
        }
        let request = Operation::Check.request();
        assert!(decode(&Message::encode_sequence(&[request.clone(), request])).is_none());
        assert!(decode(&vec![0; MAX_FRAME + 1]).is_none());
    }
}
