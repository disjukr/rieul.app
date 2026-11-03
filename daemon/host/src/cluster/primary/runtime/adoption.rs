//! Durable public-key adoption outbox. No client secret/private key is stored here.
use super::*;
const MAX_OUTBOX: usize = 128;
struct Pending {
    challenge: ClusterClientAdoptionChallenge,
    client_proof: Option<Vec<u8>>,
    issuer_proof: Option<Vec<u8>>,
}
fn schema(db: &Connection) -> Result<(), RuntimeError> {
    db.execute_batch("CREATE TABLE IF NOT EXISTS adoption_outbox(grant_id BLOB PRIMARY KEY,owner TEXT NOT NULL,cluster BLOB NOT NULL,issuer BLOB NOT NULL,client BLOB NOT NULL,expires INTEGER NOT NULL,client_proof BLOB,issuer_proof BLOB,attempt_epoch INTEGER);")?;
    db.execute_batch("CREATE TABLE IF NOT EXISTS adoption_cancelled(grant_id BLOB PRIMARY KEY); CREATE TABLE IF NOT EXISTS adoption_receipts AS SELECT * FROM adoption_outbox WHERE 0; CREATE UNIQUE INDEX IF NOT EXISTS adoption_receipt_id ON adoption_receipts(grant_id);")?;
    Ok(())
}
// Queue capacity covers unresolved work only. Completed owner bindings live in
// a separate receipt cache, bounded by the journal's maximum accepted grants.
fn maintain(tx: &Transaction<'_>, n: &Node, state: &State) -> Result<(), RuntimeError> {
    tx.execute(
        "DELETE FROM adoption_outbox WHERE expires<=?1 OR ((cluster!=?2 OR issuer!=?3) AND grant_id NOT IN(SELECT grant_id FROM adoption_cancelled))",
        params![now(), n.g.cluster(), n.admission],
    )?;
    tx.execute(
        "DELETE FROM adoption_receipts WHERE expires<=?1 OR cluster!=?2",
        params![now(), n.g.cluster()],
    )?;
    let rows: Vec<Vec<u8>> = tx
        .prepare("SELECT grant_id FROM adoption_outbox WHERE cluster=?1")?
        .query_map(params![n.g.cluster()], |r| r.get(0))?
        .collect::<Result<_, _>>()?;
    for raw in rows {
        let grant = id(&raw)?;
        if state.revoked.contains(&grant)
            || state.grants.contains_key(&grant) && !cancelled(tx, grant)?
        {
            tx.execute("INSERT OR IGNORE INTO adoption_receipts SELECT * FROM adoption_outbox WHERE grant_id=?1",params![grant])?;
            tx.execute(
                "DELETE FROM adoption_outbox WHERE grant_id=?1",
                params![grant],
            )?;
            tx.execute(
                "DELETE FROM adoption_cancelled WHERE grant_id=?1",
                params![grant],
            )?;
        }
    }
    tx.execute("DELETE FROM adoption_cancelled WHERE grant_id NOT IN(SELECT grant_id FROM adoption_outbox)",[])?;
    let receipts: i64 = tx.query_row("SELECT COUNT(*) FROM adoption_receipts", [], |r| r.get(0))?;
    if receipts as usize > MAX_HISTORY {
        return Err(RuntimeError::Limit);
    }
    Ok(())
}
fn cancelled(db: &Connection, grant: Id) -> Result<bool, RuntimeError> {
    Ok(db.query_row(
        "SELECT EXISTS(SELECT 1 FROM adoption_cancelled WHERE grant_id=?1)",
        params![grant],
        |r| r.get(0),
    )?)
}
pub(super) fn cancel_inactive(path: &Path, active: &[String]) -> Result<(), RuntimeError> {
    let (n, mut store) = opened(path)?;
    schema(&store.db)?;
    let tx = store
        .db
        .transaction_with_behavior(TransactionBehavior::Immediate)?;
    let state = replay(&n.g, &load(&tx, n.g.cluster())?)?;
    // Already observed acceptance is a cluster grant with its own revocation
    // policy. Unresolved requests are cancelled, including uncertain delivery.
    maintain(&tx, &n, &state)?;
    let rows: Vec<(Vec<u8>, String)> = tx
        .prepare("SELECT grant_id,owner FROM adoption_outbox")?
        .query_map([], |r| Ok((r.get(0)?, r.get(1)?)))?
        .collect::<Result<_, _>>()?;
    for (grant, owner) in rows {
        if !active.contains(&owner) {
            tx.execute(
                "INSERT OR IGNORE INTO adoption_cancelled VALUES(?1)",
                params![grant],
            )?;
        }
    }
    tx.commit()?;
    Ok(())
}
pub(super) fn cancel_owner(path: &Path, owner: &str) -> Result<(), RuntimeError> {
    let (n, mut store) = opened(path)?;
    schema(&store.db)?;
    let tx = store
        .db
        .transaction_with_behavior(TransactionBehavior::Immediate)?;
    let state = replay(&n.g, &load(&tx, n.g.cluster())?)?;
    maintain(&tx, &n, &state)?;
    tx.execute("INSERT OR IGNORE INTO adoption_cancelled SELECT grant_id FROM adoption_outbox WHERE owner=?1",[owner])?;
    tx.commit()?;
    Ok(())
}
pub(super) fn cancellations(path: &Path) -> Result<Vec<Id>, RuntimeError> {
    let (n, store) = opened(path)?;
    schema(&store.db)?;
    let rows: Vec<Vec<u8>> = store
        .db
        .prepare("SELECT grant_id FROM adoption_cancelled WHERE grant_id IN(SELECT grant_id FROM adoption_outbox WHERE cluster=?1) ORDER BY rowid LIMIT 8")?
        .query_map(params![n.g.cluster()], |r| r.get(0))?
        .collect::<Result<_, _>>()?;
    rows.iter().map(|raw| id(raw)).collect()
}
pub(super) fn issues(path: &Path) -> Result<Vec<ClusterRevocationIssue>, RuntimeError> {
    if !path.exists() {
        return Ok(Vec::new());
    }
    let (n, store) = opened(path)?;
    schema(&store.db)?;
    let active = n.phase == 2 && store.state()?.members.get(&n.admission) == Some(&key(&n.pair));
    let rows=store.db.prepare("SELECT cluster,grant_id,expires FROM adoption_outbox WHERE grant_id IN(SELECT grant_id FROM adoption_cancelled) AND expires>?1 ORDER BY rowid LIMIT 128")?.query_map([now()],|r|Ok((r.get::<_,Vec<u8>>(0)?,r.get::<_,Vec<u8>>(1)?,r.get::<_,i64>(2)?)))?.collect::<Result<Vec<_>,_>>()?;
    Ok(rows
        .into_iter()
        .map(|(cluster, grant, expires)| ClusterRevocationIssue {
            requires_active_member: !active || cluster != n.g.cluster(),
            cluster_id: cluster,
            grant_id: grant,
            expires_at_unix: expires,
        })
        .collect())
}
pub(super) fn cancel_operation(grant: Id) -> Id {
    hash(
        &Value::Array(vec![
            Value::Text("rieul.cluster.cancel-adoption.v1".into()),
            b(grant),
        ])
        .encode(),
    )
}
fn pending(db: &Connection, owner: &str, grant: Id) -> Result<Pending, RuntimeError> {
    let row:Option<(Vec<u8>,Vec<u8>,Vec<u8>,i64,Option<Vec<u8>>,Option<Vec<u8>>)>=db.query_row("SELECT cluster,issuer,client,expires,client_proof,issuer_proof FROM (SELECT * FROM adoption_outbox UNION ALL SELECT * FROM adoption_receipts) WHERE grant_id=?1 AND owner=?2",params![grant,owner],|r|Ok((r.get(0)?,r.get(1)?,r.get(2)?,r.get(3)?,r.get(4)?,r.get(5)?))).optional()?;
    let (cluster, issuer, client, expires, client_proof, issuer_proof) =
        row.ok_or(RuntimeError::Unauthorized)?;
    Ok(Pending {
        challenge: ClusterClientAdoptionChallenge {
            cluster_id: cluster,
            grant_id: grant.to_vec(),
            issuer_admission_id: issuer,
            client_public_key: client,
            expires_at_unix: expires,
        },
        client_proof,
        issuer_proof,
    })
}
pub(super) fn mutation(intent: &ClusterPairingIntent) -> Result<Mutation, RuntimeError> {
    let c = &intent.challenge;
    Ok(Mutation::Adopt {
        grant: id(&c.grant_id)?,
        issuer: id(&c.issuer_admission_id)?,
        client: id(&c.client_public_key)?,
        expires: counter(c.expires_at_unix)?,
        client_proof: intent
            .client_proof
            .as_slice()
            .try_into()
            .map_err(|_| RuntimeError::InvalidProof)?,
        issuer_proof: intent
            .issuer_proof
            .as_slice()
            .try_into()
            .map_err(|_| RuntimeError::InvalidProof)?,
    })
}
pub(super) fn begin(
    path: &Path,
    auth: &Authorized,
    public: &[u8],
) -> Result<ClusterClientAdoptionChallenge, RuntimeError> {
    let public = id(public)?;
    let (n, mut store) = opened(path)?;
    schema(&store.db)?;
    let tx = store
        .db
        .transaction_with_behavior(TransactionBehavior::Immediate)?;
    let current = load_node(&tx)?.ok_or(RuntimeError::InvalidState)?;
    require_member(&current)?;
    if leaving(&tx, &current)? {
        return Err(RuntimeError::InvalidState);
    }
    if current.g != n.g || current.admission != n.admission {
        return Err(RuntimeError::Conflict);
    }
    let state = replay(&n.g, &load(&tx, n.g.cluster())?)?;
    maintain(&tx, &n, &state)?;
    let candidates:Vec<Vec<u8>>=tx.prepare("SELECT grant_id FROM (SELECT * FROM adoption_outbox UNION ALL SELECT * FROM adoption_receipts) WHERE owner=?1 AND client=?2 AND cluster=?3 AND issuer=?4 AND expires>?5 ORDER BY expires DESC")?.query_map(params![auth.client_id,public,n.g.cluster(),n.admission,now()],|r|r.get(0))?.collect::<Result<_,_>>()?;
    for raw in candidates {
        let grant = id(&raw)?;
        if state.revoked.contains(&grant) || cancelled(&tx, grant)? {
            continue;
        }
        let challenge = pending(&tx, &auth.client_id, grant)?.challenge;
        tx.commit()?;
        return Ok(challenge);
    }
    let count: i64 = tx.query_row("SELECT COUNT(*) FROM adoption_outbox", [], |r| r.get(0))?;
    if count as usize >= MAX_OUTBOX {
        return Err(RuntimeError::Limit);
    }
    let grant = random()?;
    let expires = auth.expires_at_unix.min(now() + 30 * 24 * 3600);
    tx.execute(
        "INSERT INTO adoption_outbox VALUES(?1,?2,?3,?4,?5,?6,NULL,NULL,NULL)",
        params![
            grant,
            auth.client_id,
            n.g.cluster(),
            n.admission,
            public,
            expires
        ],
    )?;
    let result = pending(&tx, &auth.client_id, grant)?.challenge;
    tx.commit()?;
    Ok(result)
}
pub(super) fn complete(
    path: &Path,
    auth: &Authorized,
    r: &CompleteClusterClientAdoptionReq,
) -> Result<ClusterClientAdoptionState, RuntimeError> {
    let (n, mut store) = opened(path)?;
    schema(&store.db)?;
    let grant = id(&r.grant_id)?;
    let tx = store
        .db
        .transaction_with_behavior(TransactionBehavior::Immediate)?;
    let current = load_node(&tx)?.ok_or(RuntimeError::InvalidState)?;
    require_member(&current)?;
    if leaving(&tx, &current)? {
        return Err(RuntimeError::InvalidState);
    }
    let p = pending(&tx, &auth.client_id, grant)?;
    let c = &p.challenge;
    if cancelled(&tx, grant)? {
        return Err(RuntimeError::Retired);
    }
    if id(&c.cluster_id)? != current.g.cluster()
        || id(&c.issuer_admission_id)? != current.admission
        || current.admission != n.admission
        || c.expires_at_unix <= now()
    {
        return Err(RuntimeError::Retired);
    }
    let client = id(&c.client_public_key)?;
    let proof: [u8; 64] = r
        .client_proof
        .as_slice()
        .try_into()
        .map_err(|_| RuntimeError::InvalidProof)?;
    verify(
        client,
        &client_adoption_body(
            n.g.cluster(),
            grant,
            n.admission,
            client,
            c.expires_at_unix as u64,
        ),
        &proof,
    )?;
    if let Some(old) = p.client_proof {
        if old != proof {
            return Err(RuntimeError::Conflict);
        }
    }
    let signed = n.pair.sign(&issuer_adoption_body(
        n.g.cluster(),
        grant,
        n.admission,
        client,
        c.expires_at_unix as u64,
        &proof,
    ));
    tx.execute(
        "UPDATE adoption_outbox SET client_proof=?1,issuer_proof=?2 WHERE grant_id=?3",
        params![proof, signed.as_ref(), grant],
    )?;
    tx.commit()?;
    get(path, auth, grant)
}
pub(super) fn get(
    path: &Path,
    auth: &Authorized,
    grant: Id,
) -> Result<ClusterClientAdoptionState, RuntimeError> {
    let (n, mut store) = opened(path)?;
    schema(&store.db)?;
    let p = pending(&store.db, &auth.client_id, grant)?;
    let c = &p.challenge;
    if cancelled(&store.db, grant)? {
        return Ok(if n.phase != 2 || c.cluster_id != n.g.cluster() {
            ClusterClientAdoptionState::CancellationNeedsActiveMember
        } else {
            ClusterClientAdoptionState::Rejected
        });
    }
    if id(&c.cluster_id)? != n.g.cluster() || c.expires_at_unix <= now() {
        return Ok(ClusterClientAdoptionState::Rejected);
    }
    let mut current = store.state()?;
    // Accepted grant remains valid after issuer departure. Check grant first.
    if current.grants.contains_key(&grant) {
        return Ok(ClusterClientAdoptionState::Accepted {
            history: history(&store)?,
        });
    }
    if current.revoked.contains(&grant)
        || !current.members.contains_key(&id(&c.issuer_admission_id)?)
    {
        return Ok(ClusterClientAdoptionState::Rejected);
    }
    if n.phase == 2 && current.primary == n.admission {
        if let (Some(client_proof), Some(issuer_proof)) = (p.client_proof, p.issuer_proof) {
            let intent = ClusterPairingIntent {
                challenge: p.challenge,
                client_proof,
                issuer_proof,
            };
            let mutation = mutation(&intent)?;
            let old_epoch: Option<u64> = store.db.query_row(
                "SELECT attempt_epoch FROM adoption_outbox WHERE grant_id=?1",
                params![grant],
                |r| r.get(0),
            )?;
            let epoch = old_epoch.unwrap_or(current.epoch);
            store.db.execute(
                "UPDATE adoption_outbox SET attempt_epoch=?1 WHERE grant_id=?2",
                params![epoch, grant],
            )?;
            match store.commit(&n.pair, epoch, grant, mutation.clone()) {
                Ok(_) => {}
                Err(Error::NotPrimary) if epoch != current.epoch => {
                    store.db.execute(
                        "UPDATE adoption_outbox SET attempt_epoch=?1 WHERE grant_id=?2",
                        params![current.epoch, grant],
                    )?;
                    store.commit(&n.pair, current.epoch, grant, mutation)?;
                }
                Err(e) => return Err(e.into()),
            }
            current = store.state()?;
        }
    }
    if current.grants.contains_key(&grant) {
        Ok(ClusterClientAdoptionState::Accepted {
            history: history(&store)?,
        })
    } else {
        Ok(ClusterClientAdoptionState::Pending)
    }
}

