//! A consent-bound bootstrap read, never a general management session.
use super::*;

pub(super) fn consent_digest(c: &ClusterJoinConsent) -> Result<Id, RuntimeError> {
    Ok(hash(
        &Value::Array(vec![
            b(consent_body(
                &genesis(&c.genesis)?,
                id(&c.operation_id)?,
                id(&c.admission_id)?,
                id(&c.node_public_key)?,
                &c.endpoint,
                c.expires_at_unix,
            )),
            b(&c.signature),
        ])
        .encode(),
    ))
}
fn body(
    c: &ClusterJoinConsent,
    server: Id,
    connection: u64,
    nonce: Id,
) -> Result<Vec<u8>, RuntimeError> {
    Ok(Value::Array(vec![
        Value::Text("rieul.cluster.join-read.v1".into()),
        b(genesis(&c.genesis)?.cluster()),
        b(server),
        b(consent_digest(c)?),
        Value::U64(connection),
        b(nonce),
    ])
    .encode())
}
fn live(n: &Node) -> Result<(), RuntimeError> {
    if n.phase != 1 || n.consent_expires <= now() {
        return Err(RuntimeError::Retired);
    }
    Ok(())
}
pub(super) fn verify_admission(n: &Node, entries: &[Entry]) -> Result<(), RuntimeError> {
    let expected = consent_digest(&consent(n))?;
    if !entries.iter().any(|e| matches!(e.mutation, Mutation::Admit{id,key:public,consent,..} if id==n.admission && public==key(&n.pair) && consent==expected)) {
        return Err(RuntimeError::InvalidProof);
    }
    Ok(())
}
pub(super) fn configure(
    path: &Path,
    auth: &Authorized,
    r: ConfigureClusterJoinSyncReq,
) -> Result<ClusterState, RuntimeError> {
    let (n, mut store) = opened(path)?;
    let entries = decoded_history(&r.bootstrap_history, &n.g)?;
    let next = replay(&n.g, &entries)?;
    let tx = store
        .db
        .transaction_with_behavior(TransactionBehavior::Immediate)?;
    let current = load_node(&tx)?.ok_or(RuntimeError::InvalidState)?;
    if current.g != n.g
        || current.admission != n.admission
        || current.operation != id(&r.operation_id)?
    {
        return Err(RuntimeError::Conflict);
    }
    live(&current)?;
    authorize_transaction(&tx, &current, auth)?;
    if next.members.contains_key(&current.admission) {
        verify_admission(&current, &entries)?;
    }
    install(&tx, &current.g, key(&current.pair), &entries)?;
    if next.seen.contains(&current.admission) && !next.members.contains_key(&current.admission) {
        tx.execute("UPDATE node SET phase=4 WHERE id=1", [])?;
        tx.execute(
            "INSERT OR IGNORE INTO retired_local VALUES(?1,?2,?3)",
            params![current.operation, current.g.cluster(), current.admission],
        )?;
    } else {
        tx.execute("UPDATE node_join_scope SET sync_enabled=1 WHERE id=1", [])?;
    }
    tx.commit()?;
    state(path)
}
pub(crate) fn sign(
    path: &Path,
    server: Id,
    challenge: &ClusterPeerChallenge,
) -> Result<ReadClusterJoinHistoryReq, RuntimeError> {
    let (n, store) = opened(path)?;
    live(&n)?;
    let enabled: bool = store.db.query_row(
        "SELECT sync_enabled FROM node_join_scope WHERE id=1",
        [],
        |r| r.get(0),
    )?;
    if !enabled || !store.state()?.members.values().any(|key| *key == server) {
        return Err(RuntimeError::Unauthorized);
    }
    let connection = counter(challenge.connection_id)?;
    let nonce = id(&challenge.nonce)?;
    verify(
        server,
        &peer::server_body(n.g.cluster(), server, connection, nonce),
        &challenge.server_proof,
    )?;
    let consent = consent(&n);
    let signature = n
        .pair
        .sign(&body(&consent, server, connection, nonce)?)
        .as_ref()
        .to_vec();
    Ok(ReadClusterJoinHistoryReq {
        consent,
        nonce: nonce.to_vec(),
        connection_id: challenge.connection_id,
        signature,
    })
}
pub(crate) fn read(
    path: &Path,
    r: ReadClusterJoinHistoryReq,
) -> Result<ClusterHistory, RuntimeError> {
    let (n, mut store) = opened(path)?;
    let tx = store
        .db
        .transaction_with_behavior(TransactionBehavior::Deferred)?;
    let current = load_node(&tx)?.ok_or(RuntimeError::InvalidState)?;
    if current.g != n.g {
        return Err(RuntimeError::Conflict);
    }
    require_member(&current)?;
    let c = &r.consent;
    if genesis(&c.genesis)? != current.g
        || c.expires_at_unix <= now()
        || c.expires_at_unix > now() + 600
    {
        return Err(RuntimeError::Unauthorized);
    }
    let admission = id(&c.admission_id)?;
    let public = id(&c.node_public_key)?;
    verify(
        public,
        &consent_body(
            &current.g,
            id(&c.operation_id)?,
            admission,
            public,
            &c.endpoint,
            c.expires_at_unix,
        ),
        &c.signature,
    )?;
    verify(
        public,
        &body(
            c,
            key(&current.pair),
            counter(r.connection_id)?,
            id(&r.nonce)?,
        )?,
        &r.signature,
    )?;
    let entries = load(&tx, current.g.cluster())?;
    let state = replay(&current.g, &entries)?;
    let digest = consent_digest(c)?;
    if state.members.get(&admission)!=Some(&public) || !entries.iter().any(|e|matches!(e.mutation,Mutation::Admit{id,key,consent,..} if id==admission && key==public && consent==digest)) { return Err(RuntimeError::Unauthorized); }
    Ok(ClusterHistory {
        genesis: wire_genesis(&current.g),
        entries: entries.iter().map(wire_entry).collect(),
        head: head(&state),
    })
}
pub(super) fn configured(path: &Path) -> Result<bool, RuntimeError> {
    let (n, store) = opened(path)?;
    Ok(n.phase == 1
        && store
            .db
            .query_row(
                "SELECT sync_enabled FROM node_join_scope WHERE id=1",
                [],
                |r| r.get::<_, bool>(0),
            )
            .optional()?
            .unwrap_or(false))
}
pub(super) fn routes(path: &Path, cursor: &mut usize) -> Result<Vec<(Id, String)>, RuntimeError> {
    let (n, store) = opened(path)?;
    live(&n)?;
    let state = store.state()?;
    let primary = *state
        .members
        .get(&state.primary)
        .ok_or(RuntimeError::InvalidProof)?;
    let endpoint = state
        .endpoints
        .get(&state.primary)
        .cloned()
        .ok_or(RuntimeError::InvalidProof)?;
    let peers: Vec<_> = state
        .members
        .iter()
        .filter(|(id, _)| **id != state.primary && **id != n.admission)
        .map(|(id, key)| {
            Ok((
                *key,
                state
                    .endpoints
                    .get(id)
                    .cloned()
                    .ok_or(RuntimeError::InvalidProof)?,
            ))
        })
        .collect::<Result<_, RuntimeError>>()?;
    let mut result = vec![(primary, endpoint)];
    if !peers.is_empty() {
        let start = *cursor % peers.len();
        let count = peers.len().min(3);
        result.extend((0..count).map(|i| peers[(start + i) % peers.len()].clone()));
        *cursor = (start + count) % peers.len();
    }
    Ok(result)
}

