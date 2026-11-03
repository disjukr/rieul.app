//! Background replication and adoption retry. No keys are created by this worker.
use super::*;
use crate::maintenance::WorkGate;
use rieul_daemon_core::wire::ReqResMessage;
use std::{path::PathBuf, sync::Arc};

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
    import(path, &h, None, activation)?;
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
                error = e;
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
    tick_with_cursor(path, client, &mut 0).await
}
async fn tick_with_cursor(
    path: &Path,
    client: &web_transport_quinn::Client,
    cursor: &mut usize,
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
    }
    let p = path.clone();
    let intents = tokio::task::spawn_blocking(move || adoption::pending_intents(&p))
        .await
        .map_err(|_| RuntimeError::Storage)??;
    for (owner, intent) in intents {
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
pub(crate) async fn run(path: PathBuf, gate: Arc<WorkGate>) {
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
        match tick_with_cursor(&path, client, &mut discovery_cursor).await {
            Ok(()) => delay = Duration::from_secs(2),
            Err(_) => delay = (delay * 2).min(Duration::from_secs(30)),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
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