pub(super) fn pending_intents(
    path: &Path,
) -> Result<Vec<(String, ClusterPairingIntent)>, RuntimeError> {
    let (n, mut store) = opened(path)?;
    require_member(&n)?;
    schema(&store.db)?;
    let tx = store
        .db
        .transaction_with_behavior(TransactionBehavior::Immediate)?;
    let state = replay(&n.g, &load(&tx, n.g.cluster())?)?;
    maintain(&tx, &n, &state)?;
    tx.commit()?;
    let mut statement=store.db.prepare("SELECT owner,grant_id FROM adoption_outbox WHERE client_proof IS NOT NULL AND expires>?1 AND grant_id NOT IN(SELECT grant_id FROM adoption_cancelled) ORDER BY rowid LIMIT 128")?;
    let rows = statement.query_map([now()], |r| {
        Ok((r.get::<_, String>(0)?, r.get::<_, Vec<u8>>(1)?))
    })?;
    let mut result = Vec::new();
    for row in rows {
        let (owner, grant) = row?;
        let grant = id(&grant)?;
        if state.grants.contains_key(&grant) || state.revoked.contains(&grant) {
            continue;
        }
        let p = pending(&store.db, &owner, grant)?;
        if p.challenge.cluster_id != n.g.cluster() || p.challenge.issuer_admission_id != n.admission
        {
            continue;
        }
        if let (Some(client_proof), Some(issuer_proof)) = (p.client_proof, p.issuer_proof) {
            result.push((
                owner,
                ClusterPairingIntent {
                    challenge: p.challenge,
                    client_proof,
                    issuer_proof,
                },
            ));
            if result.len() == 8 {
                break;
            }
        }
    }
    Ok(result)
}

