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
    Ok(())
}
fn pending(db: &Connection, owner: &str, grant: Id) -> Result<Pending, RuntimeError> {
    let row:Option<(Vec<u8>,Vec<u8>,Vec<u8>,i64,Option<Vec<u8>>,Option<Vec<u8>>)>=db.query_row("SELECT cluster,issuer,client,expires,client_proof,issuer_proof FROM adoption_outbox WHERE grant_id=?1 AND owner=?2",params![grant,owner],|r|Ok((r.get(0)?,r.get(1)?,r.get(2)?,r.get(3)?,r.get(4)?,r.get(5)?))).optional()?;
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
    if current.g != n.g || current.admission != n.admission {
        return Err(RuntimeError::Conflict);
    }
    let existing:Option<Vec<u8>>=tx.query_row("SELECT grant_id FROM adoption_outbox WHERE owner=?1 AND client=?2 AND cluster=?3 AND issuer=?4 AND expires>?5 ORDER BY rowid DESC LIMIT 1",params![auth.client_id,public,n.g.cluster(),n.admission,now()],|r|r.get(0)).optional()?;
    if let Some(grant) = existing {
        return Ok(pending(&tx, &auth.client_id, id(&grant)?)?.challenge);
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
    let p = pending(&tx, &auth.client_id, grant)?;
    let c = &p.challenge;
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
    let (n, store) = opened(path)?;
    require_member(&n)?;
    schema(&store.db)?;
    let state = store.state()?;
    let mut statement=store.db.prepare("SELECT owner,grant_id FROM adoption_outbox WHERE client_proof IS NOT NULL AND expires>?1 ORDER BY rowid LIMIT 8")?;
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
        }
    }
    Ok(result)
}
