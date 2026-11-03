//! Durable primary journal; callers must authenticate before invoking operations.
//! Target consent is verified by the runtime before journal admission.
pub mod runtime;
use rieul_daemon_core::cbor::Value;
use ring::{
    digest,
    signature::{self, Ed25519KeyPair, KeyPair},
};
use rusqlite::{params, Connection, OptionalExtension, Transaction, TransactionBehavior};
use std::{
    collections::{BTreeMap, BTreeSet},
    path::Path,
    time::Duration,
};
type Id = [u8; 32];
const MAX_HISTORY: usize = 512;
const MAX_COUNTER: u64 = (1 << 53) - 1;
fn hash(bytes: &[u8]) -> Id {
    digest::digest(&digest::SHA256, bytes)
        .as_ref()
        .try_into()
        .unwrap()
}
fn b(bytes: impl AsRef<[u8]>) -> Value {
    Value::Bytes(bytes.as_ref().to_vec())
}
fn key(pair: &Ed25519KeyPair) -> Id {
    pair.public_key().as_ref().try_into().unwrap()
}
#[derive(Clone, Debug, PartialEq, Eq)]
struct Genesis {
    nonce: Id,
    root: Id,
    root_key: Id,
    root_endpoint: String,
}
impl Genesis {
    fn cluster(&self) -> Id {
        hash(
            &Value::Array(vec![
                Value::Text("rieul.cluster.genesis.v1".into()),
                b(self.nonce),
                b(self.root),
                b(self.root_key),
                Value::Text(self.root_endpoint.clone()),
            ])
            .encode(),
        )
    }
}
#[derive(Clone, Debug, PartialEq, Eq)]
enum Mutation {
    Admit {
        id: Id,
        key: Id,
        consent: Id,
        endpoint: String,
    },
    Remove {
        id: Id,
    },
    Adopt {
        grant: Id,
        issuer: Id,
        client: Id,
        expires: u64,
        client_proof: [u8; 64],
        issuer_proof: [u8; 64],
    },
    Revoke {
        grant: Id,
    },
    Transfer {
        id: Id,
        key: Id,
        prefix_sequence: u64,
        prefix_hash: Id,
        acceptance: [u8; 64],
    },
}
impl Mutation {
    fn values(&self) -> Value {
        Value::Array(match self {
            Self::Admit {
                id,
                key,
                consent,
                endpoint,
            } => vec![
                Value::U64(0),
                b(id),
                b(key),
                b(consent),
                Value::Text(endpoint.clone()),
            ],
            Self::Remove { id } => vec![Value::U64(1), b(id)],
            Self::Adopt {
                grant,
                issuer,
                client,
                expires,
                client_proof,
                issuer_proof,
            } => vec![
                Value::U64(3),
                b(grant),
                b(issuer),
                b(client),
                Value::U64(*expires),
                b(client_proof),
                b(issuer_proof),
            ],
            Self::Revoke { grant } => vec![Value::U64(4), b(grant)],
            Self::Transfer {
                id,
                key,
                prefix_sequence,
                prefix_hash,
                acceptance,
            } => vec![
                Value::U64(2),
                b(id),
                b(key),
                Value::U64(*prefix_sequence),
                b(prefix_hash),
                b(acceptance),
            ],
        })
    }
    // Fixed-size fixture storage codec; no general untrusted CBOR decoder.
    fn storage(&self) -> Vec<u8> {
        match self {
            Self::Admit {
                id,
                key,
                consent,
                endpoint,
            } => [
                &[0][..],
                &id[..],
                &key[..],
                &consent[..],
                endpoint.as_bytes(),
            ]
            .concat(),
            Self::Remove { id } => [&[1][..], &id[..]].concat(),
            Self::Adopt {
                grant,
                issuer,
                client,
                expires,
                client_proof,
                issuer_proof,
            } => [
                &[3][..],
                &grant[..],
                &issuer[..],
                &client[..],
                &expires.to_be_bytes()[..],
                &client_proof[..],
                &issuer_proof[..],
            ]
            .concat(),
            Self::Revoke { grant } => [&[4][..], &grant[..]].concat(),
            Self::Transfer {
                id,
                key,
                prefix_sequence,
                prefix_hash,
                acceptance,
            } => [
                &[2][..],
                &id[..],
                &key[..],
                &prefix_sequence.to_be_bytes()[..],
                &prefix_hash[..],
                &acceptance[..],
            ]
            .concat(),
        }
    }
    fn load(bytes: &[u8]) -> Result<Self, Error> {
        match (bytes.first(), bytes.len()) {
            (Some(0), 98..=2145) => Ok(Self::Admit {
                id: bytes[1..33].try_into().unwrap(),
                key: bytes[33..65].try_into().unwrap(),
                consent: bytes[65..97].try_into().unwrap(),
                endpoint: std::str::from_utf8(&bytes[97..])
                    .map_err(|_| Error::Invalid)?
                    .to_owned(),
            }),
            (Some(1), 33) => Ok(Self::Remove {
                id: bytes[1..33].try_into().unwrap(),
            }),
            (Some(2), 169) => Ok(Self::Transfer {
                id: bytes[1..33].try_into().unwrap(),
                key: bytes[33..65].try_into().unwrap(),
                prefix_sequence: u64::from_be_bytes(bytes[65..73].try_into().unwrap()),
                prefix_hash: bytes[73..105].try_into().unwrap(),
                acceptance: bytes[105..169].try_into().unwrap(),
            }),
            (Some(3), 233) => Ok(Self::Adopt {
                grant: bytes[1..33].try_into().unwrap(),
                issuer: bytes[33..65].try_into().unwrap(),
                client: bytes[65..97].try_into().unwrap(),
                expires: u64::from_be_bytes(bytes[97..105].try_into().unwrap()),
                client_proof: bytes[105..169].try_into().unwrap(),
                issuer_proof: bytes[169..233].try_into().unwrap(),
            }),
            (Some(4), 33) => Ok(Self::Revoke {
                grant: bytes[1..33].try_into().unwrap(),
            }),
            _ => Err(Error::Invalid),
        }
    }
}
#[derive(Clone, Debug, PartialEq, Eq)]
struct Entry {
    cluster: Id,
    epoch: u64,
    sequence: u64,
    previous: Id,
    operation: Id,
    request: Id,
    mutation: Mutation,
    signature: [u8; 64],
}
fn request_hash(cluster: Id, epoch: u64, operation: Id, mutation: &Mutation) -> Id {
    hash(
        &Value::Array(vec![
            Value::Text("rieul.cluster.management-request.v1".into()),
            b(cluster),
            Value::U64(epoch),
            b(operation),
            mutation.values(),
        ])
        .encode(),
    )
}
impl Entry {
    fn body(&self) -> Vec<u8> {
        Value::Array(vec![
            Value::Text("rieul.cluster.management.v1".into()),
            b(self.cluster),
            Value::U64(self.epoch),
            Value::U64(self.sequence),
            b(self.previous),
            b(self.operation),
            b(self.request),
            self.mutation.values(),
        ])
        .encode()
    }
    fn hash(&self) -> Id {
        hash(&Value::Array(vec![b(self.body()), b(self.signature)]).encode())
    }
}
fn validate_endpoint(endpoint: &str) -> Result<(), Error> {
    if endpoint.len() > 2048 {
        return Err(Error::Limit);
    }
    let url = url::Url::parse(endpoint).map_err(|_| Error::Invalid)?;
    if url.scheme() != "https"
        || url.host_str().is_none()
        || !url.username().is_empty()
        || url.password().is_some()
        || url.fragment().is_some()
        || url.query().is_some()
        || url.path() != "/rieul/rpc"
    {
        return Err(Error::Invalid);
    }
    Ok(())
}
fn acceptance_body(
    cluster: Id,
    epoch: u64,
    operation: Id,
    target: Id,
    target_key: Id,
    prefix_sequence: u64,
    prefix_hash: Id,
) -> Vec<u8> {
    Value::Array(vec![
        Value::Text("rieul.cluster.transfer-acceptance.v1".into()),
        b(cluster),
        Value::U64(epoch),
        Value::U64(epoch + 1),
        b(operation),
        b(target),
        b(target_key),
        Value::U64(prefix_sequence),
        b(prefix_hash),
    ])
    .encode()
}
fn client_adoption_body(cluster: Id, grant: Id, issuer: Id, client: Id, expires: u64) -> Vec<u8> {
    Value::Array(vec![
        Value::Text("rieul.cluster.client-possession.v1".into()),
        b(cluster),
        b(grant),
        b(issuer),
        b(client),
        Value::U64(expires),
    ])
    .encode()
}
fn issuer_adoption_body(
    cluster: Id,
    grant: Id,
    issuer: Id,
    client: Id,
    expires: u64,
    client_proof: &[u8; 64],
) -> Vec<u8> {
    Value::Array(vec![
        Value::Text("rieul.cluster.pairing-adoption.v1".into()),
        b(client_adoption_body(
            cluster, grant, issuer, client, expires,
        )),
        b(client_proof),
    ])
    .encode()
}
#[derive(Clone, Debug, PartialEq, Eq)]
struct Grant {
    client: Id,
    expires: u64,
}
fn verify(public: Id, body: &[u8], sig: &[u8]) -> Result<(), Error> {
    signature::UnparsedPublicKey::new(&signature::ED25519, public)
        .verify(body, sig)
        .map_err(|_| Error::Invalid)
}
#[derive(Debug)]
enum Error {
    Database(rusqlite::Error),
    Invalid,
    Conflict,
    NotPrimary,
    Unprepared,
    Exhausted,
    Limit,
}
impl From<rusqlite::Error> for Error {
    fn from(e: rusqlite::Error) -> Self {
        Self::Database(e)
    }
}
#[derive(Clone, Debug, PartialEq, Eq)]
struct State {
    cluster: Id,
    epoch: u64,
    sequence: u64,
    head: Id,
    primary: Id,
    members: BTreeMap<Id, Id>,
    endpoints: BTreeMap<Id, String>,
    seen: BTreeSet<Id>,
    operations: BTreeSet<Id>,
    grants: BTreeMap<Id, Grant>,
    revoked: BTreeSet<Id>,
}
impl State {
    fn genesis(g: &Genesis) -> Self {
        Self {
            cluster: g.cluster(),
            epoch: 1,
            sequence: 0,
            head: g.cluster(),
            primary: g.root,
            members: BTreeMap::from([(g.root, g.root_key)]),
            endpoints: BTreeMap::from([(g.root, g.root_endpoint.clone())]),
            seen: BTreeSet::from([g.root]),
            operations: BTreeSet::new(),
            grants: BTreeMap::new(),
            revoked: BTreeSet::new(),
        }
    }
    fn apply(&mut self, e: &Entry) -> Result<(), Error> {
        if e.cluster != self.cluster
            || e.epoch != self.epoch
            || e.sequence != self.sequence.checked_add(1).ok_or(Error::Exhausted)?
            || e.sequence > MAX_COUNTER
            || e.previous != self.head
            || self.operations.contains(&e.operation)
            || e.request != request_hash(e.cluster, e.epoch, e.operation, &e.mutation)
        {
            return Err(Error::Invalid);
        }
        let primary_key = *self.members.get(&self.primary).ok_or(Error::Invalid)?;
        verify(primary_key, &e.body(), &e.signature)?;
        match &e.mutation {
            Mutation::Admit {
                id, key, endpoint, ..
            } => {
                validate_endpoint(endpoint)?;
                if self.seen.contains(id) || self.members.values().any(|k| k == key) {
                    return Err(Error::Invalid);
                }
                self.members.insert(*id, *key);
                self.endpoints.insert(*id, endpoint.clone());
                self.seen.insert(*id);
            }
            Mutation::Remove { id } => {
                if *id == self.primary {
                    return Err(Error::Invalid);
                }
                self.members.remove(id);
                self.endpoints.remove(id);
                self.seen.insert(*id);
            }
            Mutation::Adopt {
                grant,
                issuer,
                client,
                expires,
                client_proof,
                issuer_proof,
            } => {
                let issuer_key = *self.members.get(issuer).ok_or(Error::Invalid)?;
                if self.grants.contains_key(grant)
                    || self.revoked.contains(grant)
                    || *expires > MAX_COUNTER
                {
                    return Err(Error::Invalid);
                }
                verify(
                    *client,
                    &client_adoption_body(self.cluster, *grant, *issuer, *client, *expires),
                    client_proof,
                )?;
                verify(
                    issuer_key,
                    &issuer_adoption_body(
                        self.cluster,
                        *grant,
                        *issuer,
                        *client,
                        *expires,
                        client_proof,
                    ),
                    issuer_proof,
                )?;
                self.grants.insert(
                    *grant,
                    Grant {
                        client: *client,
                        expires: *expires,
                    },
                );
            }
            Mutation::Revoke { grant } => {
                self.revoked.insert(*grant);
                self.grants.remove(grant);
            }
            Mutation::Transfer {
                id,
                key,
                prefix_sequence,
                prefix_hash,
                acceptance,
            } => {
                if *id == self.primary
                    || self.members.get(id) != Some(key)
                    || self.epoch >= MAX_COUNTER
                    || *prefix_sequence != self.sequence
                    || *prefix_hash != self.head
                {
                    return Err(Error::Invalid);
                }
                verify(
                    *key,
                    &acceptance_body(
                        self.cluster,
                        self.epoch,
                        e.operation,
                        *id,
                        *key,
                        *prefix_sequence,
                        *prefix_hash,
                    ),
                    acceptance,
                )?;
                self.primary = *id;
                self.epoch += 1;
            }
        }
        self.sequence = e.sequence;
        self.head = e.hash();
        self.operations.insert(e.operation);
        Ok(())
    }
}
struct Store {
    db: Connection,
    genesis: Genesis,
    local: Id,
}
impl Store {
    fn open(path: &Path, g: Genesis, local: Id) -> Result<Self, Error> {
        let db = Connection::open(path)?;
        db.busy_timeout(Duration::from_secs(5))?;
        db.execute_batch("PRAGMA synchronous=FULL;
            CREATE TABLE IF NOT EXISTS identity(id INTEGER PRIMARY KEY CHECK(id=1),cluster BLOB NOT NULL,local BLOB NOT NULL,sealed INTEGER NOT NULL);
            CREATE TABLE IF NOT EXISTS log(sequence INTEGER PRIMARY KEY,epoch INTEGER NOT NULL,previous BLOB NOT NULL,operation BLOB UNIQUE NOT NULL,request BLOB NOT NULL,payload BLOB NOT NULL,signature BLOB NOT NULL);
            CREATE TABLE IF NOT EXISTS prepared(operation BLOB PRIMARY KEY,epoch INTEGER NOT NULL,target BLOB NOT NULL,acceptance BLOB NOT NULL,prefix_sequence INTEGER NOT NULL,prefix_hash BLOB NOT NULL);")?;
        db.execute(
            "INSERT OR IGNORE INTO identity VALUES(1,?1,?2,0)",
            params![g.cluster(), local],
        )?;
        let identity: (Vec<u8>, Vec<u8>) =
            db.query_row("SELECT cluster,local FROM identity WHERE id=1", [], |r| {
                Ok((r.get(0)?, r.get(1)?))
            })?;
        if identity.0 != g.cluster() || identity.1 != local {
            return Err(Error::Invalid);
        }
        let store = Self {
            db,
            genesis: g,
            local,
        };
        store.state()?;
        Ok(store)
    }
    fn entries(&self) -> Result<Vec<Entry>, Error> {
        load(&self.db, self.genesis.cluster())
    }
    fn state(&self) -> Result<State, Error> {
        replay(&self.genesis, &self.entries()?)
    }
    fn commit(
        &mut self,
        pair: &Ed25519KeyPair,
        epoch: u64,
        operation: Id,
        mutation: Mutation,
    ) -> Result<Entry, Error> {
        let tx = self
            .db
            .transaction_with_behavior(TransactionBehavior::Immediate)?;
        let result = append(
            &tx,
            &self.genesis,
            self.local,
            pair,
            epoch,
            operation,
            mutation,
        )?;
        tx.commit()?;
        Ok(result) // Only this boundary exposes the signed response.
    }
    #[cfg(test)]
    fn prepare_transfer(
        &mut self,
        pair: &Ed25519KeyPair,
        operation: Id,
    ) -> Result<Mutation, Error> {
        let tx = self
            .db
            .transaction_with_behavior(TransactionBehavior::Immediate)?;
        let result = prepare(&tx, &self.genesis, self.local, pair, operation)?;
        tx.commit()?;
        Ok(result)
    }
    // Complete-history fixture synchronization; no network parser or compaction.
    // Never replace a local prefix with a remote snapshot.
    #[cfg(test)]
    fn install_history(&mut self, entries: &[Entry]) -> Result<(), Error> {
        let tx = self
            .db
            .transaction_with_behavior(TransactionBehavior::Immediate)?;
        install(&tx, &self.genesis, self.local, entries)?;
        tx.commit()?;
        Ok(())
    }
}
fn check_identity(db: &Connection, g: &Genesis, local: Id) -> Result<(), Error> {
    let identity: (Vec<u8>, Vec<u8>) =
        db.query_row("SELECT cluster,local FROM identity WHERE id=1", [], |r| {
            Ok((r.get(0)?, r.get(1)?))
        })?;
    if identity.0 != g.cluster() || identity.1 != local {
        return Err(Error::Invalid);
    }
    Ok(())
}
fn prepare(
    tx: &Transaction<'_>,
    g: &Genesis,
    local: Id,
    pair: &Ed25519KeyPair,
    operation: Id,
) -> Result<Mutation, Error> {
    check_identity(tx, g, local)?;
    if key(pair) != local {
        return Err(Error::Invalid);
    }
    let state = replay(g, &load(tx, g.cluster())?)?;
    let target = *state
        .members
        .iter()
        .find(|(_, k)| **k == local)
        .map(|(id, _)| id)
        .ok_or(Error::Invalid)?;
    if target == state.primary || state.epoch >= MAX_COUNTER {
        return Err(Error::Invalid);
    }
    let signature: [u8; 64] = pair
        .sign(&acceptance_body(
            state.cluster,
            state.epoch,
            operation,
            target,
            local,
            state.sequence,
            state.head,
        ))
        .as_ref()
        .try_into()
        .unwrap();
    let old: Option<(u64, Vec<u8>, Vec<u8>)> = tx
        .query_row(
            "SELECT epoch,target,acceptance FROM prepared WHERE operation=?1",
            params![operation],
            |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
        )
        .optional()?;
    if let Some((epoch, id, sig)) = old {
        if epoch != state.epoch || id != target || sig != signature {
            return Err(Error::Conflict);
        }
    } else {
        // A current-prefix acceptance is an obligation until the signed log
        // advances. Never expire it by wall clock. Retain obsolete receipts
        // for idempotency, with a separate total bound per local incarnation.
        let total: u64 = tx.query_row("SELECT COUNT(*) FROM prepared", [], |r| r.get(0))?;
        let active: u64=tx.query_row("SELECT COUNT(*) FROM prepared WHERE epoch=?1 AND prefix_sequence=?2 AND prefix_hash=?3",params![state.epoch,state.sequence,state.head],|r|r.get(0))?;
        if active >= 16 || total >= MAX_HISTORY as u64 {
            return Err(Error::Limit);
        }
        tx.execute(
            "INSERT INTO prepared VALUES(?1,?2,?3,?4,?5,?6)",
            params![
                operation,
                state.epoch,
                target,
                signature,
                state.sequence,
                state.head
            ],
        )?;
    }
    Ok(Mutation::Transfer {
        id: target,
        key: local,
        prefix_sequence: state.sequence,
        prefix_hash: state.head,
        acceptance: signature,
    })
}
fn replay(g: &Genesis, entries: &[Entry]) -> Result<State, Error> {
    let mut s = State::genesis(g);
    for e in entries {
        s.apply(e)?;
    }
    Ok(s)
}
fn load(db: &Connection, cluster: Id) -> Result<Vec<Entry>, Error> {
    let count: i64 = db.query_row("SELECT COUNT(*) FROM log", [], |r| r.get(0))?;
    if count < 0 || count as usize > MAX_HISTORY {
        return Err(Error::Limit);
    }
    let mut stmt=db.prepare("SELECT sequence,epoch,previous,operation,request,payload,signature FROM log ORDER BY sequence")?;
    let rows = stmt.query_map([], |r| {
        Ok((
            r.get::<_, u64>(0)?,
            r.get::<_, u64>(1)?,
            r.get::<_, Vec<u8>>(2)?,
            r.get::<_, Vec<u8>>(3)?,
            r.get::<_, Vec<u8>>(4)?,
            r.get::<_, Vec<u8>>(5)?,
            r.get::<_, Vec<u8>>(6)?,
        ))
    })?;
    rows.map(|row| {
        let (sequence, epoch, previous, operation, request, payload, signature) = row?;
        Ok(Entry {
            cluster,
            sequence,
            epoch,
            previous: previous.try_into().map_err(|_| Error::Invalid)?,
            operation: operation.try_into().map_err(|_| Error::Invalid)?,
            request: request.try_into().map_err(|_| Error::Invalid)?,
            mutation: Mutation::load(&payload)?,
            signature: signature.try_into().map_err(|_| Error::Invalid)?,
        })
    })
    .collect()
}
fn insert(tx: &Transaction<'_>, e: &Entry) -> Result<(), Error> {
    tx.execute(
        "INSERT INTO log VALUES(?1,?2,?3,?4,?5,?6,?7)",
        params![
            e.sequence,
            e.epoch,
            e.previous,
            e.operation,
            e.request,
            e.mutation.storage(),
            e.signature
        ],
    )?;
    Ok(())
}
fn append(
    tx: &Transaction<'_>,
    g: &Genesis,
    local: Id,
    pair: &Ed25519KeyPair,
    epoch: u64,
    operation: Id,
    mutation: Mutation,
) -> Result<Entry, Error> {
    check_identity(tx, g, local)?;
    if key(pair) != local {
        return Err(Error::Invalid);
    }
    let history = load(tx, g.cluster())?;
    let state = replay(g, &history)?;
    let request = request_hash(g.cluster(), epoch, operation, &mutation);
    if let Some(entry) = history.iter().find(|e| e.operation == operation) {
        return if entry.request == request {
            Ok(entry.clone())
        } else {
            Err(Error::Conflict)
        };
    }
    let sealed: bool = tx.query_row("SELECT sealed FROM identity WHERE id=1", [], |r| r.get(0))?;
    if sealed || state.members.get(&state.primary) != Some(&local) || state.epoch != epoch {
        return Err(Error::NotPrimary);
    }
    if history.len() >= MAX_HISTORY {
        return Err(Error::Limit);
    }
    let sequence = state
        .sequence
        .checked_add(1)
        .filter(|n| *n <= MAX_COUNTER)
        .ok_or(Error::Exhausted)?;
    let mut entry = Entry {
        cluster: g.cluster(),
        epoch,
        sequence,
        previous: state.head,
        operation,
        request,
        mutation,
        signature: [0; 64],
    };
    entry.signature = pair.sign(&entry.body()).as_ref().try_into().unwrap();
    let mut after = state;
    after.apply(&entry)?;
    if history.iter().map(|e| e.body().len() + 128).sum::<usize>() + entry.body().len() + 128
        > 240 * 1024
    {
        return Err(Error::Limit);
    }
    insert(tx, &entry)?;
    if matches!(entry.mutation, Mutation::Transfer { .. }) {
        tx.execute("UPDATE identity SET sealed=1 WHERE id=1", [])?;
    }
    Ok(entry)
}
fn install(tx: &Transaction<'_>, g: &Genesis, local: Id, entries: &[Entry]) -> Result<(), Error> {
    check_identity(tx, g, local)?;
    if entries.len() > MAX_HISTORY {
        return Err(Error::Limit);
    }
    let existing = load(tx, g.cluster())?;
    if entries.len() < existing.len() || entries[..existing.len()] != existing {
        return Err(Error::Invalid);
    }
    if entries.iter().map(|e| e.body().len() + 128).sum::<usize>() > 240 * 1024 {
        return Err(Error::Limit);
    }
    replay(g, entries)?;
    for e in &entries[existing.len()..] {
        if let Mutation::Transfer {
            id,
            key,
            acceptance,
            ..
        } = &e.mutation
        {
            if *key == local {
                let prepared: Option<(u64, Vec<u8>, Vec<u8>)> = tx
                    .query_row(
                        "SELECT epoch,target,acceptance FROM prepared WHERE operation=?1",
                        params![e.operation],
                        |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
                    )
                    .optional()?;
                if prepared != Some((e.epoch, id.to_vec(), acceptance.to_vec())) {
                    return Err(Error::Unprepared);
                }
                // Only this explicit, verified, prepared handoff can activate a
                // previously sealed node in a later epoch; timeout never can.
                tx.execute("UPDATE identity SET sealed=0 WHERE id=1", [])?;
            }
        }
        insert(tx, e)?;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    fn pair(n: u8) -> Ed25519KeyPair {
        Ed25519KeyPair::from_seed_unchecked(&[n; 32]).unwrap()
    }
    fn genesis() -> Genesis {
        Genesis {
            nonce: [9; 32],
            root: [1; 32],
            root_key: key(&pair(1)),
            root_endpoint: "https://fixture.invalid/rieul/rpc".into(),
        }
    }
    fn open(path: &Path, n: u8) -> Store {
        Store::open(path, genesis(), key(&pair(n))).unwrap()
    }
    fn admit(n: u8) -> Mutation {
        Mutation::Admit {
            id: [n; 32],
            key: key(&pair(n)),
            consent: [0; 32],
            endpoint: format!("https://node{n}.invalid/rieul/rpc"),
        }
    }
    fn setup() -> (tempfile::TempDir, Store, Store) {
        let dir = tempfile::tempdir().unwrap();
        let mut a = open(&dir.path().join("a"), 1);
        let mut b = open(&dir.path().join("b"), 2);
        a.commit(&pair(1), 1, [11; 32], admit(2)).unwrap();
        b.install_history(&a.entries().unwrap()).unwrap();
        (dir, a, b)
    }
    #[test]
    fn transfer_preparation_capacity_preserves_existing_obligations() {
        let (_dir, mut source, mut target) = setup();
        let first = target.prepare_transfer(&pair(2), [100; 32]).unwrap();
        for n in 101..116u8 {
            target.prepare_transfer(&pair(2), [n; 32]).unwrap();
        }
        assert!(matches!(
            target.prepare_transfer(&pair(2), [116; 32]),
            Err(Error::Limit)
        ));
        assert_eq!(target.prepare_transfer(&pair(2), [100; 32]).unwrap(), first);
        assert_eq!(
            target
                .db
                .query_row("SELECT COUNT(*) FROM prepared", [], |r| r.get::<_, i64>(0))
                .unwrap(),
            16
        );
        source.commit(&pair(1), 1, [117; 32], admit(3)).unwrap();
        target.install_history(&source.entries().unwrap()).unwrap();
        // Old-prefix receipts stay retryable but cannot starve a new prefix.
        target.prepare_transfer(&pair(2), [116; 32]).unwrap();
    }
    #[test]
    fn durable_receipts_survive_seal_restart_and_transfer_to_new_primary() {
        let (dir, mut a, mut b) = setup();
        // Even an existing successful receipt requires the fixture identity check.
        assert!(matches!(
            a.commit(&pair(9), 1, [11; 32], admit(2)),
            Err(Error::Invalid)
        ));
        let transfer = b.prepare_transfer(&pair(2), [20; 32]).unwrap();
        let certificate = a.commit(&pair(1), 1, [20; 32], transfer.clone()).unwrap();
        drop(a);
        let mut a = open(&dir.path().join("a"), 1);
        assert_eq!(
            a.commit(&pair(1), 1, [20; 32], transfer.clone()).unwrap(),
            certificate
        );
        assert!(matches!(
            a.commit(&pair(1), 1, [21; 32], admit(3)),
            Err(Error::NotPrimary)
        ));
        assert!(matches!(
            a.commit(&pair(1), 1, [20; 32], admit(3)),
            Err(Error::Conflict)
        ));
        b.install_history(&a.entries().unwrap()).unwrap();
        drop(b);
        let mut b = open(&dir.path().join("b"), 2);
        assert_eq!(
            b.commit(&pair(2), 1, [20; 32], transfer).unwrap(),
            certificate
        );
        let next = b.commit(&pair(2), 2, [21; 32], admit(3)).unwrap();
        assert_eq!(next.previous, certificate.hash());
        assert_eq!(next.sequence, certificate.sequence + 1);
        a.install_history(&b.entries().unwrap()).unwrap();
        assert_eq!(a.state().unwrap(), b.state().unwrap());
    }
    #[test]
    fn uncommitted_seal_and_target_activation_roll_back() {
        let (dir, mut a, mut b) = setup();
        let transfer = b.prepare_transfer(&pair(2), [20; 32]).unwrap();
        {
            let tx =
                a.db.transaction_with_behavior(TransactionBehavior::Immediate)
                    .unwrap();
            append(
                &tx,
                &a.genesis,
                a.local,
                &pair(1),
                1,
                [20; 32],
                transfer.clone(),
            )
            .unwrap();
            // Signed bytes are deliberately not exposed outside Store::commit.
        }
        drop(a);
        let mut a = open(&dir.path().join("a"), 1);
        assert_eq!(a.state().unwrap().sequence, 1);
        let certificate = a.commit(&pair(1), 1, [20; 32], transfer).unwrap();
        {
            let tx =
                b.db.transaction_with_behavior(TransactionBehavior::Immediate)
                    .unwrap();
            install(&tx, &b.genesis, b.local, &a.entries().unwrap()).unwrap();
        }
        drop(b);
        let mut b = open(&dir.path().join("b"), 2);
        assert!(matches!(
            b.commit(&pair(2), 2, [21; 32], admit(3)),
            Err(Error::NotPrimary)
        ));
        b.install_history(&a.entries().unwrap()).unwrap();
        assert_eq!(b.state().unwrap().head, certificate.hash());
        b.install_history(&a.entries().unwrap()).unwrap();
        assert_eq!(b.state().unwrap().sequence, 2);
    }
    #[test]
    fn writes_and_seal_share_one_serialization_path_and_exact_prefix() {
        let (dir, mut a, mut b) = setup();
        let transfer = b.prepare_transfer(&pair(2), [20; 32]).unwrap();
        let mut other = open(&dir.path().join("a"), 1);
        let barrier = std::sync::Barrier::new(2);
        let (write, seal) = std::thread::scope(|s| {
            let x = s.spawn(|| {
                barrier.wait();
                a.commit(&pair(1), 1, [21; 32], admit(3))
            });
            let y = s.spawn(|| {
                barrier.wait();
                other.commit(&pair(1), 1, [20; 32], transfer)
            });
            (x.join().unwrap(), y.join().unwrap())
        });
        assert_ne!(write.is_ok(), seal.is_ok());
        assert_eq!(a.state().unwrap().sequence, 2);
        assert_eq!(a.state().unwrap(), other.state().unwrap());
        if write.is_ok() {
            assert!(matches!(seal, Err(Error::Invalid)));
        } else {
            assert!(matches!(write, Err(Error::NotPrimary)));
        }
    }
    #[test]
    fn target_hash_epoch_and_signature_mismatches_do_not_seal_or_install() {
        let (dir, mut a, mut b) = setup();
        let transfer = b.prepare_transfer(&pair(2), [20; 32]).unwrap();
        let before = a.state().unwrap();
        for field in 0..4 {
            let mut changed = transfer.clone();
            if let Mutation::Transfer {
                id,
                key,
                prefix_hash,
                acceptance,
                ..
            } = &mut changed
            {
                match field {
                    0 => id[0] ^= 1,
                    1 => key[0] ^= 1,
                    2 => prefix_hash[0] ^= 1,
                    _ => acceptance[0] ^= 1,
                }
            }
            assert!(a.commit(&pair(1), 1, [20; 32], changed).is_err());
            assert_eq!(a.state().unwrap(), before);
        }
        assert!(matches!(
            a.commit(&pair(1), 2, [20; 32], transfer.clone()),
            Err(Error::NotPrimary)
        ));
        a.commit(&pair(1), 1, [20; 32], transfer).unwrap();
        let history = a.entries().unwrap();
        let mut unprepared = open(&dir.path().join("unprepared"), 2);
        assert!(matches!(
            unprepared.install_history(&history),
            Err(Error::Unprepared)
        ));
        assert_eq!(unprepared.state().unwrap().sequence, 0);
        b.install_history(&history).unwrap();
        for field in 0..4 {
            let mut changed = history.clone();
            let e = &mut changed[0];
            match field {
                0 => e.previous[0] ^= 1,
                1 => e.signature[0] ^= 1,
                2 => e.cluster[0] ^= 1,
                _ => e.sequence += 1,
            }
            assert!(b.install_history(&changed).is_err());
        }
        assert!(b.install_history(&history[..1]).is_err());
        assert_eq!(b.state().unwrap(), a.state().unwrap());
    }
    #[test]
    fn invalid_new_suffix_fails_verification_without_changing_local_database() {
        let (dir, mut source, _) = setup();
        let prefix = source.entries().unwrap();
        source.commit(&pair(1), 1, [40; 32], admit(3)).unwrap();
        let complete = source.entries().unwrap();
        for field in 0..4 {
            let path = dir.path().join(format!("suffix-{field}"));
            let mut replica = open(&path, 4);
            replica.install_history(&prefix).unwrap();
            let before = replica.state().unwrap();
            let mut tampered = complete.clone();
            let suffix = tampered.last_mut().unwrap();
            match field {
                0 => suffix.signature[0] ^= 1,
                1 => suffix.request[0] ^= 1,
                2 => suffix.epoch += 1,
                _ => suffix.previous[0] ^= 1,
            }
            assert_eq!(&tampered[..prefix.len()], prefix.as_slice());
            assert!(matches!(
                replica.install_history(&tampered),
                Err(Error::Invalid)
            ));
            drop(replica);
            let mut replica = open(&path, 4);
            assert_eq!(replica.entries().unwrap(), prefix);
            assert_eq!(replica.state().unwrap(), before);
            replica.install_history(&complete).unwrap();
            assert_eq!(replica.state().unwrap(), source.state().unwrap());
        }
    }
    #[test]
    fn cancellation_tombstone_blocks_late_admission_and_primary_cannot_leave() {
        let (dir, mut a, _) = setup();
        a.commit(&pair(1), 1, [30; 32], Mutation::Remove { id: [3; 32] })
            .unwrap();
        drop(a);
        let mut a = open(&dir.path().join("a"), 1);
        assert!(a.commit(&pair(1), 1, [31; 32], admit(3)).is_err());
        assert!(a
            .commit(&pair(1), 1, [32; 32], Mutation::Remove { id: [1; 32] })
            .is_err());
        a.commit(&pair(1), 1, [33; 32], Mutation::Remove { id: [2; 32] })
            .unwrap();
        let old_receipt = a.commit(&pair(1), 1, [11; 32], admit(2)).unwrap();
        assert_eq!(old_receipt.sequence, 1);
        assert!(!a.state().unwrap().members.contains_key(&[2; 32]));
        a.commit(
            &pair(1),
            1,
            [34; 32],
            Mutation::Admit {
                id: [4; 32],
                key: key(&pair(2)),
                consent: [0; 32],
                endpoint: "https://node2.invalid/rieul/rpc".into(),
            },
        )
        .unwrap();
        assert_eq!(
            a.state().unwrap().members.get(&[4; 32]),
            Some(&key(&pair(2)))
        );
    }
    #[test]
    fn target_can_only_return_authority_through_a_new_prepared_transfer() {
        let (_dir, mut a, mut b) = setup();
        let first = b.prepare_transfer(&pair(2), [20; 32]).unwrap();
        a.commit(&pair(1), 1, [20; 32], first).unwrap();
        b.install_history(&a.entries().unwrap()).unwrap();
        let back = a.prepare_transfer(&pair(1), [21; 32]).unwrap();
        b.commit(&pair(2), 2, [21; 32], back).unwrap();
        a.install_history(&b.entries().unwrap()).unwrap();
        a.commit(&pair(1), 3, [22; 32], admit(3)).unwrap();
        assert!(matches!(
            b.commit(&pair(2), 2, [23; 32], admit(4)),
            Err(Error::NotPrimary)
        ));
    }
    #[test]
    fn invalid_fixture_database_and_identity_fail_closed() {
        let (dir, a, _) = setup();
        assert!(matches!(
            Store::open(&dir.path().join("a"), genesis(), key(&pair(9))),
            Err(Error::Invalid)
        ));
        drop(a);
        match Store::open(dir.path(), genesis(), key(&pair(1))) {
            Err(Error::Database(error)) => assert!(!error.to_string().is_empty()),
            _ => panic!("expected DB error"),
        }
    }
}
