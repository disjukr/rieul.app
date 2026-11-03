//! Connection-bound client proof; a signed adoption is not itself a bearer token.
use super::*;

#[derive(Clone, Debug)]
pub(crate) struct Principal {
    cluster: Id,
    node: Id,
    node_key: Id,
    grant: Id,
    client: Id,
    epoch: u64,
    sequence: u64,
}
impl Principal {
    pub(crate) fn origin(&self) -> ClusterOriginalPrincipal {
        ClusterOriginalPrincipal::ClusterGrant {
            cluster_id: self.cluster.to_vec(),
            grant_id: self.grant.to_vec(),
            client_public_key: self.client.to_vec(),
        }
    }
    pub(crate) fn subject(&self) -> String {
        fn hex(id: Id) -> String {
            id.iter().map(|b| format!("{b:02x}")).collect()
        }
        format!(
            "cluster:{}:{}:{}",
            hex(self.cluster),
            hex(self.node),
            hex(self.grant)
        )
    }
    pub(super) fn check(&self, n: &Node, state: &State) -> Result<i64, RuntimeError> {
        require_member(n)?;
        if self.cluster != n.g.cluster()
            || self.node != n.admission
            || self.node_key != key(&n.pair)
            || state.members.get(&self.node) != Some(&self.node_key)
            || state.epoch < self.epoch
            || state.sequence < self.sequence
            || state.revoked.contains(&self.grant)
        {
            return Err(RuntimeError::Unauthorized);
        }
        let grant = state
            .grants
            .get(&self.grant)
            .ok_or(RuntimeError::Unauthorized)?;
        if grant.client != self.client || grant.expires <= now() as u64 {
            return Err(RuntimeError::Unauthorized);
        }
        Ok(grant.expires as i64)
    }
}
// Explicit canonical transcript shared with browser; no BDL reserialization.
pub(crate) fn proof_body(r: &AuthenticateClusterClientReq) -> Result<Vec<u8>, RuntimeError> {
    if r.known_head.sequence < 0 || r.known_head.sequence as u64 > MAX_COUNTER {
        return Err(RuntimeError::InvalidProof);
    }
    Ok(Value::Array(vec![
        Value::Text("rieul.cluster.client-session.v1".into()),
        b(id(&r.known_head.cluster_id)?),
        Value::U64(counter(r.known_head.management_epoch)?),
        Value::U64(r.known_head.sequence as u64),
        b(id(&r.known_head.entry_hash)?),
        b(id(&r.known_head.primary_admission_id)?),
        b(id(&r.server_admission_id)?),
        b(id(&r.server_public_key)?),
        b(id(&r.grant_id)?),
        b(id(&r.client_public_key)?),
        b(id(&r.nonce)?),
        Value::U64(counter(r.connection_id)?),
    ])
    .encode())
}
pub(crate) fn authenticate(
    path: &Path,
    r: &AuthenticateClusterClientReq,
) -> Result<(Principal, ClusterHistory), RuntimeError> {
    let (n, store) = opened(path)?;
    let entries = store.entries()?;
    let state = replay(&n.g, &entries)?;
    let principal = Principal {
        cluster: id(&r.known_head.cluster_id)?,
        node: id(&r.server_admission_id)?,
        node_key: id(&r.server_public_key)?,
        grant: id(&r.grant_id)?,
        client: id(&r.client_public_key)?,
        epoch: counter(r.known_head.management_epoch)?,
        sequence: u64::try_from(r.known_head.sequence).map_err(|_| RuntimeError::InvalidProof)?,
    };
    principal.check(&n, &state)?;
    // The client's pinned prefix must exist exactly; no cross-cluster or fork fallback.
    if principal.sequence > entries.len() as u64
        || !matches_head(
            &r.known_head,
            &replay(&n.g, &entries[..principal.sequence as usize])?,
        )
    {
        return Err(RuntimeError::InvalidProof);
    }
    verify(principal.client, &proof_body(r)?, &r.signature)?;
    Ok((
        principal,
        ClusterHistory {
            head: head(&state),
            genesis: wire_genesis(&n.g),
            entries: entries.iter().map(wire_entry).collect(),
        },
    ))
}
// Live authorization must not take a writer lock just to initialize an already
// enrolled store. Read identity, node and signed log in one consistent snapshot.
fn authorization_snapshot(path: &Path) -> Result<(Node, State), RuntimeError> {
    safe_file(path, false)?;
    let mut db = Connection::open_with_flags(path, rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY)?;
    db.busy_timeout(Duration::from_secs(5))?;
    let tx = db.transaction_with_behavior(TransactionBehavior::Deferred)?;
    let node = load_node(&tx)?.ok_or(RuntimeError::InvalidState)?;
    let identity: (Vec<u8>, Vec<u8>) =
        tx.query_row("SELECT cluster,local FROM identity WHERE id=1", [], |r| {
            Ok((r.get(0)?, r.get(1)?))
        })?;
    if identity.0 != node.g.cluster() || identity.1 != key(&node.pair) {
        return Err(RuntimeError::InvalidProof);
    }
    let state = replay(&node.g, &load(&tx, node.g.cluster())?)?;
    tx.commit()?;
    Ok((node, state))
}
pub(crate) fn validate(path: &Path, principal: &Principal) -> Result<i64, RuntimeError> {
    let (n, state) = authorization_snapshot(path)?;
    principal.check(&n, &state)
}
/// Current subjects for Screen's global attachment expiry, never persisted credentials.
pub(crate) fn subjects(path: &Path) -> Result<Vec<String>, RuntimeError> {
    let (n, state) = authorization_snapshot(path)?;
    Ok(state
        .grants
        .keys()
        .filter_map(|grant| {
            let p = Principal {
                cluster: n.g.cluster(),
                node: n.admission,
                node_key: key(&n.pair),
                grant: *grant,
                client: state.grants[grant].client,
                epoch: state.epoch,
                sequence: state.sequence,
            };
            p.check(&n, &state).ok().map(|_| p.subject())
        })
        .collect())
}

