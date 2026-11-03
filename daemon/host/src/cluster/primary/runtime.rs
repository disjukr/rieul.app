//! Opt-in management and primary-adopted client grants.
mod adoption;
pub(crate) mod join;
pub(crate) mod peer;
pub(crate) mod worker;
use super::*;
use rieul_daemon_core::generated::rpc::*;
use ring::rand::{SecureRandom, SystemRandom};
use std::{
    fs::{self, OpenOptions},
    time::{SystemTime, UNIX_EPOCH},
};

pub const ENROLLMENT_SUPPORTED: bool = !cfg!(windows);
pub const MAX_RPC_BYTES: usize = 512 * 1024;
const MAX_MUTATION_BYTES: usize = 2145;
/// Constructed only after server credential refresh/revocation validation.
pub(crate) struct Authorized {
    pub(crate) expires_at_unix: i64,
    pub(crate) client_id: String,
    pub(crate) peer: Option<(Id, Id)>,
}
#[derive(Debug)]
pub enum RuntimeError {
    Unauthorized,
    InvalidProof,
    Conflict,
    PrimaryUnavailable,
    AlreadyAffiliated,
    Retired,
    Limit,
    InvalidState,
    Storage,
}
impl From<Error> for RuntimeError {
    fn from(e: Error) -> Self {
        match e {
            Error::Invalid => Self::InvalidProof,
            Error::Conflict => Self::Conflict,
            Error::NotPrimary => Self::PrimaryUnavailable,
            Error::Unprepared => Self::InvalidState,
            Error::Exhausted | Error::Limit => Self::Limit,
            Error::Database(e) => {
                let _ = e.sqlite_error_code();
                Self::Storage
            }
        }
    }
}
impl From<rusqlite::Error> for RuntimeError {
    fn from(_: rusqlite::Error) -> Self {
        Self::Storage
    }
}
fn id(bytes: &[u8]) -> Result<Id, RuntimeError> {
    bytes.try_into().map_err(|_| RuntimeError::InvalidProof)
}
fn now() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs() as i64
}
fn random() -> Result<Id, RuntimeError> {
    let mut out = [0; 32];
    SystemRandom::new()
        .fill(&mut out)
        .map_err(|_| RuntimeError::Storage)?;
    Ok(out)
}
fn genesis(w: &ClusterGenesis) -> Result<Genesis, RuntimeError> {
    Ok(Genesis {
        nonce: id(&w.nonce)?,
        root: id(&w.root_admission_id)?,
        root_key: id(&w.root_public_key)?,
        root_endpoint: {
            validate_endpoint(&w.root_endpoint)?;
            w.root_endpoint.clone()
        },
    })
}
fn wire_genesis(g: &Genesis) -> ClusterGenesis {
    ClusterGenesis {
        nonce: g.nonce.to_vec(),
        root_admission_id: g.root.to_vec(),
        root_public_key: g.root_key.to_vec(),
        root_endpoint: g.root_endpoint.clone(),
    }
}
fn head(s: &State) -> ClusterHead {
    ClusterHead {
        cluster_id: s.cluster.to_vec(),
        management_epoch: s.epoch as i64,
        sequence: s.sequence as i64,
        entry_hash: s.head.to_vec(),
        primary_admission_id: s.primary.to_vec(),
    }
}
fn matches_head(w: &ClusterHead, s: &State) -> bool {
    w == &head(s)
}
fn wire_entry(e: &Entry) -> ClusterJournalEntry {
    ClusterJournalEntry {
        cluster_id: e.cluster.to_vec(),
        management_epoch: e.epoch as i64,
        sequence: e.sequence as i64,
        previous_hash: e.previous.to_vec(),
        operation_id: e.operation.to_vec(),
        request_hash: e.request.to_vec(),
        mutation: e.mutation.storage(),
        signature: e.signature.to_vec(),
    }
}
fn counter(value: i64) -> Result<u64, RuntimeError> {
    if value <= 0 || value as u64 > MAX_COUNTER {
        Err(RuntimeError::InvalidProof)
    } else {
        Ok(value as u64)
    }
}
fn entry(w: &ClusterJournalEntry) -> Result<Entry, RuntimeError> {
    if w.mutation.len() > MAX_MUTATION_BYTES {
        return Err(RuntimeError::Limit);
    }
    Ok(Entry {
        cluster: id(&w.cluster_id)?,
        epoch: counter(w.management_epoch)?,
        sequence: counter(w.sequence)?,
        previous: id(&w.previous_hash)?,
        operation: id(&w.operation_id)?,
        request: id(&w.request_hash)?,
        mutation: Mutation::load(&w.mutation)?,
        signature: w
            .signature
            .as_slice()
            .try_into()
            .map_err(|_| RuntimeError::InvalidProof)?,
    })
}
struct Node {
    g: Genesis,
    pair: Ed25519KeyPair,
    admission: Id,
    operation: Id,
    phase: i64,
    endpoint: String,
    consent_expires: i64,
}
fn consent_body(
    g: &Genesis,
    operation: Id,
    admission: Id,
    public: Id,
    endpoint: &str,
    expires: i64,
) -> Vec<u8> {
    Value::Array(vec![
        Value::Text("rieul.cluster.target-consent.v2".into()),
        b(g.cluster()),
        b(operation),
        b(admission),
        b(public),
        Value::Bool(true),
        Value::Text(endpoint.to_owned()),
        Value::I64(expires),
    ])
    .encode()
}
fn consent(n: &Node) -> ClusterJoinConsent {
    let public = key(&n.pair);
    ClusterJoinConsent {
        expires_at_unix: n.consent_expires,
        genesis: wire_genesis(&n.g),
        endpoint: n.endpoint.clone(),
        operation_id: n.operation.to_vec(),
        admission_id: n.admission.to_vec(),
        node_public_key: public.to_vec(),
        signature: n
            .pair
            .sign(&consent_body(
                &n.g,
                n.operation,
                n.admission,
                public,
                &n.endpoint,
                n.consent_expires,
            ))
            .as_ref()
            .to_vec(),
    }
}
fn safe_file(path: &Path, create: bool) -> Result<(), RuntimeError> {
    if !path.exists() {
        if !create {
            return Err(RuntimeError::InvalidState);
        }
        let mut options = OpenOptions::new();
        options.write(true).create_new(true);
        #[cfg(unix)]
        {
            use std::os::unix::fs::OpenOptionsExt;
            options.mode(0o600);
        }
        match options.open(path) {
            Ok(file) => file.sync_all().map_err(|_| RuntimeError::Storage)?,
            Err(e) if e.kind() == std::io::ErrorKind::AlreadyExists => {}
            Err(_) => return Err(RuntimeError::Storage),
        }
    }
    let metadata = fs::symlink_metadata(path).map_err(|_| RuntimeError::Storage)?;
    if !metadata.is_file() || metadata.file_type().is_symlink() {
        return Err(RuntimeError::Storage);
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::MetadataExt;
        if metadata.mode() & 0o077 != 0 || metadata.nlink() != 1 {
            return Err(RuntimeError::Storage);
        }
        let parent = fs::metadata(path.parent().ok_or(RuntimeError::Storage)?)
            .map_err(|_| RuntimeError::Storage)?;
        if parent.mode() & 0o022 != 0 || parent.uid() != metadata.uid() {
            return Err(RuntimeError::Storage);
        }
    }
    Ok(())
}
fn database(path: &Path, create: bool) -> Result<Connection, RuntimeError> {
    safe_file(path, create)?;
    let db = Connection::open(path)?;
    db.busy_timeout(Duration::from_secs(5))?;
    db.execute_batch("PRAGMA synchronous=FULL;
    CREATE TABLE IF NOT EXISTS node(id INTEGER PRIMARY KEY CHECK(id=1),pkcs8 BLOB NOT NULL,nonce BLOB NOT NULL,root BLOB NOT NULL,root_key BLOB NOT NULL,admission BLOB NOT NULL,operation BLOB NOT NULL,phase INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS node_join_scope(id INTEGER PRIMARY KEY CHECK(id=1),expires INTEGER NOT NULL,sync_enabled INTEGER NOT NULL DEFAULT 0);
    CREATE TABLE IF NOT EXISTS node_endpoint(id INTEGER PRIMARY KEY CHECK(id=1),local TEXT NOT NULL,root TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS leaving(operation BLOB PRIMARY KEY,cluster BLOB NOT NULL,admission BLOB NOT NULL,UNIQUE(cluster,admission));
    CREATE TABLE IF NOT EXISTS retired_local(operation BLOB PRIMARY KEY,cluster BLOB NOT NULL,admission BLOB NOT NULL);")?;
    Ok(db)
}
fn load_node(db: &Connection) -> Result<Option<Node>, RuntimeError> {
    let raw: Option<(Vec<u8>, Vec<u8>, Vec<u8>, Vec<u8>, Vec<u8>, Vec<u8>, i64)> = db
        .query_row(
            "SELECT pkcs8,nonce,root,root_key,admission,operation,phase FROM node WHERE id=1",
            [],
            |r| {
                Ok((
                    r.get(0)?,
                    r.get(1)?,
                    r.get(2)?,
                    r.get(3)?,
                    r.get(4)?,
                    r.get(5)?,
                    r.get(6)?,
                ))
            },
        )
        .optional()?;
    let endpoints: Option<(String, String)> = db
        .query_row("SELECT local,root FROM node_endpoint WHERE id=1", [], |r| {
            Ok((r.get(0)?, r.get(1)?))
        })
        .optional()?;
    let consent_expires: i64 = db
        .query_row("SELECT expires FROM node_join_scope WHERE id=1", [], |r| {
            r.get(0)
        })
        .optional()?
        .unwrap_or(0);
    raw.map(
        |(pkcs8, nonce, root, root_key, admission, operation, phase)| {
            let (endpoint, root_endpoint) = endpoints.clone().ok_or(RuntimeError::Storage)?;
            validate_endpoint(&endpoint)?;
            validate_endpoint(&root_endpoint)?;
            Ok(Node {
                consent_expires,
                endpoint,
                pair: Ed25519KeyPair::from_pkcs8(&pkcs8).map_err(|_| RuntimeError::Storage)?,
                g: Genesis {
                    nonce: id(&nonce)?,
                    root: id(&root)?,
                    root_key: id(&root_key)?,
                    root_endpoint,
                },
                admission: id(&admission)?,
                operation: id(&operation)?,
                phase,
            })
        },
    )
    .transpose()
}
fn initialize(
    path: &Path,
    operation: Id,
    target: Option<Genesis>,
    endpoint: &str,
) -> Result<(), RuntimeError> {
    if !ENROLLMENT_SUPPORTED {
        return Err(RuntimeError::InvalidState);
    }
    validate_endpoint(endpoint)?;
    let mut db = database(path, true)?;
    let tx = db.transaction_with_behavior(TransactionBehavior::Immediate)?;
    let retired: bool = tx.query_row(
        "SELECT EXISTS(SELECT 1 FROM retired_local WHERE operation=?1)",
        params![operation],
        |r| r.get(0),
    )?;
    if retired {
        return Err(RuntimeError::Retired);
    }
    if let Some(old) = load_node(&tx)? {
        if old.operation == operation {
            if old.endpoint != endpoint {
                return Err(RuntimeError::Conflict);
            }
            let same = match target {
                Some(g) => g == old.g && old.phase <= 2,
                None => old.g.root_key == key(&old.pair) && old.g.root == old.admission,
            };
            if !same {
                return Err(RuntimeError::Conflict);
            }
            return Ok(());
        }
        if old.phase != 4 {
            return Err(RuntimeError::AlreadyAffiliated);
        }
        tx.execute(
            "INSERT OR IGNORE INTO retired_local VALUES(?1,?2,?3)",
            params![old.operation, old.g.cluster(), old.admission],
        )?;
        let admission = random()?;
        let (g, phase) = match target {
            Some(g) => (g, 1),
            None => (
                Genesis {
                    nonce: random()?,
                    root: admission,
                    root_key: key(&old.pair),
                    root_endpoint: endpoint.to_owned(),
                },
                2,
            ),
        };
        tx.execute(
            "INSERT OR REPLACE INTO node_join_scope VALUES(1,?1,0)",
            [if phase == 1 { now() + 300 } else { 0 }],
        )?;
        tx.execute("UPDATE node SET nonce=?1,root=?2,root_key=?3,admission=?4,operation=?5,phase=?6 WHERE id=1",params![g.nonce,g.root,g.root_key,admission,operation,phase])?;
        tx.execute(
            "UPDATE node_endpoint SET local=?1,root=?2 WHERE id=1",
            params![endpoint, g.root_endpoint],
        )?;
        tx.execute_batch("DELETE FROM log; DELETE FROM prepared; DELETE FROM identity;")?;
        tx.commit()?;
        return Ok(());
    }
    let pkcs8 =
        Ed25519KeyPair::generate_pkcs8(&SystemRandom::new()).map_err(|_| RuntimeError::Storage)?;
    let pair = Ed25519KeyPair::from_pkcs8(pkcs8.as_ref()).map_err(|_| RuntimeError::Storage)?;
    let admission = random()?;
    let (g, phase) = match target {
        Some(g) => (g, 1),
        None => (
            Genesis {
                nonce: random()?,
                root: admission,
                root_key: key(&pair),
                root_endpoint: endpoint.to_owned(),
            },
            2,
        ),
    };
    tx.execute(
        "INSERT INTO node_join_scope VALUES(1,?1,0)",
        [if phase == 1 { now() + 300 } else { 0 }],
    )?;
    tx.execute(
        "INSERT INTO node VALUES(1,?1,?2,?3,?4,?5,?6,?7)",
        params![
            pkcs8.as_ref(),
            g.nonce,
            g.root,
            g.root_key,
            admission,
            operation,
            phase
        ],
    )?;
    tx.execute(
        "INSERT INTO node_endpoint VALUES(1,?1,?2)",
        params![endpoint, g.root_endpoint],
    )?;
    tx.commit()?;
    Ok(())
}
fn opened(path: &Path) -> Result<(Node, Store), RuntimeError> {
    let db = database(path, false)?;
    let node = load_node(&db)?.ok_or(RuntimeError::InvalidState)?;
    drop(db);
    let store = Store::open(path, node.g.clone(), key(&node.pair))?;
    Ok((node, store))
}
fn leaving(db: &Connection, n: &Node) -> Result<bool, RuntimeError> {
    Ok(db.query_row(
        "SELECT EXISTS(SELECT 1 FROM leaving WHERE cluster=?1 AND admission=?2)",
        params![n.g.cluster(), n.admission],
        |r| r.get(0),
    )?)
}
fn leave_request(path: &Path) -> Result<Option<RemoveClusterMemberReq>, RuntimeError> {
    let (n, store) = opened(path)?;
    if n.phase != 2 {
        return Ok(None);
    }
    let operation: Option<Vec<u8>> = store
        .db
        .query_row(
            "SELECT operation FROM leaving WHERE cluster=?1 AND admission=?2",
            params![n.g.cluster(), n.admission],
            |r| r.get(0),
        )
        .optional()?;
    let s = store.state()?;
    operation
        .map(|operation| {
            Ok(RemoveClusterMemberReq {
                operation_id: id(&operation)?.to_vec(),
                admission_id: n.admission.to_vec(),
                expected_management_epoch: s.epoch as i64,
            })
        })
        .transpose()
}
fn request_leave(
    path: &Path,
    auth: &Authorized,
    operation: Id,
) -> Result<ClusterState, RuntimeError> {
    let (n, mut store) = opened(path)?;
    let tx = store
        .db
        .transaction_with_behavior(TransactionBehavior::Immediate)?;
    let current = load_node(&tx)?.ok_or(RuntimeError::InvalidState)?;
    if current.g != n.g || current.admission != n.admission {
        return Err(RuntimeError::Conflict);
    }
    authorize_transaction(&tx, &current, auth)?;
    let binding: Option<(Vec<u8>, Vec<u8>)> = tx
        .query_row(
            "SELECT cluster,admission FROM leaving WHERE operation=?1",
            params![operation],
            |r| Ok((r.get(0)?, r.get(1)?)),
        )
        .optional()?;
    if let Some((cluster, admission)) = binding {
        if cluster != current.g.cluster() || admission != current.admission {
            return Err(RuntimeError::Conflict);
        }
    }
    let old: Option<Vec<u8>> = tx
        .query_row(
            "SELECT operation FROM leaving WHERE cluster=?1 AND admission=?2",
            params![current.g.cluster(), current.admission],
            |r| r.get(0),
        )
        .optional()?;
    if let Some(old) = old {
        if old != operation {
            return Err(RuntimeError::Conflict);
        }
        tx.commit()?;
        return state(path);
    }
    require_member(&current)?;
    let s = replay(&current.g, &load(&tx, current.g.cluster())?)?;
    if s.operations.contains(&operation) {
        return Err(RuntimeError::Conflict);
    }
    let count: u64 = tx.query_row("SELECT COUNT(*) FROM leaving", [], |r| r.get(0))?;
    if count >= MAX_HISTORY as u64 {
        return Err(RuntimeError::Limit);
    }
    let prepared:bool=tx.query_row("SELECT EXISTS(SELECT 1 FROM prepared WHERE epoch=?1 AND prefix_sequence=?2 AND prefix_hash=?3)",params![s.epoch,s.sequence,s.head],|r|r.get(0))?;
    if s.primary == current.admission || prepared {
        return Err(RuntimeError::InvalidState);
    }
    tx.execute(
        "INSERT INTO leaving VALUES(?1,?2,?3)",
        params![operation, current.g.cluster(), current.admission],
    )?;
    tx.commit()?;
    state(path)
}
fn state(path: &Path) -> Result<ClusterState, RuntimeError> {
    if !path.exists() {
        return Ok(ClusterState::Unaffiliated);
    }
    let (n, store) = opened(path)?;
    match n.phase {
        1 => Ok(ClusterState::Joining {
            consent: consent(&n),
        }),
        3 => Ok(ClusterState::RemovalPending {
            cluster_id: n.g.cluster().to_vec(),
            admission_id: n.admission.to_vec(),
        }),
        4 => Ok(ClusterState::Removed {
            cluster_id: n.g.cluster().to_vec(),
            admission_id: n.admission.to_vec(),
        }),
        2 => {
            if leaving(&store.db, &n)? {
                return Ok(ClusterState::Leaving {
                    cluster_id: n.g.cluster().to_vec(),
                    admission_id: n.admission.to_vec(),
                });
            }
            let s = store.state()?;
            if s.members.get(&n.admission) != Some(&key(&n.pair)) {
                return Err(RuntimeError::Retired);
            }
            let sealed: bool =
                store
                    .db
                    .query_row("SELECT sealed FROM identity WHERE id=1", [], |r| r.get(0))?;
            let preparing: bool = store.db.query_row(
                "SELECT EXISTS(SELECT 1 FROM prepared WHERE epoch=?1)",
                [s.epoch],
                |r| r.get(0),
            )?;
            let transition = if sealed {
                ClusterPrimaryTransition::Sealed
            } else if s.primary == n.admission {
                ClusterPrimaryTransition::Active
            } else if preparing {
                ClusterPrimaryTransition::AwaitingActivation
            } else {
                ClusterPrimaryTransition::Replica
            };
            Ok(ClusterState::Member {
                genesis: wire_genesis(&n.g),
                head: head(&s),
                local_admission_id: n.admission.to_vec(),
                members: s
                    .members
                    .iter()
                    .map(|(id, key)| ClusterMember {
                        admission_id: id.to_vec(),
                        node_public_key: key.to_vec(),
                        endpoint: s.endpoints.get(id).cloned().unwrap_or_default(),
                    })
                    .collect(),
                primary_transition: transition,
            })
        }
        _ => Err(RuntimeError::Storage),
    }
}
fn history(store: &Store) -> Result<ClusterHistory, RuntimeError> {
    Ok(ClusterHistory {
        genesis: wire_genesis(&store.genesis),
        entries: store.entries()?.iter().map(wire_entry).collect(),
        head: head(&store.state()?),
    })
}
// This is an operation-scoped historical entitlement, never live membership.
// Return only the signed prefix ending at this exact admission's removal.
fn removal_proof(store: &Store, admission: Id, public: Id) -> Result<ClusterHistory, RuntimeError> {
    let entries = store.entries()?;
    let end = entries
        .iter()
        .position(|e| matches!(e.mutation,Mutation::Remove{id} if id==admission))
        .ok_or(RuntimeError::Unauthorized)?;
    let before = replay(&store.genesis, &entries[..end])?;
    if before.members.get(&admission) != Some(&public) {
        return Err(RuntimeError::Unauthorized);
    }
    let prefix = &entries[..=end];
    Ok(ClusterHistory {
        genesis: wire_genesis(&store.genesis),
        entries: prefix.iter().map(wire_entry).collect(),
        head: head(&replay(&store.genesis, prefix)?),
    })
}
fn apply_removal_proof(path: &Path, proof: &ClusterHistory) -> Result<(), RuntimeError> {
    let (n, _) = opened(path)?;
    let entries = decoded_history(proof, &n.g)?;
    let Some(last) = entries.last() else {
        return Err(RuntimeError::InvalidProof);
    };
    if !matches!(last.mutation,Mutation::Remove{id} if id==n.admission) {
        return Err(RuntimeError::InvalidProof);
    }
    let before = replay(&n.g, &entries[..entries.len() - 1])?;
    if before.members.get(&n.admission) != Some(&key(&n.pair)) {
        return Err(RuntimeError::InvalidProof);
    }
    import(path, proof, None, None, None)?;
    Ok(())
}
fn decoded_history(h: &ClusterHistory, g: &Genesis) -> Result<Vec<Entry>, RuntimeError> {
    if h.entries.len() > MAX_HISTORY {
        return Err(RuntimeError::Limit);
    }
    if genesis(&h.genesis)? != *g {
        return Err(RuntimeError::InvalidProof);
    }
    let entries = h.entries.iter().map(entry).collect::<Result<Vec<_>, _>>()?;
    if !matches_head(&h.head, &replay(g, &entries)?) {
        return Err(RuntimeError::InvalidProof);
    }
    Ok(entries)
}
fn require_member(n: &Node) -> Result<(), RuntimeError> {
    if n.phase != 2 {
        Err(RuntimeError::InvalidState)
    } else {
        Ok(())
    }
}
fn import(
    path: &Path,
    h: &ClusterHistory,
    finish: Option<Id>,
    activation: Option<Id>,
    external: Option<&Authorized>,
) -> Result<ClusterState, RuntimeError> {
    let (n, mut store) = opened(path)?;
    if (n.phase == 3 || n.phase == 4) && (finish.is_some() || activation.is_some()) {
        return Err(RuntimeError::Retired);
    }
    if let Some(op) = finish {
        if n.phase == 1 && n.consent_expires <= now() {
            return Err(RuntimeError::Retired);
        }
        if n.operation != op || n.phase != 1 && n.phase != 2 {
            return Err(RuntimeError::InvalidState);
        }
    } else if n.phase != 3 && n.phase != 4 {
        require_member(&n)?;
    }
    let entries = decoded_history(h, &n.g)?;
    let next = replay(&n.g, &entries)?;
    if finish.is_some() && next.members.get(&n.admission) != Some(&key(&n.pair)) {
        return Err(RuntimeError::Retired);
    }
    if finish.is_some() && n.phase == 1 {
        join::verify_admission(&n, &entries)?;
    }
    let before = store.state()?;
    if activation.is_none() && next.primary == n.admission && before.primary != n.admission {
        return Err(RuntimeError::InvalidState);
    }
    if let Some(op) = activation {
        if next.primary != n.admission
            || !entries.iter().any(|e| {
                e.operation == op
                    && matches!(&e.mutation,Mutation::Transfer{id,..} if *id==n.admission)
            })
        {
            return Err(RuntimeError::InvalidProof);
        }
    }
    let tx = store
        .db
        .transaction_with_behavior(TransactionBehavior::Immediate)?;
    let current = load_node(&tx)?.ok_or(RuntimeError::InvalidState)?;
    if current.g != n.g || current.admission != n.admission || current.operation != n.operation {
        return Err(RuntimeError::Conflict);
    }
    if finish.is_some() && current.phase == 1 && current.consent_expires <= now() {
        return Err(RuntimeError::Retired);
    }
    if (current.phase == 3 || current.phase == 4) && (finish.is_some() || activation.is_some()) {
        return Err(RuntimeError::Retired);
    }
    if let Some(auth) = external {
        authorize_transaction(&tx, &n, auth)?;
    }
    install(&tx, &n.g, key(&n.pair), &entries)?;
    let phase = if current.phase == 3 || current.phase == 4 {
        if next.seen.contains(&n.admission) && !next.members.contains_key(&n.admission) {
            4
        } else {
            current.phase
        }
    } else if next.members.get(&n.admission) == Some(&key(&n.pair)) {
        2
    } else {
        4
    };
    tx.execute("UPDATE node SET phase=?1 WHERE id=1", [phase])?;
    tx.commit()?;
    state(path)
}
fn authorize_transaction(
    tx: &Transaction<'_>,
    n: &Node,
    auth: &Authorized,
) -> Result<(), RuntimeError> {
    if auth.expires_at_unix <= now() {
        return Err(RuntimeError::Unauthorized);
    }
    if let Some((admission, public)) = auth.peer {
        let s = replay(&n.g, &load(tx, n.g.cluster())?)?;
        if s.members.get(&admission) != Some(&public) {
            return Err(RuntimeError::Unauthorized);
        }
    }
    Ok(())
}
fn commit_authorized(
    store: &mut Store,
    n: &Node,
    auth: &Authorized,
    epoch: u64,
    operation: Id,
    mutation: Mutation,
) -> Result<Entry, RuntimeError> {
    let tx = store
        .db
        .transaction_with_behavior(TransactionBehavior::Immediate)?;
    authorize_transaction(&tx, n, auth)?;
    let e = append(&tx, &n.g, key(&n.pair), &n.pair, epoch, operation, mutation)?;
    tx.commit()?;
    Ok(e)
}
fn commit_admission(
    store: &mut Store,
    n: &Node,
    auth: &Authorized,
    epoch: u64,
    operation: Id,
    mutation: Mutation,
    expires: i64,
) -> Result<Entry, RuntimeError> {
    let tx = store
        .db
        .transaction_with_behavior(TransactionBehavior::Immediate)?;
    authorize_transaction(&tx, n, auth)?;
    check_identity(&tx, &n.g, key(&n.pair))?;
    let entries = load(&tx, n.g.cluster())?;
    if let Some(receipt) = entries.iter().find(|entry| entry.operation == operation) {
        if receipt.request != request_hash(n.g.cluster(), epoch, operation, &mutation) {
            return Err(RuntimeError::Conflict);
        }
    } else if expires <= now() {
        return Err(RuntimeError::Retired);
    }
    let entry = append(&tx, &n.g, key(&n.pair), &n.pair, epoch, operation, mutation)?;
    tx.commit()?;
    Ok(entry)
}
pub(crate) fn reconcile_pairing_revocations(
    path: &Path,
    active: &[String],
) -> Result<(), RuntimeError> {
    if path.exists() {
        adoption::cancel_inactive(path, active)?;
    }
    Ok(())
}
pub(crate) fn execute(
    path: &Path,
    auth: &Authorized,
    request: RpcRequest,
    endpoint: &str,
) -> Result<RpcResponse, RuntimeError> {
    if !ENROLLMENT_SUPPORTED {
        return Err(RuntimeError::InvalidState);
    }
    // Must precede all database access, including durable receipt lookup.
    if auth.expires_at_unix <= now() {
        return Err(RuntimeError::Unauthorized);
    }
    Ok(match request {
        RpcRequest::BeginClusterClientAdoption(r) => RpcResponse::BeginClusterClientAdoption(
            adoption::begin(path, auth, &r.client_public_key)?,
        ),
        RpcRequest::CompleteClusterClientAdoption(r) => {
            RpcResponse::CompleteClusterClientAdoption(adoption::complete(path, auth, &r)?)
        }
        RpcRequest::GetClusterClientAdoption(r) => {
            RpcResponse::GetClusterClientAdoption(adoption::get(path, auth, id(&r.grant_id)?)?)
        }
        RpcRequest::AdoptClusterClient(r) => {
            let (n, mut store) = opened(path)?;
            require_member(&n)?;
            let challenge = &r.intent.challenge;
            if id(&challenge.cluster_id)? != n.g.cluster() {
                return Err(RuntimeError::InvalidProof);
            }
            let mutation = adoption::mutation(&r.intent)?;
            let operation = id(&challenge.grant_id)?;
            // Exact successful retries remain readable after expiry/removal. New
            // grants must still be current when accepted by the primary.
            let exists = store
                .entries()?
                .iter()
                .any(|entry| entry.operation == operation);
            if !exists && challenge.expires_at_unix <= now() {
                return Err(RuntimeError::Retired);
            }
            let entry = commit_authorized(
                &mut store,
                &n,
                auth,
                counter(r.expected_management_epoch)?,
                operation,
                mutation,
            )?;
            RpcResponse::AdoptClusterClient(wire_entry(&entry))
        }
        RpcRequest::RevokeClusterClientGrant(r) => {
            let (n, mut store) = opened(path)?;
            require_member(&n)?;
            let entry = commit_authorized(
                &mut store,
                &n,
                auth,
                counter(r.expected_management_epoch)?,
                id(&r.operation_id)?,
                Mutation::Revoke {
                    grant: id(&r.grant_id)?,
                },
            )?;
            RpcResponse::RevokeClusterClientGrant(wire_entry(&entry))
        }
        RpcRequest::ConfigureClusterJoinSync(r) => {
            RpcResponse::ConfigureClusterJoinSync(join::configure(path, auth, r)?)
        }
        RpcRequest::GetClusterState(()) => RpcResponse::GetClusterState(state(path)?),
        RpcRequest::GetClusterRevocationIssues(()) => {
            RpcResponse::GetClusterRevocationIssues(ClusterRevocationIssues {
                issues: adoption::issues(path)?,
            })
        }
        RpcRequest::LeaveCluster(r) => {
            RpcResponse::LeaveCluster(request_leave(path, auth, id(&r.operation_id)?)?)
        }
        RpcRequest::CreateCluster(r) => {
            if !r.confirmed {
                return Err(RuntimeError::InvalidState);
            }
            initialize(path, id(&r.operation_id)?, None, endpoint)?;
            RpcResponse::CreateCluster(state(path)?)
        }
        RpcRequest::PrepareClusterJoin(r) => {
            if !r.confirmed {
                return Err(RuntimeError::InvalidState);
            }
            initialize(
                path,
                id(&r.operation_id)?,
                Some(genesis(&r.genesis)?),
                endpoint,
            )?;
            let (n, _) = opened(path)?;
            if n.phase != 1 && n.phase != 2 {
                return Err(RuntimeError::Retired);
            }
            RpcResponse::PrepareClusterJoin(consent(&n))
        }
        RpcRequest::AdmitClusterMember(r) => {
            let (n, mut store) = opened(path)?;
            require_member(&n)?;
            let c = &r.consent;
            if genesis(&c.genesis)? != n.g {
                return Err(RuntimeError::InvalidProof);
            }
            let admission = id(&c.admission_id)?;
            let public = id(&c.node_public_key)?;
            verify(
                public,
                &consent_body(
                    &n.g,
                    id(&c.operation_id)?,
                    admission,
                    public,
                    &c.endpoint,
                    c.expires_at_unix,
                ),
                &c.signature,
            )?;
            let e = commit_admission(
                &mut store,
                &n,
                auth,
                counter(r.expected_management_epoch)?,
                id(&r.operation_id)?,
                Mutation::Admit {
                    id: admission,
                    key: public,
                    endpoint: c.endpoint.clone(),
                    consent: hash(
                        &Value::Array(vec![
                            b(consent_body(
                                &n.g,
                                id(&c.operation_id)?,
                                admission,
                                public,
                                &c.endpoint,
                                c.expires_at_unix,
                            )),
                            b(&c.signature),
                        ])
                        .encode(),
                    ),
                },
                c.expires_at_unix,
            )?;
            RpcResponse::AdmitClusterMember(wire_entry(&e))
        }
        RpcRequest::FinishClusterJoin(r) => RpcResponse::FinishClusterJoin(import(
            path,
            &r.history,
            Some(id(&r.operation_id)?),
            None,
            Some(auth),
        )?),
        RpcRequest::ApplyClusterHistory(r) => {
            RpcResponse::ApplyClusterHistory(import(path, &r.history, None, None, Some(auth))?)
        }
        RpcRequest::ActivateClusterPrimary(r) => RpcResponse::ActivateClusterPrimary(import(
            path,
            &r.history,
            None,
            Some(id(&r.operation_id)?),
            Some(auth),
        )?),
        RpcRequest::CancelClusterJoin(r) => {
            let (n, mut store) = opened(path)?;
            if id(&r.operation_id)? != n.operation {
                return Err(RuntimeError::InvalidState);
            }
            let tx = store
                .db
                .transaction_with_behavior(TransactionBehavior::Immediate)?;
            let current = load_node(&tx)?.ok_or(RuntimeError::InvalidState)?;
            if current.operation != n.operation
                || current.admission != n.admission
                || current.g != n.g
            {
                return Err(RuntimeError::Conflict);
            }
            authorize_transaction(&tx, &current, auth)?;
            let latest = replay(&current.g, &load(&tx, current.g.cluster())?)?;
            let prepared: bool = tx.query_row(
                "SELECT EXISTS(SELECT 1 FROM prepared WHERE epoch>=?1)",
                [latest.epoch],
                |r| r.get(0),
            )?;
            // Cancel only abandons a joining reservation. An admitted member
            // must use Leave; it cannot discard a durable transfer obligation.
            if current.phase == 2 || latest.primary == current.admission || prepared {
                return Err(RuntimeError::InvalidState);
            }
            tx.execute(
                "INSERT OR IGNORE INTO retired_local VALUES(?1,?2,?3)",
                params![n.operation, n.g.cluster(), n.admission],
            )?;
            tx.execute("UPDATE node SET phase=3 WHERE id=1 AND phase=1", [])?;
            tx.commit()?;
            RpcResponse::CancelClusterJoin(state(path)?)
        }
        RpcRequest::RemoveClusterMember(r) => {
            let (n, mut store) = opened(path)?;
            require_member(&n)?;
            let e = commit_authorized(
                &mut store,
                &n,
                auth,
                counter(r.expected_management_epoch)?,
                id(&r.operation_id)?,
                Mutation::Remove {
                    id: id(&r.admission_id)?,
                },
            )?;
            RpcResponse::RemoveClusterMember(wire_entry(&e))
        }
        RpcRequest::GetClusterRemovalProof(r) => {
            let (n, store) = opened(path)?;
            if id(&r.cluster_id)? != n.g.cluster() {
                return Err(RuntimeError::Unauthorized);
            }
            let (admission, public) = auth.peer.ok_or(RuntimeError::Unauthorized)?;
            RpcResponse::GetClusterRemovalProof(removal_proof(&store, admission, public)?)
        }
        RpcRequest::ReadClusterHistory(r) => {
            let (n, store) = opened(path)?;
            require_member(&n)?;
            if id(&r.cluster_id)? != n.g.cluster() {
                return Err(RuntimeError::InvalidProof);
            }
            RpcResponse::ReadClusterHistory(history(&store)?)
        }
        RpcRequest::PreparePrimaryTransfer(r) => {
            let (n, mut store) = opened(path)?;
            let op = id(&r.operation_id)?;
            let tx = store
                .db
                .transaction_with_behavior(TransactionBehavior::Immediate)?;
            let current = load_node(&tx)?.ok_or(RuntimeError::InvalidState)?;
            require_member(&current)?;
            authorize_transaction(&tx, &current, auth)?;
            if leaving(&tx, &current)? {
                return Err(RuntimeError::InvalidState);
            }
            let old:Option<(u64,Vec<u8>,Vec<u8>,u64,Vec<u8>)>=tx.query_row("SELECT epoch,target,acceptance,prefix_sequence,prefix_hash FROM prepared WHERE operation=?1",params![op],|r|Ok((r.get(0)?,r.get(1)?,r.get(2)?,r.get(3)?,r.get(4)?))).optional()?;
            let response = if let Some((epoch, target, signature, sequence, prefix)) = old {
                let entries = load(&tx, n.g.cluster())?;
                if sequence as usize > entries.len() {
                    return Err(RuntimeError::Storage);
                }
                let original = replay(&n.g, &entries[..sequence as usize])?;
                if original.epoch != epoch
                    || original.head.as_slice() != prefix
                    || !matches_head(&r.expected_head, &original)
                {
                    return Err(RuntimeError::Conflict);
                }
                ClusterTransferAcceptance {
                    operation_id: op.to_vec(),
                    expected_head: head(&original),
                    target_admission_id: target,
                    target_public_key: key(&n.pair).to_vec(),
                    signature,
                }
            } else {
                let s = replay(&n.g, &load(&tx, n.g.cluster())?)?;
                if !matches_head(&r.expected_head, &s) {
                    return Err(RuntimeError::InvalidProof);
                }
                let Mutation::Transfer {
                    id: target,
                    key: public,
                    acceptance,
                    ..
                } = prepare(&tx, &n.g, key(&n.pair), &n.pair, op)?
                else {
                    unreachable!()
                };
                ClusterTransferAcceptance {
                    operation_id: op.to_vec(),
                    expected_head: head(&s),
                    target_admission_id: target.to_vec(),
                    target_public_key: public.to_vec(),
                    signature: acceptance.to_vec(),
                }
            };
            tx.commit()?;
            RpcResponse::PreparePrimaryTransfer(response)
        }
        RpcRequest::SealPrimaryTransfer(r) => {
            let (n, mut store) = opened(path)?;
            require_member(&n)?;
            let a = r.acceptance;
            if id(&a.expected_head.cluster_id)? != n.g.cluster() {
                return Err(RuntimeError::InvalidProof);
            }
            if a.expected_head.sequence < 0 {
                return Err(RuntimeError::InvalidProof);
            }
            let e = commit_authorized(
                &mut store,
                &n,
                auth,
                counter(a.expected_head.management_epoch)?,
                id(&a.operation_id)?,
                Mutation::Transfer {
                    id: id(&a.target_admission_id)?,
                    key: id(&a.target_public_key)?,
                    prefix_sequence: a.expected_head.sequence as u64,
                    prefix_hash: id(&a.expected_head.entry_hash)?,
                    acceptance: a
                        .signature
                        .as_slice()
                        .try_into()
                        .map_err(|_| RuntimeError::InvalidProof)?,
                },
            )?;
            RpcResponse::SealPrimaryTransfer(wire_entry(&e))
        }
        _ => return Err(RuntimeError::InvalidState),
    })
}

#[cfg(all(test, not(windows)))]
mod auth_regression_tests {
    use super::*;
    fn auth() -> Authorized {
        Authorized {
            expires_at_unix: now() + 3600,
            client_id: "fixture".into(),
            peer: None,
        }
    }
    #[test]
    fn admission_expiring_while_waiting_for_writer_lock_is_not_committed() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("cluster.sqlite");
        initialize(&path, [1; 32], None, "https://primary/rieul/rpc").unwrap();
        let (n, mut store) = opened(&path).unwrap();
        let target = Ed25519KeyPair::from_seed_unchecked(&[9; 32]).unwrap();
        let mut writer = Connection::open(&path).unwrap();
        let held = writer
            .transaction_with_behavior(TransactionBehavior::Immediate)
            .unwrap();
        let (preflight_tx, preflight_rx) = std::sync::mpsc::channel();
        let (done_tx, done_rx) = std::sync::mpsc::channel();
        std::thread::scope(|scope| {
            scope.spawn(move || {
                let expires = now() + 2;
                let body = consent_body(
                    &n.g,
                    [2; 32],
                    [3; 32],
                    key(&target),
                    "https://target/rieul/rpc",
                    expires,
                );
                let proof = target.sign(&body);
                let mutation = Mutation::Admit {
                    id: [3; 32],
                    key: key(&target),
                    consent: hash(&Value::Array(vec![b(&body), b(proof.as_ref())]).encode()),
                    endpoint: "https://target/rieul/rpc".into(),
                };
                verify(key(&target), &body, proof.as_ref()).unwrap();
                assert!(expires > now());
                preflight_tx.send(expires).unwrap();
                done_tx
                    .send(commit_admission(
                        &mut store,
                        &n,
                        &auth(),
                        1,
                        [4; 32],
                        mutation,
                        expires,
                    ))
                    .unwrap();
            });
            let expires = preflight_rx.recv_timeout(Duration::from_secs(5)).unwrap();
            assert!(matches!(
                done_rx.recv_timeout(Duration::from_millis(100)),
                Err(std::sync::mpsc::RecvTimeoutError::Timeout)
            ));
            while now() < expires {
                std::thread::sleep(Duration::from_millis(10));
            }
            held.rollback().unwrap();
            assert!(matches!(
                done_rx.recv_timeout(Duration::from_secs(2)).unwrap(),
                Err(RuntimeError::Retired)
            ));
        });
        assert!(opened(&path).unwrap().1.entries().unwrap().is_empty());
    }
    #[test]
    fn expired_admission_only_replays_its_exact_existing_receipt() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("cluster.sqlite");
        initialize(&path, [1; 32], None, "https://primary/rieul/rpc").unwrap();
        let (n, mut store) = opened(&path).unwrap();
        let pair = Ed25519KeyPair::from_seed_unchecked(&[9; 32]).unwrap();
        let mutation = Mutation::Admit {
            id: [2; 32],
            key: key(&pair),
            consent: [3; 32],
            endpoint: "https://target/rieul/rpc".into(),
        };
        let expires = now() + 1;
        let first = commit_admission(
            &mut store,
            &n,
            &auth(),
            1,
            [4; 32],
            mutation.clone(),
            expires,
        )
        .unwrap();
        while now() < expires {
            std::thread::sleep(Duration::from_millis(10));
        }
        let replayed = commit_admission(
            &mut store,
            &n,
            &auth(),
            1,
            [4; 32],
            mutation.clone(),
            expires,
        )
        .unwrap();
        assert_eq!(first, replayed);
        let mut altered = mutation;
        if let Mutation::Admit { endpoint, .. } = &mut altered {
            *endpoint = "https://different/rieul/rpc".into();
        }
        assert!(matches!(
            commit_admission(&mut store, &n, &auth(), 1, [4; 32], altered, expires),
            Err(RuntimeError::Conflict)
        ));
        assert_eq!(store.entries().unwrap().len(), 1);
    }
    #[test]
    fn removed_peer_cannot_prepare_or_import_even_with_previously_authenticated_identity() {
        let d = tempfile::tempdir().unwrap();
        let path = d.path().join("cluster.sqlite");
        initialize(&path, [1; 32], None, "https://fixture/rieul/rpc").unwrap();
        let (n, mut store) = opened(&path).unwrap();
        let peer_pair = Ed25519KeyPair::from_seed_unchecked(&[9; 32]).unwrap();
        let member = [2; 32];
        store
            .commit(
                &n.pair,
                1,
                [3; 32],
                Mutation::Admit {
                    id: member,
                    key: key(&peer_pair),
                    consent: [0; 32],
                    endpoint: "https://peer/rieul/rpc".into(),
                },
            )
            .unwrap();
        let stale = Authorized {
            peer: Some((member, key(&peer_pair))),
            ..auth()
        };
        store
            .commit(&n.pair, 1, [4; 32], Mutation::Remove { id: member })
            .unwrap();
        let h = history(&store).unwrap();
        assert!(removal_proof(&store, member, [0; 32]).is_err());
        assert!(removal_proof(&store, [99; 32], key(&peer_pair)).is_err());
        assert_eq!(
            removal_proof(&store, member, key(&peer_pair)).unwrap().head,
            h.head
        );
        assert!(matches!(
            execute(
                &path,
                &stale,
                RpcRequest::PreparePrimaryTransfer(PreparePrimaryTransferReq {
                    operation_id: vec![5; 32],
                    expected_head: h.head.clone()
                }),
                "https://fixture/rieul/rpc"
            ),
            Err(RuntimeError::Unauthorized)
        ));
        assert!(matches!(
            import(&path, &h, None, None, Some(&stale)),
            Err(RuntimeError::Unauthorized)
        ));
        assert_eq!(history(&opened(&path).unwrap().1).unwrap().head, h.head);
    }
    #[test]
    fn admitted_member_cancel_cannot_retire_a_transfer_target() {
        let d = tempfile::tempdir().unwrap();
        let a = d.path().join("a");
        let bpath = d.path().join("b");
        initialize(&a, [1; 32], None, "https://a/rieul/rpc").unwrap();
        let (an, mut ast) = opened(&a).unwrap();
        initialize(&bpath, [2; 32], Some(an.g.clone()), "https://b/rieul/rpc").unwrap();
        let (bn, _) = opened(&bpath).unwrap();
        ast.commit(
            &an.pair,
            1,
            [3; 32],
            Mutation::Admit {
                id: bn.admission,
                key: key(&bn.pair),
                consent: join::consent_digest(&consent(&bn)).unwrap(),
                endpoint: bn.endpoint.clone(),
            },
        )
        .unwrap();
        import(
            &bpath,
            &history(&ast).unwrap(),
            Some([2; 32]),
            None,
            Some(&auth()),
        )
        .unwrap();
        let (_, mut bst) = opened(&bpath).unwrap();
        let transfer = bst.prepare_transfer(&bn.pair, [4; 32]).unwrap();
        assert!(matches!(
            request_leave(&bpath, &auth(), [5; 32]),
            Err(RuntimeError::InvalidState)
        ));
        assert!(matches!(
            execute(
                &bpath,
                &auth(),
                RpcRequest::CancelClusterJoin(CancelClusterJoinReq {
                    operation_id: vec![2; 32]
                }),
                &bn.endpoint
            ),
            Err(RuntimeError::InvalidState)
        ));
        ast.commit(&an.pair, 1, [4; 32], transfer).unwrap();
        let transferred = history(&ast).unwrap();
        let barrier = std::sync::Barrier::new(2);
        let (activation, cancel) = std::thread::scope(|scope| {
            let a = scope.spawn(|| {
                barrier.wait();
                import(&bpath, &transferred, None, Some([4; 32]), Some(&auth()))
            });
            let b = scope.spawn(|| {
                barrier.wait();
                execute(
                    &bpath,
                    &auth(),
                    RpcRequest::CancelClusterJoin(CancelClusterJoinReq {
                        operation_id: vec![2; 32],
                    }),
                    &bn.endpoint,
                )
            });
            (a.join().unwrap(), b.join().unwrap())
        });
        activation.unwrap();
        assert!(matches!(cancel, Err(RuntimeError::InvalidState)));
        assert!(matches!(
            execute(
                &bpath,
                &auth(),
                RpcRequest::CancelClusterJoin(CancelClusterJoinReq {
                    operation_id: vec![2; 32]
                }),
                &bn.endpoint
            ),
            Err(RuntimeError::InvalidState)
        ));
        assert_eq!(opened(&bpath).unwrap().0.phase, 2);
    }
}

#[cfg(all(test, windows))]
mod windows_enrollment_tests {
    use super::*;
    #[test]
    fn enrollment_is_disabled_before_creating_key_database() {
        assert!(!ENROLLMENT_SUPPORTED);
        let d = tempfile::tempdir().unwrap();
        let path = d.path().join("cluster.sqlite");
        assert!(matches!(
            initialize(&path, [1; 32], None, "https://fixture/rieul/rpc"),
            Err(RuntimeError::InvalidState)
        ));
        assert!(!path.exists());
    }
}
