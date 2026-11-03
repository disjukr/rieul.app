//! Background replication and adoption retry. No keys are created by this worker.
use super::*;
use crate::maintenance::WorkGate;
use rieul_daemon_core::wire::ReqResMessage;
use std::{path::PathBuf, sync::Arc};

type SharedCredentials = Arc<tokio::sync::Mutex<rieul_daemon_core::config::ClientCredentials>>;
async fn dispatch_guard(
    path: &Path,
    shared: &SharedCredentials,
    owner: &str,
) -> Result<
    Option<tokio::sync::OwnedMutexGuard<rieul_daemon_core::config::ClientCredentials>>,
    RuntimeError,
> {
    let mut records = shared.clone().lock_owned().await;
    *records = rieul_daemon_core::config::load_client_credentials_or_default(path)
        .map_err(|_| RuntimeError::Storage)?;
    if records
        .clients
        .iter()
        .any(|r| r.client_id == owner && r.expires_at_unix > now())
    {
        Ok(Some(records))
    } else {
        Ok(None)
    }
}
struct Session(web_transport_quinn::Session);
impl Drop for Session {
    fn drop(&mut self) {
        self.0.close(0, b"cluster exchange complete");
    }
}
async fn unary(
    session: &web_transport_quinn::Session,
    proc: ProcId,
    payload: Option<Vec<u8>>,
) -> Result<Vec<u8>, RuntimeError> {
    let (mut send, mut recv) = session
        .open_bi()
        .await
        .map_err(|_| RuntimeError::PrimaryUnavailable)?;
    let message = ReqResMessage::RequestUnary {
        proc_id: proc.as_u64(),
        payload,
    }
    .encode();
    send.write_all(&message)
        .await
        .map_err(|_| RuntimeError::PrimaryUnavailable)?;
    send.finish()
        .map_err(|_| RuntimeError::PrimaryUnavailable)?;
    let bytes = recv
        .read_to_end(MAX_RPC_BYTES + 4096)
        .await
        .map_err(|_| RuntimeError::Limit)?;
    let mut messages =
        ReqResMessage::decode_sequence(&bytes).map_err(|_| RuntimeError::InvalidProof)?;
    if messages.len() != 1 {
        return Err(RuntimeError::InvalidProof);
    }
    match messages.remove(0) {
        ReqResMessage::ResponseUnaryOk {
            payload: Some(bytes),
        } => Ok(bytes),
        ReqResMessage::ResponseUnaryError { .. } => Err(RuntimeError::Unauthorized),
        _ => Err(RuntimeError::PrimaryUnavailable),
    }
}
pub(crate) async fn call(
    client: &web_transport_quinn::Client,
    path: &Path,
    server: Id,
    url: &str,
    proc: ProcId,
    payload: Vec<u8>,
    original: String,
) -> Result<Vec<u8>, RuntimeError> {
    validate_endpoint(url)?;
    tokio::time::timeout(Duration::from_secs(8), async {
        let session = Session(
            client
                .connect(web_transport_quinn::proto::ConnectRequest::new(
                    url::Url::parse(url).map_err(|_| RuntimeError::InvalidProof)?,
                ))
                .await
                .map_err(|_| RuntimeError::PrimaryUnavailable)?,
        );
        let challenge_bytes = unary(&session.0, ProcId::GetClusterPeerChallenge, None).await?;
        let challenge = ClusterPeerChallenge::decode(&challenge_bytes)
            .map_err(|_| RuntimeError::InvalidProof)?;
        let own_path = path.to_owned();
        let request = tokio::task::spawn_blocking(move || {
            peer::sign(&own_path, server, &challenge, proc, payload, original)
        })
        .await
        .map_err(|_| RuntimeError::Storage)??;
        let bytes = unary(
            &session.0,
            ProcId::ExecuteClusterPeerRequest,
            Some(request.encode()),
        )
        .await?;
        let response =
            ClusterPeerResponse::decode(&bytes).map_err(|_| RuntimeError::InvalidProof)?;
        if response.payload.len() > MAX_RPC_BYTES {
            return Err(RuntimeError::Limit);
        }
        Ok(response.payload)
    })
    .await
    .map_err(|_| RuntimeError::PrimaryUnavailable)?
}
fn route(path: &Path) -> Result<(Id, String, Id, i64, Id), RuntimeError> {
    let (n, store) = opened(path)?;
    require_member(&n)?;
    let s = store.state()?;
    Ok((
        *s.members
            .get(&s.primary)
            .ok_or(RuntimeError::InvalidProof)?,
        s.endpoints
            .get(&s.primary)
            .cloned()
            .ok_or(RuntimeError::InvalidProof)?,
        s.cluster,
        s.epoch as i64,
        n.admission,
    ))
}
pub(crate) async fn forward(
    path: PathBuf,
    proc: ProcId,
    payload: Vec<u8>,
    original: String,
) -> Result<Vec<u8>, RuntimeError> {
    let p = path.clone();
    let (server, url, _, _, _) = tokio::task::spawn_blocking(move || route(&p))
        .await
        .map_err(|_| RuntimeError::Storage)??;
    let p = path.clone();
    let is_self = tokio::task::spawn_blocking(move || {
        let (n, s) = opened(&p)?;
        Ok::<_, RuntimeError>(s.state()?.primary == n.admission)
    })
    .await
    .map_err(|_| RuntimeError::Storage)??;
    if is_self {
        return Err(RuntimeError::PrimaryUnavailable);
    }
    let client = web_transport_quinn::ClientBuilder::new()
        .with_system_roots()
        .map_err(|_| RuntimeError::PrimaryUnavailable)?;
    call(&client, &path, server, &url, proc, payload, original).await
}
fn apply_sync(path: &Path, h: ClusterHistory) -> Result<(), RuntimeError> {
    let (n, store) = opened(path)?;
    let entries = decoded_history(&h, &n.g)?;
    let next = replay(&n.g, &entries)?;
    let activation = if next.primary == n.admission && store.state()?.primary != n.admission {
        entries.iter().rev().find_map(|e| match &e.mutation {
            Mutation::Transfer { id, .. } if *id == n.admission => Some(e.operation),
            _ => None,
        })
    } else {
        None
    };
    import(path, &h, None, activation, None)?;
    Ok(())
}
// Try the cached primary first, then at most three distinct cached peers.
// Rotate the fallback window across ticks so an unreachable early peer cannot
// permanently hide a live successor. Discovery never elects a primary: only a
// verified, continuous signed transfer history can change the local route.
fn candidates(path: &Path, cursor: &mut usize) -> Result<Vec<(Id, String)>, RuntimeError> {
    let (n, store) = opened(path)?;
    require_member(&n)?;
    let s = store.state()?;
    let peers: Vec<_> = s
        .members
        .iter()
        .filter(|(id, _)| **id != n.admission && **id != s.primary)
        .map(|(id, key)| {
            Ok((
                *key,
                s.endpoints
                    .get(id)
                    .cloned()
                    .ok_or(RuntimeError::InvalidProof)?,
            ))
        })
        .collect::<Result<_, RuntimeError>>()?;
    let mut result = vec![(
        *s.members
            .get(&s.primary)
            .ok_or(RuntimeError::InvalidProof)?,
        s.endpoints
            .get(&s.primary)
            .cloned()
            .ok_or(RuntimeError::InvalidProof)?,
    )];
    result.extend(fallback_window(&peers, cursor));
    Ok(result)
}
fn fallback_window(peers: &[(Id, String)], cursor: &mut usize) -> Vec<(Id, String)> {
    if peers.is_empty() {
        return Vec::new();
    }
    let start = *cursor % peers.len();
    let count = peers.len().min(3);
    *cursor = (start + count) % peers.len();
    (0..count)
        .map(|i| peers[(start + i) % peers.len()].clone())
        .collect()
}
async fn synchronize(
    path: &Path,
    client: &web_transport_quinn::Client,
    cursor: &mut usize,
) -> Result<(), RuntimeError> {
    let p = path.to_owned();
    let (_, _, cluster, _, local) = tokio::task::spawn_blocking(move || route(&p))
        .await
        .map_err(|_| RuntimeError::Storage)??;
    let p = path.to_owned();
    let mut next_cursor = *cursor;
    let (routes, advanced) = tokio::task::spawn_blocking(move || {
        let routes = candidates(&p, &mut next_cursor)?;
        Ok::<_, RuntimeError>((routes, next_cursor))
    })
    .await
    .map_err(|_| RuntimeError::Storage)??;
    *cursor = advanced;
    let previous_primary = routes[0].0;
    let mut error = RuntimeError::PrimaryUnavailable;
    for (index, (server, url)) in routes.into_iter().enumerate() {
        let received = call(
            client,
            path,
            server,
            &url,
            ProcId::ReadClusterHistory,
            ReadClusterHistoryReq {
                cluster_id: cluster.to_vec(),
            }
            .encode(),
            format!("node:{local:?}"),
        )
        .await;
        let bytes = match received {
            Ok(bytes) => bytes,
            Err(e) => {
                let rejected = matches!(e, RuntimeError::Unauthorized);
                error = e;
                if !rejected {
                    continue;
                }
                // A removed member cannot read new history. It may retrieve
                // only its own signed historical removal prefix, with the
                // same key/nonce/target binding as ordinary peer requests.
                if let Ok(bytes) = call(
                    client,
                    path,
                    server,
                    &url,
                    ProcId::GetClusterRemovalProof,
                    ReadClusterHistoryReq {
                        cluster_id: cluster.to_vec(),
                    }
                    .encode(),
                    format!("node:{local:?}"),
                )
                .await
                {
                    if let Ok(proof) = ClusterHistory::decode(&bytes) {
                        let p = path.to_owned();
                        if tokio::task::spawn_blocking(move || apply_removal_proof(&p, &proof))
                            .await
                            .map_err(|_| RuntimeError::Storage)?
                            .is_ok()
                        {
                            return Ok(());
                        }
                    }
                }
                continue;
            }
        };
        let history = match ClusterHistory::decode(&bytes) {
            Ok(history) => history,
            Err(_) => {
                error = RuntimeError::InvalidProof;
                continue;
            }
        };
        let p = path.to_owned();
        let applied = tokio::task::spawn_blocking(move || {
            apply_sync(&p, history)?;
            route(&p)
        })
        .await
        .map_err(|_| RuntimeError::Storage)?;
        match applied {
            Ok((primary, _, _, _, _)) if index == 0 || primary != previous_primary => return Ok(()),
            Ok(_) => {} // A stale but valid replica does not end discovery.
            Err(e) => error = e,
        }
    }
    Err(error)
}
#[cfg(test)]
pub(crate) async fn tick(
    path: &Path,
    client: &web_transport_quinn::Client,
) -> Result<(), RuntimeError> {
    tick_with_cursor(path, client, &mut 0, None).await
}
async fn tick_with_cursor(
    path: &Path,
    client: &web_transport_quinn::Client,
    cursor: &mut usize,
    credentials: Option<(&Path, &SharedCredentials)>,
) -> Result<(), RuntimeError> {
    let path = path.to_owned();
    let p = path.clone();
    let (_, _, cluster, _, local) = tokio::task::spawn_blocking(move || route(&p))
        .await
        .map_err(|_| RuntimeError::Storage)??;
    let p = path.clone();
    let local_primary = tokio::task::spawn_blocking(move || {
        let (n, s) = opened(&p)?;
        Ok::<_, RuntimeError>(s.state()?.primary == n.admission)
    })
    .await
    .map_err(|_| RuntimeError::Storage)??;
    if !local_primary {
        synchronize(&path, client, cursor).await?;
        let p = path.clone();
        if tokio::task::spawn_blocking(move || opened(&p).map(|(n, _)| n.phase == 4))
            .await
            .map_err(|_| RuntimeError::Storage)??
        {
            return Ok(());
        }
    }
    let p = path.clone();
    let cancellations = tokio::task::spawn_blocking(move || adoption::cancellations(&p))
        .await
        .map_err(|_| RuntimeError::Storage)??;
    for grant in cancellations {
        let p = path.clone();
        let (server, url, _, epoch, _) = tokio::task::spawn_blocking(move || route(&p))
            .await
            .map_err(|_| RuntimeError::Storage)??;
        let request = RevokeClusterClientGrantReq {
            operation_id: adoption::cancel_operation(grant).to_vec(),
            expected_management_epoch: epoch,
            grant_id: grant.to_vec(),
        };
        if local_primary {
            let p = path.clone();
            tokio::task::spawn_blocking(move || {
                execute(
                    &p,
                    &Authorized {
                        expires_at_unix: now() + 10,
                        client_id: "cancel-pending-adoption".into(),
                        peer: None,
                    },
                    RpcRequest::RevokeClusterClientGrant(request),
                    "",
                )
            })
            .await
            .map_err(|_| RuntimeError::Storage)??;
        } else {
            call(
                client,
                &path,
                server,
                &url,
                ProcId::RevokeClusterClientGrant,
                request.encode(),
                "node:cancel-pending-adoption".into(),
            )
            .await?;
            synchronize(&path, client, cursor).await?;
        }
    }
    let p = path.clone();
    let intents = tokio::task::spawn_blocking(move || adoption::pending_intents(&p))
        .await
        .map_err(|_| RuntimeError::Storage)??;
    for (owner, intent) in intents {
        let guard = if let Some((credentials_path, shared)) = credentials {
            match dispatch_guard(credentials_path, shared, &owner).await? {
                Some(guard) => Some(guard),
                None => {
                    let p = path.clone();
                    let owner = owner.clone();
                    tokio::task::spawn_blocking(move || adoption::cancel_owner(&p, &owner))
                        .await
                        .map_err(|_| RuntimeError::Storage)??;
                    continue;
                }
            }
        } else {
            None
        };
        let p = path.clone();
        let (server, url, _, epoch, _) = tokio::task::spawn_blocking(move || route(&p))
            .await
            .map_err(|_| RuntimeError::Storage)??;
        let p = path.clone();
        let local_primary = tokio::task::spawn_blocking(move || {
            let (n, s) = opened(&p)?;
            Ok::<_, RuntimeError>(s.state()?.primary == n.admission)
        })
        .await
        .map_err(|_| RuntimeError::Storage)??;
        if local_primary {
            let p = path.clone();
            let grant = id(&intent.challenge.grant_id)?;
            tokio::task::spawn_blocking(move || {
                adoption::get(
                    &p,
                    &Authorized {
                        expires_at_unix: now() + 10,
                        client_id: owner,
                        peer: None,
                    },
                    grant,
                )
            })
            .await
            .map_err(|_| RuntimeError::Storage)??;
        } else {
            call(
                client,
                &path,
                server,
                &url,
                ProcId::AdoptClusterClient,
                AdoptClusterClientReq {
                    expected_management_epoch: epoch,
                    intent,
                }
                .encode(),
                format!("paired:{owner}"),
            )
            .await?;
            drop(guard);
            let bytes = call(
                client,
                &path,
                server,
                &url,
                ProcId::ReadClusterHistory,
                ReadClusterHistoryReq {
                    cluster_id: cluster.to_vec(),
                }
                .encode(),
                format!("node:{local:?}"),
            )
            .await?;
            let h = ClusterHistory::decode(&bytes).map_err(|_| RuntimeError::InvalidProof)?;
            let p = path.clone();
            tokio::task::spawn_blocking(move || apply_sync(&p, h))
                .await
                .map_err(|_| RuntimeError::Storage)??;
        }
    }
    Ok(())
}
pub(crate) async fn run(
    path: PathBuf,
    gate: Arc<WorkGate>,
    credentials_path: PathBuf,
    credentials: Arc<tokio::sync::Mutex<rieul_daemon_core::config::ClientCredentials>>,
) {
    if !ENROLLMENT_SUPPORTED {
        return;
    }
    let mut client = None;
    let mut discovery_cursor = 0;
    let mut delay = Duration::from_secs(2);
    loop {
        tokio::time::sleep(delay).await;
        if !path.exists() {
            continue;
        }
        let Some(_work) = gate.enter() else { continue };
        if client.is_none() {
            client = web_transport_quinn::ClientBuilder::new()
                .with_system_roots()
                .ok();
        }
        let Some(client) = client.as_ref() else {
            delay = Duration::from_secs(30);
            continue;
        };
        // Cancel known revoked owners before synchronization can turn uncertain
        // delivery into an observed accepted receipt. Revalidate separately at
        // each dispatch; discovery never holds the credential removal lock.
        let mut records = credentials.lock().await;
        let fresh = match rieul_daemon_core::config::load_client_credentials_or_default(
            &credentials_path,
        ) {
            Ok(records) => records,
            Err(_) => {
                delay = Duration::from_secs(30);
                continue;
            }
        };
        *records = fresh;
        let active: Vec<_> = records
            .clients
            .iter()
            .filter(|r| r.expires_at_unix > now())
            .map(|r| r.client_id.clone())
            .collect();
        let p = path.clone();
        if !matches!(
            tokio::task::spawn_blocking(move || adoption::cancel_inactive(&p, &active)).await,
            Ok(Ok(()))
        ) {
            delay = Duration::from_secs(30);
            continue;
        }
        drop(records);
        match tick_with_cursor(
            &path,
            client,
            &mut discovery_cursor,
            Some((&credentials_path, &credentials)),
        )
        .await
        {
            Ok(()) => delay = Duration::from_secs(2),
            Err(_) => delay = (delay * 2).min(Duration::from_secs(30)),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[tokio::test]
    async fn adoption_dispatch_reloads_owner_and_serializes_with_local_revocation() {
        use rieul_daemon_core::config::{
            save_client_credentials, ClientCredentialRecord, ClientCredentials,
        };
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("clients.json");
        let records = ClientCredentials {
            clients: vec![ClientCredentialRecord {
                client_id: "fixture-owner".into(),
                label: "fixture".into(),
                secret_sha256_base64url: "fixture-not-a-secret".into(),
                created_at_unix: now(),
                expires_at_unix: now() + 60,
            }],
        };
        save_client_credentials(&path, &records).unwrap();
        let shared = Arc::new(tokio::sync::Mutex::new(records.clone()));
        let guard = dispatch_guard(&path, &shared, "fixture-owner")
            .await
            .unwrap()
            .unwrap();
        assert!(shared.try_lock().is_err());
        drop(guard);
        {
            let mut locked = shared.lock().await;
            *locked = ClientCredentials::default();
            save_client_credentials(&path, &locked).unwrap();
        }
        assert!(dispatch_guard(&path, &shared, "fixture-owner")
            .await
            .unwrap()
            .is_none());
        // Persisted expiry wins over any older in-memory cache as well.
        let mut expired = records.clone();
        expired.clients[0].expires_at_unix = now() - 1;
        save_client_credentials(&path, &expired).unwrap();
        *shared.lock().await = records;
        assert!(dispatch_guard(&path, &shared, "fixture-owner")
            .await
            .unwrap()
            .is_none());
        std::fs::write(&path, "malformed credential fixture").unwrap();
        assert!(dispatch_guard(&path, &shared, "fixture-owner")
            .await
            .is_err());
    }
    #[test]
    fn fallback_probe_budget_rotates_without_duplicates_or_starvation() {
        for count in 0..16 {
            let peers: Vec<_> = (0..count)
                .map(|n| ([n as u8; 32], format!("https://node{n}/rieul/rpc")))
                .collect();
            let mut cursor = usize::MAX;
            let mut seen = std::collections::BTreeSet::new();
            for _ in 0..count.max(1) {
                let batch = fallback_window(&peers, &mut cursor);
                assert_eq!(batch.len(), count.min(3));
                let unique: std::collections::BTreeSet<_> =
                    batch.iter().map(|(key, _)| *key).collect();
                assert_eq!(unique.len(), batch.len());
                seen.extend(unique);
            }
            assert_eq!(seen.len(), count);
        }
    }
}