#[cfg(all(test, not(windows)))]
mod tests {
    use super::*;
    fn auth() -> Authorized {
        Authorized {
            expires_at_unix: now() + 3600,
            client_id: "fixture".into(),
            grant: None,
            peer: None,
        }
    }
    fn setup() -> (tempfile::TempDir, std::path::PathBuf, std::path::PathBuf) {
        let dir = tempfile::tempdir().unwrap();
        let a = dir.path().join("a");
        let bpath = dir.path().join("b");
        initialize(&a, [1; 32], None, "https://a/rieul/rpc").unwrap();
        let (an, ast) = opened(&a).unwrap();
        initialize(&bpath, [2; 32], Some(an.g.clone()), "https://b/rieul/rpc").unwrap();
        configure(
            &bpath,
            &auth(),
            ConfigureClusterJoinSyncReq {
                operation_id: vec![2; 32],
                bootstrap_history: history(&ast).unwrap(),
            },
        )
        .unwrap();
        (dir, a, bpath)
    }
    fn request(n: &Node, server: Id) -> ReadClusterJoinHistoryReq {
        let c = consent(n);
        let signature = n
            .pair
            .sign(&body(&c, server, 1, [7; 32]).unwrap())
            .as_ref()
            .to_vec();
        ReadClusterJoinHistoryReq {
            consent: c,
            nonce: vec![7; 32],
            connection_id: 1,
            signature,
        }
    }
    #[test]
    fn consent_scope_does_not_replay_as_peer_authority_and_removal_blocks_reads() {
        let (_dir, a, bpath) = setup();
        let (an, mut ast) = opened(&a).unwrap();
        let (bn, _) = opened(&bpath).unwrap();
        let c = consent(&bn);
        execute(
            &a,
            &auth(),
            RpcRequest::AdmitClusterMember(AdmitClusterMemberReq {
                operation_id: vec![3; 32],
                expected_management_epoch: 1,
                consent: c.clone(),
            }),
            &an.endpoint,
        )
        .unwrap();
        let valid = request(&bn, key(&an.pair));
        assert!(read(&a, valid.clone()).is_ok());
        let peer_request = ClusterPeerRequest {
            cluster_id: an.g.cluster().to_vec(),
            sender_admission_id: bn.admission.to_vec(),
            sender_public_key: key(&bn.pair).to_vec(),
            nonce: valid.nonce.clone(),
            connection_id: 1,
            procedure_id: ProcId::ReadClusterHistory.as_u64() as i64,
            payload: ReadClusterHistoryReq {
                cluster_id: an.g.cluster().to_vec(),
            }
            .encode(),
            original_principal: ClusterOriginalPrincipal::Node,
            signature: valid.signature.clone(),
        };
        assert!(peer::authenticate(&a, &peer_request).is_err());
        let mut changed = valid.clone();
        changed.consent.operation_id = vec![9; 32];
        changed.consent.signature = bn
            .pair
            .sign(&consent_body(
                &bn.g,
                [9; 32],
                bn.admission,
                key(&bn.pair),
                &bn.endpoint,
                bn.consent_expires,
            ))
            .as_ref()
            .to_vec();
        changed.signature = bn
            .pair
            .sign(&body(&changed.consent, key(&an.pair), 1, [7; 32]).unwrap())
            .as_ref()
            .to_vec();
        assert!(read(&a, changed).is_err());
        ast.commit(&an.pair, 1, [4; 32], Mutation::Remove { id: bn.admission })
            .unwrap();
        assert!(read(&a, valid).is_err());
    }
    #[test]
    fn expired_consent_cannot_admit_read_sign_or_finish() {
        let (_dir, a, bpath) = setup();
        let (an, mut ast) = opened(&a).unwrap();
        let (_, bst) = opened(&bpath).unwrap();
        bst.db
            .execute(
                "UPDATE node_join_scope SET expires=?1 WHERE id=1",
                [now() - 1],
            )
            .unwrap();
        let (bn, _) = opened(&bpath).unwrap();
        let c = consent(&bn);
        assert!(matches!(
            execute(
                &a,
                &auth(),
                RpcRequest::AdmitClusterMember(AdmitClusterMemberReq {
                    operation_id: vec![3; 32],
                    expected_management_epoch: 1,
                    consent: c.clone()
                }),
                &an.endpoint
            ),
            Err(RuntimeError::Retired)
        ));
        // Model a historically accepted record whose consent subsequently expired.
        ast.commit(
            &an.pair,
            1,
            [3; 32],
            Mutation::Admit {
                id: bn.admission,
                key: key(&bn.pair),
                consent: consent_digest(&c).unwrap(),
                endpoint: bn.endpoint.clone(),
            },
        )
        .unwrap();
        assert!(read(&a, request(&bn, key(&an.pair))).is_err());
        let challenge = peer::challenge(&a, 1, [7; 32]).unwrap();
        assert!(sign(&bpath, key(&an.pair), &challenge).is_err());
        assert!(matches!(
            import(
                &bpath,
                &history(&ast).unwrap(),
                Some(bn.operation),
                None,
                Some(&auth())
            ),
            Err(RuntimeError::Retired)
        ));
        assert_eq!(opened(&bpath).unwrap().0.phase, 1);
    }
}
