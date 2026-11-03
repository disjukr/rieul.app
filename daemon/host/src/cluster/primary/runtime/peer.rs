//! Per-connection nonce proofs for cluster management peers, never a copied secret.
use super::*;
pub(crate) fn server_body(cluster: Id, server: Id, connection: u64, nonce: Id) -> Vec<u8> {
    Value::Array(vec![
        Value::Text("rieul.cluster.peer-server.v1".into()),
        b(cluster),
        b(server),
        Value::U64(connection),
        b(nonce),
    ])
    .encode()
}
fn request_body(r: &ClusterPeerRequest, server: Id) -> Result<Vec<u8>, RuntimeError> {
    if r.original_principal.is_empty()
        || r.original_principal.len() > 256
        || r.payload.len() > MAX_RPC_BYTES
    {
        return Err(RuntimeError::Limit);
    }
    Ok(Value::Array(vec![
        Value::Text("rieul.cluster.peer-request.v1".into()),
        b(id(&r.cluster_id)?),
        b(server),
        b(id(&r.sender_admission_id)?),
        b(id(&r.sender_public_key)?),
        b(id(&r.nonce)?),
        Value::U64(counter(r.connection_id)?),
        Value::U64(counter(r.procedure_id)?),
        b(hash(&r.payload)),
        Value::Text(r.original_principal.clone()),
    ])
    .encode())
}
pub(crate) fn challenge(
    path: &Path,
    connection: u64,
    nonce: Id,
) -> Result<ClusterPeerChallenge, RuntimeError> {
    let db = database(path, false)?;
    let n = load_node(&db)?.ok_or(RuntimeError::InvalidState)?;
    require_member(&n)?;
    Ok(ClusterPeerChallenge {
        nonce: nonce.to_vec(),
        connection_id: connection as i64,
        server_proof: n
            .pair
            .sign(&server_body(n.g.cluster(), key(&n.pair), connection, nonce))
            .as_ref()
            .to_vec(),
    })
}
pub(crate) fn authenticate(
    path: &Path,
    r: &ClusterPeerRequest,
) -> Result<Authorized, RuntimeError> {
    let (n, store) = opened(path)?;
    require_member(&n)?;
    if id(&r.cluster_id)? != n.g.cluster() {
        return Err(RuntimeError::Unauthorized);
    }
    let sender = id(&r.sender_admission_id)?;
    let public = id(&r.sender_public_key)?;
    if store.state()?.members.get(&sender) != Some(&public) {
        if r.procedure_id != ProcId::GetClusterRemovalProof.as_u64() as i64 {
            return Err(RuntimeError::Unauthorized);
        }
        removal_proof(&store, sender, public)?;
    }
    verify(public, &request_body(r, key(&n.pair))?, &r.signature)?;
    Ok(Authorized {
        expires_at_unix: now() + 10,
        client_id: r.original_principal.clone(),
        peer: Some((sender, public)),
    })
}
pub(crate) fn sign(
    path: &Path,
    server: Id,
    challenge: &ClusterPeerChallenge,
    proc: ProcId,
    payload: Vec<u8>,
    original: String,
) -> Result<ClusterPeerRequest, RuntimeError> {
    let (n, store) = opened(path)?;
    require_member(&n)?;
    let s = store.state()?;
    if s.members.get(&n.admission) != Some(&key(&n.pair))
        || !s.members.values().any(|k| *k == server)
    {
        return Err(RuntimeError::Unauthorized);
    }
    verify(
        server,
        &server_body(
            n.g.cluster(),
            server,
            counter(challenge.connection_id)?,
            id(&challenge.nonce)?,
        ),
        &challenge.server_proof,
    )?;
    let mut r = ClusterPeerRequest {
        cluster_id: n.g.cluster().to_vec(),
        sender_admission_id: n.admission.to_vec(),
        sender_public_key: key(&n.pair).to_vec(),
        nonce: challenge.nonce.clone(),
        connection_id: challenge.connection_id,
        procedure_id: proc.as_u64() as i64,
        payload,
        original_principal: original,
        signature: Vec::new(),
    };
    r.signature = n.pair.sign(&request_body(&r, server)?).as_ref().to_vec();
    Ok(r)
}
pub(crate) fn permitted(proc: ProcId) -> bool {
    matches!(
        proc,
        ProcId::ReadClusterHistory
            | ProcId::GetClusterRemovalProof
            | ProcId::AdoptClusterClient
            | ProcId::RemoveClusterMember
            | ProcId::AdmitClusterMember
            | ProcId::RevokeClusterClientGrant
            | ProcId::PreparePrimaryTransfer
            | ProcId::SealPrimaryTransfer
            | ProcId::ActivateClusterPrimary
            | ProcId::ApplyClusterHistory
    )
}

pub(crate) fn forwarding_payload(request: &RpcRequest) -> Option<(ProcId, Vec<u8>)> {
    Some(match request {
        RpcRequest::AdmitClusterMember(r) => (ProcId::AdmitClusterMember, r.encode()),
        RpcRequest::RemoveClusterMember(r) => (ProcId::RemoveClusterMember, r.encode()),
        RpcRequest::SealPrimaryTransfer(r) => (ProcId::SealPrimaryTransfer, r.encode()),
        RpcRequest::AdoptClusterClient(r) => (ProcId::AdoptClusterClient, r.encode()),
        RpcRequest::RevokeClusterClientGrant(r) => (ProcId::RevokeClusterClientGrant, r.encode()),
        _ => return None,
    })
}