#[cfg(test)]
mod tests {
    use super::*;
    fn fixture() -> (
        tempfile::TempDir,
        std::path::PathBuf,
        AuthenticateClusterClientReq,
        Ed25519KeyPair,
    ) {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("cluster.sqlite");
        initialize(&path, [1; 32], None, "https://fixture/rieul/rpc").unwrap();
        let (n, mut store) = opened(&path).unwrap();
        let client = Ed25519KeyPair::from_seed_unchecked(&[9; 32]).unwrap();
        let expires = now() as u64 + 3600;
        let client_proof: [u8; 64] = client
            .sign(&client_adoption_body(
                n.g.cluster(),
                [2; 32],
                n.admission,
                key(&client),
                expires,
            ))
            .as_ref()
            .try_into()
            .unwrap();
        let issuer_proof = n
            .pair
            .sign(&issuer_adoption_body(
                n.g.cluster(),
                [2; 32],
                n.admission,
                key(&client),
                expires,
                &client_proof,
            ))
            .as_ref()
            .try_into()
            .unwrap();
        let auth = Authorized {
            expires_at_unix: now() + 3600,
            client_id: "fixture".into(),
            peer: None,
            grant: None,
        };
        commit_authorized(
            &mut store,
            &n,
            &auth,
            1,
            [3; 32],
            Mutation::Adopt {
                grant: [2; 32],
                issuer: n.admission,
                client: key(&client),
                expires,
                client_proof,
                issuer_proof,
            },
        )
        .unwrap();
        let mut r = AuthenticateClusterClientReq {
            known_head: head(&store.state().unwrap()),
            server_admission_id: n.admission.to_vec(),
            server_public_key: key(&n.pair).to_vec(),
            grant_id: vec![2; 32],
            client_public_key: key(&client).to_vec(),
            nonce: vec![4; 32],
            connection_id: 1,
            signature: vec![],
        };
        r.signature = client.sign(&proof_body(&r).unwrap()).as_ref().to_vec();
        (dir, path, r, client)
    }
    #[test]
    fn live_authorization_reads_committed_snapshot_without_waiting_for_writer() {
        let (_d, path, request, _) = fixture();
        let (principal, _) = authenticate(&path, &request).unwrap();
        let mut writer = Connection::open(&path).unwrap();
        let held = writer
            .transaction_with_behavior(TransactionBehavior::Immediate)
            .unwrap();
        // Same-thread held writer would make a hidden INSERT time out. A reader
        // sees the committed grant; write authorization still rechecks on commit.
        assert!(validate(&path, &principal).is_ok());
        assert_eq!(subjects(&path).unwrap(), vec![principal.subject()]);
        held.rollback().unwrap();
        writer
            .execute("UPDATE identity SET local=?1", params![[8u8; 32]])
            .unwrap();
        assert!(validate(&path, &principal).is_err());
        assert!(subjects(&path).is_err());
    }
    #[test]
    fn client_proof_binds_cluster_node_grant_key_head_and_connection() {
        let (_d, path, r, _) = fixture();
        assert!(authenticate(&path, &r).is_ok());
        for field in 0..11 {
            let mut bad = r.clone();
            match field {
                0 => bad.known_head.cluster_id[0] ^= 1,
                1 => bad.server_admission_id[0] ^= 1,
                2 => bad.server_public_key[0] ^= 1,
                3 => bad.grant_id[0] ^= 1,
                4 => bad.client_public_key[0] ^= 1,
                5 => bad.known_head.entry_hash[0] ^= 1,
                6 => bad.known_head.management_epoch += 1,
                7 => bad.known_head.sequence = 0,
                8 => bad.known_head.primary_admission_id[0] ^= 1,
                9 => bad.connection_id += 1,
                _ => bad.nonce[0] ^= 1,
            }
            assert!(authenticate(&path, &bad).is_err(), "field {field}");
        }
    }
    #[test]
    fn revocation_is_rechecked_in_write_transaction_and_for_live_subjects() {
        let (_d, path, r, _) = fixture();
        let (principal, _) = authenticate(&path, &r).unwrap();
        assert_eq!(subjects(&path).unwrap(), vec![principal.subject()]);
        let (n, mut store) = opened(&path).unwrap();
        let paired = Authorized {
            expires_at_unix: now() + 3600,
            client_id: "paired".into(),
            peer: None,
            grant: None,
        };
        let granted = Authorized {
            expires_at_unix: now() + 3600,
            client_id: principal.subject(),
            peer: None,
            grant: Some(principal.clone()),
        };
        commit_authorized(
            &mut store,
            &n,
            &paired,
            1,
            [5; 32],
            Mutation::Revoke { grant: [2; 32] },
        )
        .unwrap();
        assert!(validate(&path, &principal).is_err());
        assert!(subjects(&path).unwrap().is_empty());
        assert!(authenticate(&path, &r).is_err());
        let before = store.entries().unwrap();
        assert!(matches!(
            commit_authorized(
                &mut store,
                &n,
                &granted,
                1,
                [6; 32],
                Mutation::Revoke { grant: [7; 32] }
            ),
            Err(RuntimeError::Unauthorized)
        ));
        assert_eq!(before, store.entries().unwrap());
    }
    #[test]
    fn revoked_grant_cannot_be_laundered_through_stale_member_envelope() {
        let (dir, path, r, pair) = fixture();
        let bpath = dir.path().join("replica.sqlite");
        let (n, mut a) = opened(&path).unwrap();
        initialize(
            &bpath,
            [10; 32],
            Some(n.g.clone()),
            "https://replica/rieul/rpc",
        )
        .unwrap();
        let (bn, mut replica) = opened(&bpath).unwrap();
        let paired = Authorized {
            expires_at_unix: now() + 3600,
            client_id: "paired".into(),
            peer: None,
            grant: None,
        };
        commit_authorized(
            &mut a,
            &n,
            &paired,
            1,
            [11; 32],
            Mutation::Admit {
                id: bn.admission,
                key: key(&bn.pair),
                consent: [12; 32],
                endpoint: bn.endpoint.clone(),
            },
        )
        .unwrap();
        replica.install_history(&a.entries().unwrap()).unwrap();
        replica
            .db
            .execute("UPDATE node SET phase=2 WHERE id=1", [])
            .unwrap();
        let challenge = peer::challenge(&path, 1, [13; 32]).unwrap();
        let original = ClusterOriginalPrincipal::ClusterGrant {
            cluster_id: n.g.cluster().to_vec(),
            grant_id: r.grant_id.clone(),
            client_public_key: r.client_public_key.clone(),
        };
        let request = peer::sign(
            &bpath,
            key(&n.pair),
            &challenge,
            ProcId::RemoveClusterMember,
            RemoveClusterMemberReq {
                operation_id: vec![14; 32],
                expected_management_epoch: 1,
                admission_id: vec![15; 32],
            }
            .encode(),
            original,
        )
        .unwrap();
        let authorized_before_revoke = peer::authenticate(&path, &request).unwrap();
        assert!(authorized_before_revoke.grant.is_some());
        let mut tampered = request.clone();
        tampered.original_principal = ClusterOriginalPrincipal::LocalPairing {
            client_id: "paired".into(),
        };
        assert!(peer::authenticate(&path, &tampered).is_err());
        commit_authorized(
            &mut a,
            &n,
            &paired,
            1,
            [16; 32],
            Mutation::Revoke { grant: [2; 32] },
        )
        .unwrap();
        let mut stale = r;
        stale.known_head = head(&replica.state().unwrap());
        stale.server_admission_id = bn.admission.to_vec();
        stale.server_public_key = key(&bn.pair).to_vec();
        stale.signature = pair.sign(&proof_body(&stale).unwrap()).as_ref().to_vec();
        assert!(
            authenticate(&bpath, &stale).is_ok(),
            "replica has not learned revocation"
        );
        assert!(matches!(
            peer::authenticate(&path, &request),
            Err(RuntimeError::Unauthorized)
        ));
        let before = a.entries().unwrap();
        assert!(matches!(
            commit_authorized(
                &mut a,
                &n,
                &authorized_before_revoke,
                1,
                [14; 32],
                Mutation::Remove { id: [15; 32] }
            ),
            Err(RuntimeError::Unauthorized)
        ));
        assert_eq!(before, a.entries().unwrap());
    }
    #[test]
    fn changed_incarnation_removed_node_expiry_and_rollback_fail_closed() {
        let (_d, path, r, _) = fixture();
        let (principal, _) = authenticate(&path, &r).unwrap();
        let (mut n, store) = opened(&path).unwrap();
        let mut state = store.state().unwrap();
        n.admission[0] ^= 1;
        assert!(principal.check(&n, &state).is_err());
        n.admission[0] ^= 1;
        state.members.remove(&n.admission);
        assert!(principal.check(&n, &state).is_err());
        state.members.insert(n.admission, key(&n.pair));
        state.grants.get_mut(&[2; 32]).unwrap().expires = now() as u64;
        assert!(principal.check(&n, &state).is_err());
        assert!(principal.check(&n, &State::genesis(&n.g)).is_err());
    }
}

pub(super) fn forwarded(n: &Node, cluster: Id, grant: Id, client: Id) -> Principal {
    Principal {
        cluster,
        grant,
        client,
        node: n.admission,
        node_key: key(&n.pair),
        epoch: 1,
        sequence: 0,
    }
}
