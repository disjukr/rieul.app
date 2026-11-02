use rieul_daemon_core::cbor::Value;
use ring::{
    digest,
    rand::{SecureRandom, SystemRandom},
    signature,
};
use std::{
    collections::HashMap,
    time::{Duration, Instant},
};

macro_rules! identity {
    ($($name:ident),+) => {$(#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
        pub(super) struct $name(pub [u8;32]);)+};
}
identity!(
    ClusterId,
    NodePublicKey,
    ClientPublicKey,
    NodeId,
    Incarnation,
    JoinId,
    ConnectionId,
    Nonce
);
impl NodePublicKey {
    pub(super) fn node_id(self) -> NodeId {
        let bytes = Value::Array(vec![
            Value::Text("rieul.cluster.node-id.v1".into()),
            Value::Bytes(self.0.to_vec()),
        ])
        .encode();
        NodeId(
            digest::digest(&digest::SHA256, &bytes)
                .as_ref()
                .try_into()
                .unwrap(),
        )
    }
}
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(super) enum Subject {
    Node(NodePublicKey),
    Client(ClientPublicKey),
}
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(super) enum Purpose {
    ServerChallenge,
    NodePossession,
    ClientPossession,
}
impl Purpose {
    fn tag(self) -> u64 {
        match self {
            Self::ServerChallenge => 0,
            Self::NodePossession => 1,
            Self::ClientPossession => 2,
        }
    }
}
#[derive(Clone, Debug, PartialEq, Eq)]
pub(super) struct Context {
    pub cluster: ClusterId,
    /// Exact expected origin, supplied by a trusted transport integration.
    pub origin: String,
    pub server: NodePublicKey,
    pub incarnation: Incarnation,
    pub subject: Subject,
    pub connection: ConnectionId,
    /// Digest of the exact purpose-specific request, including origin/audience.
    /// Its authorization meaning is deliberately not defined by this primitive.
    pub request_hash: [u8; 32],
}
#[derive(Clone, Debug, PartialEq, Eq)]
pub(super) struct Challenge {
    pub context: Context,
    pub nonce: Nonce,
}
#[derive(Clone, Debug, PartialEq, Eq)]
pub(super) enum Error {
    InvalidProof,
    UnknownChallenge,
    Expired,
    WrongContext,
    Capacity,
    InvalidLifetime,
    Random,
}
impl Challenge {
    pub(super) fn canonical(&self, purpose: Purpose) -> Vec<u8> {
        let c = &self.context;
        let (role, key) = match c.subject {
            Subject::Node(k) => (0, k.0),
            Subject::Client(k) => (1, k.0),
        };
        Value::Array(vec![
            Value::Text("rieul.cluster.proof.v1".into()),
            Value::U64(purpose.tag()),
            Value::Bytes(c.cluster.0.to_vec()),
            Value::Bytes(c.server.0.to_vec()),
            Value::Bytes(c.incarnation.0.to_vec()),
            Value::U64(role),
            Value::Bytes(key.to_vec()),
            Value::Bytes(c.connection.0.to_vec()),
            Value::Bytes(self.nonce.0.to_vec()),
            Value::Bytes(c.request_hash.to_vec()),
            Value::Text(c.origin.clone()),
        ])
        .encode()
    }
    /// Expected context/key comes from the caller, never from an unauthenticated
    /// payload. Equality rejects alternate encodings/extra fields without parsing
    /// attacker-controlled CBOR lengths. This is not a membership verifier.
    pub(super) fn verify(
        &self,
        purpose: Purpose,
        encoded: &[u8],
        proof: &[u8],
    ) -> Result<(), Error> {
        let key = match (purpose, self.context.subject) {
            (Purpose::ServerChallenge, _) => self.context.server.0,
            (Purpose::NodePossession, Subject::Node(key)) => key.0,
            (Purpose::ClientPossession, Subject::Client(key)) => key.0,
            _ => return Err(Error::InvalidProof),
        };
        if self.context.origin.is_empty()
            || self.context.origin.len() > 2048
            || proof.len() != 64
            || encoded != self.canonical(purpose)
        {
            return Err(Error::InvalidProof);
        }
        signature::UnparsedPublicKey::new(&signature::ED25519, key)
            .verify(encoded, proof)
            .map_err(|_| Error::InvalidProof)
    }
}
struct Pending {
    challenge: Challenge,
    purpose: Purpose,
    deadline: Instant,
}
pub(super) struct Challenges {
    pending: HashMap<Nonce, Pending>,
    capacity: usize,
}
impl Challenges {
    pub(super) fn new(capacity: usize) -> Self {
        Self {
            pending: HashMap::new(),
            capacity: capacity.min(256),
        }
    }
    pub(super) fn issue(
        &mut self,
        context: Context,
        purpose: Purpose,
        now: Instant,
        ttl: Duration,
    ) -> Result<Challenge, Error> {
        if context.origin.is_empty() || context.origin.len() > 2048 {
            return Err(Error::WrongContext);
        }
        if ttl.is_zero() || ttl > Duration::from_secs(60) {
            return Err(Error::InvalidLifetime);
        }
        match (purpose, context.subject) {
            (Purpose::NodePossession, Subject::Node(_))
            | (Purpose::ClientPossession, Subject::Client(_)) => {}
            _ => return Err(Error::WrongContext),
        }
        self.pending.retain(|_, pending| pending.deadline > now);
        if self.pending.len() >= self.capacity {
            return Err(Error::Capacity);
        }
        let mut bytes = [0; 32];
        SystemRandom::new()
            .fill(&mut bytes)
            .map_err(|_| Error::Random)?;
        let nonce = Nonce(bytes);
        if self.pending.contains_key(&nonce) {
            return Err(Error::Random);
        }
        let challenge = Challenge { context, nonce };
        self.pending.insert(
            nonce,
            Pending {
                challenge: challenge.clone(),
                purpose,
                deadline: now.checked_add(ttl).ok_or(Error::InvalidLifetime)?,
            },
        );
        Ok(challenge)
    }
    /// Caller serializes this mutable operation per transport/session owner.
    pub(super) fn consume(
        &mut self,
        context: &Context,
        nonce: Nonce,
        purpose: Purpose,
        encoded: &[u8],
        proof: &[u8],
        now: Instant,
    ) -> Result<(), Error> {
        let pending = self.pending.get(&nonce).ok_or(Error::UnknownChallenge)?;
        if pending.deadline <= now {
            self.pending.remove(&nonce);
            return Err(Error::Expired);
        }
        if pending.challenge.context != *context || pending.purpose != purpose {
            return Err(Error::WrongContext);
        }
        pending.challenge.verify(purpose, encoded, proof)?;
        self.pending.remove(&nonce);
        Ok(())
    }
    pub(super) fn disconnect(&mut self, connection: ConnectionId) {
        self.pending
            .retain(|_, pending| pending.challenge.context.connection != connection);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use ring::signature::{Ed25519KeyPair, KeyPair};
    fn pair(seed: u8) -> Ed25519KeyPair {
        Ed25519KeyPair::from_seed_unchecked(&[seed; 32]).unwrap()
    }
    fn context() -> Context {
        Context {
            cluster: ClusterId([1; 32]),
            origin: "https://fixture.invalid".into(),
            server: NodePublicKey(pair(2).public_key().as_ref().try_into().unwrap()),
            incarnation: Incarnation([3; 32]),
            subject: Subject::Client(ClientPublicKey(
                pair(4).public_key().as_ref().try_into().unwrap(),
            )),
            connection: ConnectionId([5; 32]),
            request_hash: [6; 32],
        }
    }
    #[test]
    fn canonical_transcript_matches_fixed_golden_vector() {
        let challenge = Challenge {
            context: Context {
                cluster: ClusterId([1; 32]),
                origin: "https://fixture.invalid".into(),
                server: NodePublicKey([2; 32]),
                incarnation: Incarnation([3; 32]),
                subject: Subject::Client(ClientPublicKey([4; 32])),
                connection: ConnectionId([5; 32]),
                request_hash: [6; 32],
            },
            nonce: Nonce([7; 32]),
        };
        // Independently specified CBOR bytes, not a decode/reencode roundtrip.
        let expected = concat!(
            "8b76726965756c2e636c75737465722e70726f6f662e76310258200101010101",
            "0101010101010101010101010101010101010101010101010101015820020202",
            "0202020202020202020202020202020202020202020202020202020202582003",
            "0303030303030303030303030303030303030303030303030303030303030301",
            "5820040404040404040404040404040404040404040404040404040404040404",
            "0404582005050505050505050505050505050505050505050505050505050505",
            "0505050558200707070707070707070707070707070707070707070707070707",
            "0707070707075820060606060606060606060606060606060606060606060606",
            "06060606060606067768747470733a2f2f666978747572652e696e76616c6964",
        );
        let actual: String = challenge
            .canonical(Purpose::ClientPossession)
            .iter()
            .map(|byte| format!("{byte:02x}"))
            .collect();
        assert_eq!(actual, expected);
    }
    #[test]
    fn signatures_bind_every_field_role_purpose_and_exact_encoding() {
        let challenge = Challenge {
            context: context(),
            nonce: Nonce([7; 32]),
        };
        let bytes = challenge.canonical(Purpose::ClientPossession);
        let proof = pair(4).sign(&bytes);
        challenge
            .verify(Purpose::ClientPossession, &bytes, proof.as_ref())
            .unwrap();
        assert_eq!(Value::decode(&bytes).unwrap().encode(), bytes);
        for field in 0..9 {
            let mut altered = challenge.clone();
            match field {
                0 => altered.context.cluster.0[0] ^= 1,
                1 => altered.context.server.0[0] ^= 1,
                2 => altered.context.incarnation.0[0] ^= 1,
                3 => {
                    altered.context.subject = Subject::Client(ClientPublicKey(
                        pair(8).public_key().as_ref().try_into().unwrap(),
                    ))
                }
                4 => altered.context.connection.0[0] ^= 1,
                5 => altered.context.request_hash[0] ^= 1,
                6 => altered.nonce.0[0] ^= 1,
                7 => altered.context.origin.push_str(".other"),
                _ => {
                    altered.context.subject = Subject::Node(NodePublicKey(
                        pair(4).public_key().as_ref().try_into().unwrap(),
                    ))
                }
            }
            assert!(
                altered
                    .verify(
                        Purpose::ClientPossession,
                        &altered.canonical(Purpose::ClientPossession),
                        proof.as_ref()
                    )
                    .is_err()
            );
        }
        assert!(
            challenge
                .verify(Purpose::ServerChallenge, &bytes, proof.as_ref())
                .is_err()
        );
        assert!(
            challenge
                .verify(Purpose::ClientPossession, &bytes, &proof.as_ref()[..63])
                .is_err()
        );
        let mut extra = bytes.clone();
        extra.push(0);
        assert!(
            challenge
                .verify(Purpose::ClientPossession, &extra, proof.as_ref())
                .is_err()
        );
        let mut noncanonical = bytes.clone();
        noncanonical.splice(0..1, [0x98, 11]);
        assert!(
            challenge
                .verify(
                    Purpose::ClientPossession,
                    &noncanonical,
                    pair(4).sign(&noncanonical).as_ref()
                )
                .is_err()
        );
        let server_bytes = challenge.canonical(Purpose::ServerChallenge);
        challenge
            .verify(
                Purpose::ServerChallenge,
                &server_bytes,
                pair(2).sign(&server_bytes).as_ref(),
            )
            .unwrap();
        assert_ne!(
            challenge.context.server.node_id(),
            NodePublicKey([0; 32]).node_id()
        );
    }
    #[test]
    fn node_proofs_are_distinct_from_client_proofs_with_the_same_key_bytes() {
        let mut context = context();
        context.subject = Subject::Node(NodePublicKey(
            pair(4).public_key().as_ref().try_into().unwrap(),
        ));
        let challenge = Challenge {
            context,
            nonce: Nonce([9; 32]),
        };
        let bytes = challenge.canonical(Purpose::NodePossession);
        challenge
            .verify(
                Purpose::NodePossession,
                &bytes,
                pair(4).sign(&bytes).as_ref(),
            )
            .unwrap();
        assert!(
            challenge
                .verify(
                    Purpose::ClientPossession,
                    &bytes,
                    pair(4).sign(&bytes).as_ref()
                )
                .is_err()
        );
    }
    #[test]
    fn challenges_are_bounded_expire_and_do_not_survive_disconnect_or_restart() {
        let now = Instant::now();
        let mut cache = Challenges::new(1);
        let c = context();
        let first = cache
            .issue(
                c.clone(),
                Purpose::ClientPossession,
                now,
                Duration::from_secs(1),
            )
            .unwrap();
        assert_eq!(
            cache.issue(
                c.clone(),
                Purpose::ClientPossession,
                now,
                Duration::from_secs(1)
            ),
            Err(Error::Capacity)
        );
        let bytes = first.canonical(Purpose::ClientPossession);
        let proof = pair(4).sign(&bytes);
        let mut wrong = c.clone();
        wrong.connection.0[0] ^= 1;
        assert_eq!(
            cache.consume(
                &wrong,
                first.nonce,
                Purpose::ClientPossession,
                &bytes,
                proof.as_ref(),
                now
            ),
            Err(Error::WrongContext)
        );
        assert_eq!(
            cache.consume(
                &c,
                first.nonce,
                Purpose::ClientPossession,
                &bytes,
                proof.as_ref(),
                now + Duration::from_secs(1)
            ),
            Err(Error::Expired)
        );
        let next = cache
            .issue(
                c.clone(),
                Purpose::ClientPossession,
                now + Duration::from_secs(1),
                Duration::from_secs(1),
            )
            .unwrap();
        assert_ne!(first.nonce, next.nonce);
        cache.disconnect(c.connection);
        assert_eq!(
            cache.consume(
                &c,
                next.nonce,
                Purpose::ClientPossession,
                &bytes,
                proof.as_ref(),
                now
            ),
            Err(Error::UnknownChallenge)
        );
        assert_eq!(
            Challenges::new(1).consume(
                &c,
                first.nonce,
                Purpose::ClientPossession,
                &bytes,
                proof.as_ref(),
                now
            ),
            Err(Error::UnknownChallenge)
        );
    }
    #[test]
    fn failed_proofs_do_not_consume_valid_challenges_and_invalid_lifetimes_fail() {
        let now = Instant::now();
        let mut cache = Challenges::new(1);
        let c = context();
        for ttl in [Duration::ZERO, Duration::from_secs(61)] {
            assert_eq!(
                cache.issue(c.clone(), Purpose::ClientPossession, now, ttl),
                Err(Error::InvalidLifetime)
            );
        }
        let mut invalid = c.clone();
        invalid.origin.clear();
        assert_eq!(
            cache.issue(
                invalid,
                Purpose::ClientPossession,
                now,
                Duration::from_secs(1)
            ),
            Err(Error::WrongContext)
        );
        let challenge = cache
            .issue(
                c.clone(),
                Purpose::ClientPossession,
                now,
                Duration::from_secs(1),
            )
            .unwrap();
        let bytes = challenge.canonical(Purpose::ClientPossession);
        assert_eq!(
            cache.consume(
                &c,
                challenge.nonce,
                Purpose::ClientPossession,
                &bytes,
                &[0; 64],
                now
            ),
            Err(Error::InvalidProof)
        );
        assert_eq!(
            cache.consume(
                &c,
                challenge.nonce,
                Purpose::NodePossession,
                &bytes,
                pair(4).sign(&bytes).as_ref(),
                now
            ),
            Err(Error::WrongContext)
        );
        cache
            .consume(
                &c,
                challenge.nonce,
                Purpose::ClientPossession,
                &bytes,
                pair(4).sign(&bytes).as_ref(),
                now,
            )
            .unwrap();
        assert!(
            cache
                .issue(c, Purpose::ClientPossession, now, Duration::from_secs(1))
                .is_ok()
        );
    }
    #[test]
    fn simultaneous_replay_has_exactly_one_success() {
        let now = Instant::now();
        let mut cache = Challenges::new(1);
        let c = context();
        let challenge = cache
            .issue(
                c.clone(),
                Purpose::ClientPossession,
                now,
                Duration::from_secs(10),
            )
            .unwrap();
        let bytes = challenge.canonical(Purpose::ClientPossession);
        let proof: Vec<u8> = pair(4).sign(&bytes).as_ref().into();
        let cache = std::sync::Arc::new(std::sync::Mutex::new(cache));
        let results = std::thread::scope(|scope| {
            let tasks: Vec<_> = (0..2)
                .map(|_| {
                    scope.spawn(|| {
                        cache.lock().unwrap().consume(
                            &c,
                            challenge.nonce,
                            Purpose::ClientPossession,
                            &bytes,
                            &proof,
                            now,
                        )
                    })
                })
                .collect();
            tasks
                .into_iter()
                .map(|task| task.join().unwrap())
                .collect::<Vec<_>>()
        });
        assert_eq!(results.iter().filter(|r| r.is_ok()).count(), 1);
        assert_eq!(
            results
                .iter()
                .filter(|r| **r == Err(Error::UnknownChallenge))
                .count(),
            1
        );
    }
}