#[cfg(all(test, not(windows)))]
mod tests {
    use super::*;
    #[test]
    fn revoked_or_cancelled_same_key_gets_new_grant_and_old_proof_stays_retired() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("cluster.sqlite");
        initialize(&path, [1; 32], None, "https://fixture/rieul/rpc").unwrap();
        let auth = Authorized {
            expires_at_unix: now() + 3600,
            client_id: "owner".into(),
            grant: None,
            peer: None,
        };
        let client = Ed25519KeyPair::from_seed_unchecked(&[22; 32]).unwrap();
        let first = begin(&path, &auth, &key(&client)).unwrap();
        let grant = id(&first.grant_id).unwrap();
        let (n, mut store) = opened(&path).unwrap();
        let proof = client.sign(&client_adoption_body(
            n.g.cluster(),
            grant,
            n.admission,
            key(&client),
            first.expires_at_unix as u64,
        ));
        let completion = CompleteClusterClientAdoptionReq {
            grant_id: first.grant_id.clone(),
            client_proof: proof.as_ref().to_vec(),
        };
        assert!(matches!(
            complete(&path, &auth, &completion).unwrap(),
            ClusterClientAdoptionState::Accepted { .. }
        ));
        store
            .commit(&n.pair, 1, [4; 32], Mutation::Revoke { grant })
            .unwrap();
        let second = begin(&path, &auth, &key(&client)).unwrap();
        assert_ne!(first.grant_id, second.grant_id);
        assert!(matches!(
            complete(&path, &auth, &completion).unwrap(),
            ClusterClientAdoptionState::Rejected
        ));
        assert!(store.state().unwrap().revoked.contains(&grant));
        cancel_owner(&path, "owner").unwrap();
        let third = begin(&path, &auth, &key(&client)).unwrap();
        assert_ne!(second.grant_id, third.grant_id);
        assert_ne!(first.grant_id, third.grant_id);
        assert!(cancelled(&store.db, id(&second.grant_id).unwrap()).unwrap());
    }
    #[test]
    fn cancelled_owner_cannot_retry_and_inflight_adoption_is_revoked_in_either_log_order() {
        for adopt_first in [false, true] {
            let dir = tempfile::tempdir().unwrap();
            let path = dir.path().join("cluster.sqlite");
            initialize(&path, [1; 32], None, "https://fixture/rieul/rpc").unwrap();
            let auth = Authorized {
                expires_at_unix: now() + 3600,
                client_id: "client".into(),
                grant: None,
                peer: None,
            };
            let client = Ed25519KeyPair::from_seed_unchecked(&[22; 32]).unwrap();
            let challenge = begin(&path, &auth, &key(&client)).unwrap();
            let grant = id(&challenge.grant_id).unwrap();
            let (n, mut store) = opened(&path).unwrap();
            let proof: [u8; 64] = client
                .sign(&client_adoption_body(
                    n.g.cluster(),
                    grant,
                    n.admission,
                    key(&client),
                    challenge.expires_at_unix as u64,
                ))
                .as_ref()
                .try_into()
                .unwrap();
            let issuer = n.pair.sign(&issuer_adoption_body(
                n.g.cluster(),
                grant,
                n.admission,
                key(&client),
                challenge.expires_at_unix as u64,
                &proof,
            ));
            store
                .db
                .execute(
                    "UPDATE adoption_outbox SET client_proof=?1,issuer_proof=?2 WHERE grant_id=?3",
                    params![proof, issuer.as_ref(), grant],
                )
                .unwrap();
            let intent = ClusterPairingIntent {
                challenge,
                client_proof: proof.to_vec(),
                issuer_proof: issuer.as_ref().to_vec(),
            };
            cancel_inactive(&path, &[]).unwrap();
            assert!(pending_intents(&path).unwrap().is_empty());
            assert_eq!(cancellations(&path).unwrap(), vec![grant]);
            assert!(matches!(
                get(&path, &auth, grant).unwrap(),
                ClusterClientAdoptionState::Rejected
            ));
            assert!(matches!(
                complete(
                    &path,
                    &auth,
                    &CompleteClusterClientAdoptionReq {
                        grant_id: grant.to_vec(),
                        client_proof: proof.to_vec()
                    }
                ),
                Err(RuntimeError::Retired)
            ));
            if adopt_first {
                store
                    .commit(&n.pair, 1, grant, mutation(&intent).unwrap())
                    .unwrap();
            }
            store
                .commit(
                    &n.pair,
                    1,
                    cancel_operation(grant),
                    Mutation::Revoke { grant },
                )
                .unwrap();
            if !adopt_first {
                assert!(store
                    .commit(&n.pair, 1, grant, mutation(&intent).unwrap())
                    .is_err());
            }
            let state = opened(&path).unwrap().1.state().unwrap();
            assert!(state.revoked.contains(&grant));
            assert!(!state.grants.contains_key(&grant));
            assert!(pending_intents(&path).unwrap().is_empty());
            assert!(cancellations(&path).unwrap().is_empty());
        }
    }
    #[test]
    fn completed_front_rows_do_not_starve_pending_and_expired_rows_free_capacity() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("cluster.sqlite");
        initialize(&path, [1; 32], None, "https://fixture/rieul/rpc").unwrap();
        let auth = Authorized {
            expires_at_unix: now() + 3600,
            client_id: "client".into(),
            grant: None,
            peer: None,
        };
        let (n, store) = opened(&path).unwrap();
        schema(&store.db).unwrap();
        for i in 0..128u8 {
            store
                .db
                .execute(
                    "INSERT INTO adoption_outbox VALUES(?1,'client',?2,?3,?4,?5,?6,?6,NULL)",
                    params![
                        [i; 32],
                        n.g.cluster(),
                        n.admission,
                        [9u8; 32],
                        now() - 1,
                        [0u8; 64]
                    ],
                )
                .unwrap();
        }
        // Expired queue entries do not permanently exhaust the 128-item limit.
        let fresh = begin(&path, &auth, &[99; 32]).unwrap();
        assert_eq!(
            store
                .db
                .query_row("SELECT COUNT(*) FROM adoption_outbox", [], |r| r
                    .get::<_, i64>(0))
                .unwrap(),
            1
        );
        store.db.execute("DELETE FROM adoption_outbox", []).unwrap();
        let mut state = store.state().unwrap();
        for i in 0..10u8 {
            store
                .db
                .execute(
                    "INSERT INTO adoption_outbox VALUES(?1,'client',?2,?3,?4,?5,?6,?6,NULL)",
                    params![
                        [i; 32],
                        n.g.cluster(),
                        n.admission,
                        [9u8; 32],
                        now() + 3600,
                        [0u8; 64]
                    ],
                )
                .unwrap();
            if i < 8 {
                state.grants.insert(
                    [i; 32],
                    Grant {
                        client: [9; 32],
                        expires: (now() + 3600) as u64,
                    },
                );
            }
        }
        let (_, mut st) = opened(&path).unwrap();
        let tx = st
            .db
            .transaction_with_behavior(TransactionBehavior::Immediate)
            .unwrap();
        maintain(&tx, &n, &state).unwrap();
        tx.commit().unwrap();
        assert_eq!(
            st.db
                .query_row("SELECT COUNT(*) FROM adoption_receipts", [], |r| r
                    .get::<_, i64>(0))
                .unwrap(),
            8
        );
        let pending = pending_intents(&path).unwrap();
        assert_eq!(pending.len(), 2);
        assert_eq!(pending[0].1.challenge.grant_id, vec![8; 32]);
        assert_ne!(fresh.grant_id, pending[0].1.challenge.grant_id);
    }
}
