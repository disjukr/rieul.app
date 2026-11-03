//! Cluster RPC boundary. No cluster identity is created during server startup.
use super::*;
use crate::cluster::runtime::{self, Authorized, RuntimeError};
use rieul_daemon_core::generated::rpc::*;

pub(super) fn is_cluster_proc(proc: u64) -> bool {
    matches!(
        ProcId::from_u64(proc),
        Some(
            ProcId::GetClusterPeerChallenge
                | ProcId::ExecuteClusterPeerRequest
                | ProcId::GetClusterState
                | ProcId::CreateCluster
                | ProcId::PrepareClusterJoin
                | ProcId::AdmitClusterMember
                | ProcId::FinishClusterJoin
                | ProcId::CancelClusterJoin
                | ProcId::RemoveClusterMember
                | ProcId::ReadClusterHistory
                | ProcId::PreparePrimaryTransfer
                | ProcId::SealPrimaryTransfer
                | ProcId::ActivateClusterPrimary
                | ProcId::ApplyClusterHistory
                | ProcId::BeginClusterClientAdoption
                | ProcId::CompleteClusterClientAdoption
                | ProcId::GetClusterClientAdoption
                | ProcId::AdoptClusterClient
                | ProcId::RevokeClusterClientGrant
        )
    )
}
// Bound nesting and item count before the generic CBOR decoder allocates/recurses.
pub(super) fn bounded_payload(bytes: &[u8]) -> bool {
    fn item(input: &[u8], at: &mut usize, depth: usize, budget: &mut usize) -> Option<()> {
        if depth > 16 || *budget == 0 {
            return None;
        }
        *budget -= 1;
        let header = *input.get(*at)?;
        *at += 1;
        let major = header >> 5;
        let ai = header & 31;
        let n = match ai {
            0..=23 => u64::from(ai),
            24..=27 => {
                let count = 1usize << (ai - 24);
                let end = at.checked_add(count)?;
                let encoded = input.get(*at..end)?;
                *at = end;
                encoded.iter().fold(0u64, |a, b| (a << 8) | u64::from(*b))
            }
            _ => return None,
        };
        match major {
            0 | 1 => {}
            2 | 3 => {
                let end = at.checked_add(usize::try_from(n).ok()?)?;
                input.get(*at..end)?;
                *at = end;
            }
            4 | 5 => {
                let count = n.checked_mul(if major == 5 { 2 } else { 1 })?;
                if count > *budget as u64 {
                    return None;
                }
                for _ in 0..count {
                    item(input, at, depth + 1, budget)?;
                }
            }
            7 if matches!(ai, 20..=22) => {}
            _ => return None,
        };
        Some(())
    }
    if bytes.len() > runtime::MAX_RPC_BYTES {
        return false;
    }
    let mut at = 0;
    let mut budget = 24000;
    item(bytes, &mut at, 0, &mut budget).is_some() && at == bytes.len()
}
impl HostRpcHandler {
    async fn cluster_call(&mut self, request: RpcRequest) -> Result<UnaryRpcOutcome> {
        let proc = request.proc_id().as_u64();
        let forwarding = runtime::peer::forwarding_payload(&request);
        let Some(client) = authenticated_client_id(&self.session_state).await else {
            return Ok(UnaryRpcOutcome::Message(unauthorized_message(proc)));
        };
        if load_runtime_client_credentials(&self.credentials_path, &self.client_credentials)
            .await
            .is_err()
        {
            return Ok(UnaryRpcOutcome::Message(unauthorized_message(proc)));
        }
        // Retain the credential guard through the transaction, serializing local
        // revocation with the operation. Expiry is rechecked inside the runtime.
        let records = self.client_credentials.clone().lock_owned().await;
        let Some(record) = records
            .clients
            .iter()
            .find(|r| r.client_id == client && r.expires_at_unix > now_unix())
        else {
            return Ok(UnaryRpcOutcome::Message(unauthorized_message(proc)));
        };
        let auth = Authorized {
            expires_at_unix: record.expires_at_unix,
            client_id: client.clone(),
            peer: None,
        };
        let path = self.config_path.with_extension("cluster.sqlite");
        let config = load_runtime_config(&self.config_path, &self.config_state).await?;
        let endpoint = format!("{}/rieul/rpc", pairing_daemon_url(&config));
        let forward_path = path.clone();
        let expires = auth.expires_at_unix;
        let result = tokio::task::spawn_blocking(move || {
            let _credentials = records;
            runtime::execute(&path, &auth, request, &endpoint)
        })
        .await
        .context("cluster runtime task failed")?;
        if matches!(result, Err(RuntimeError::PrimaryUnavailable)) {
            if let Some((inner, payload)) = forwarding {
                if expires <= now_unix() {
                    return Ok(UnaryRpcOutcome::Message(unauthorized_message(proc)));
                }
                load_runtime_client_credentials(&self.credentials_path, &self.client_credentials)
                    .await?;
                let records = self.client_credentials.clone().lock_owned().await;
                if !records
                    .clients
                    .iter()
                    .any(|r| r.client_id == client && r.expires_at_unix > now_unix())
                {
                    return Ok(UnaryRpcOutcome::Message(unauthorized_message(proc)));
                }
                let forwarded = runtime::worker::forward(
                    forward_path,
                    inner,
                    payload,
                    format!("paired:{client}"),
                )
                .await;
                drop(records);
                return Ok(UnaryRpcOutcome::Message(match forwarded {
                    Ok(payload) => ok_payload_message(proc, payload),
                    Err(_) => error_message(
                        proc,
                        "primary_unavailable",
                        "Cluster management is pending primary connectivity",
                    ),
                }));
            }
        }
        match result {
            Ok(response) => Ok(response.into()),
            Err(RuntimeError::Unauthorized) => {
                Ok(UnaryRpcOutcome::Message(unauthorized_message(proc)))
            }
            Err(error) => {
                let code = match error {
                    RuntimeError::InvalidProof => "invalid_proof",
                    RuntimeError::Conflict => "operation_conflict",
                    RuntimeError::PrimaryUnavailable => "primary_unavailable",
                    RuntimeError::AlreadyAffiliated => "already_affiliated",
                    RuntimeError::Retired => "retired",
                    RuntimeError::Limit => "limit_exceeded",
                    RuntimeError::InvalidState => "invalid_state",
                    _ => "failed",
                };
                Ok(UnaryRpcOutcome::Message(error_message(
                    proc,
                    code,
                    &format!("Cluster: {error:?}"),
                )))
            }
        }
    }
}
macro_rules! handler {
    ($fn:ident,$variant:ident,$req:ty) => {
        impl HostRpcHandler {
            pub(super) fn $fn<'a>(
                &'a mut self,
                request: $req,
            ) -> RpcHandlerFuture<'a, Result<UnaryRpcOutcome>> {
                Box::pin(async move { self.cluster_call(RpcRequest::$variant(request)).await })
            }
        }
    };
}
handler!(get_cluster_state_rpc, GetClusterState, ());
handler!(create_cluster_rpc, CreateCluster, CreateClusterReq);
handler!(
    prepare_cluster_join_rpc,
    PrepareClusterJoin,
    PrepareClusterJoinReq
);
handler!(
    admit_cluster_member_rpc,
    AdmitClusterMember,
    AdmitClusterMemberReq
);
handler!(
    finish_cluster_join_rpc,
    FinishClusterJoin,
    FinishClusterJoinReq
);
handler!(
    cancel_cluster_join_rpc,
    CancelClusterJoin,
    CancelClusterJoinReq
);
handler!(
    remove_cluster_member_rpc,
    RemoveClusterMember,
    RemoveClusterMemberReq
);
handler!(
    read_cluster_history_rpc,
    ReadClusterHistory,
    ReadClusterHistoryReq
);
handler!(
    prepare_primary_transfer_rpc,
    PreparePrimaryTransfer,
    PreparePrimaryTransferReq
);
handler!(
    seal_primary_transfer_rpc,
    SealPrimaryTransfer,
    SealPrimaryTransferReq
);
handler!(
    activate_cluster_primary_rpc,
    ActivateClusterPrimary,
    ActivateClusterPrimaryReq
);
handler!(
    apply_cluster_history_rpc,
    ApplyClusterHistory,
    ApplyClusterHistoryReq
);

#[cfg(test)]
mod tests {
    use super::super::desktop_rpc::tests::Fixture;
    use super::*;
    async fn ok(f: &Fixture, proc: ProcId, bytes: Option<Vec<u8>>) -> Vec<u8> {
        match f.unary(proc, bytes).await {
            ReqResMessage::ResponseUnaryOk {
                payload: Some(bytes),
            } => bytes,
            other => panic!("{proc:?}: {other:?}"),
        }
    }
    async fn get(f: &Fixture) -> ClusterState {
        ClusterState::decode(&ok(f, ProcId::GetClusterState, None).await).unwrap()
    }
    async fn history(f: &Fixture, cluster: Vec<u8>) -> ClusterHistory {
        ClusterHistory::decode(
            &ok(
                f,
                ProcId::ReadClusterHistory,
                Some(
                    ReadClusterHistoryReq {
                        cluster_id: cluster,
                    }
                    .encode(),
                ),
            )
            .await,
        )
        .unwrap()
    }
    fn member(state: ClusterState) -> (ClusterGenesis, ClusterHead, Vec<u8>) {
        match state {
            ClusterState::Member {
                genesis,
                head,
                local_admission_id,
                ..
            } => (genesis, head, local_admission_id),
            other => panic!("{other:?}"),
        }
    }
    #[tokio::test]
    async fn actual_webtransport_opt_in_join_transfer_and_revoked_receipt_access() {
        tokio::time::timeout(Duration::from_secs(20), async {
            let a = Fixture::new().await;
            let b = Fixture::new().await;
            let path = a._dir.path().join("rieul.cluster.sqlite");
            assert!(!path.exists());
            assert!(matches!(
                a.unary(ProcId::GetClusterState, None).await,
                ReqResMessage::ResponseUnaryError { .. }
            ));
            a.authenticate().await;
            b.authenticate().await;
            assert_eq!(get(&a).await, ClusterState::Unaffiliated);
            assert!(!path.exists());
            let create = CreateClusterReq {
                operation_id: vec![10; 32],
                confirmed: true,
            };
            let mut unconfirmed = create.clone();
            unconfirmed.confirmed = false;
            assert!(matches!(
                a.unary(ProcId::CreateCluster, Some(unconfirmed.encode()))
                    .await,
                ReqResMessage::ResponseUnaryError { .. }
            ));
            assert!(!path.exists());
            let initial =
                ClusterState::decode(&ok(&a, ProcId::CreateCluster, Some(create.encode())).await)
                    .unwrap();
            let (genesis, initial_head, _) = member(initial);
            let consent = ClusterJoinConsent::decode(
                &ok(
                    &b,
                    ProcId::PrepareClusterJoin,
                    Some(
                        PrepareClusterJoinReq {
                            operation_id: vec![11; 32],
                            genesis,
                            confirmed: true,
                        }
                        .encode(),
                    ),
                )
                .await,
            )
            .unwrap();
            let admit = AdmitClusterMemberReq {
                operation_id: vec![12; 32],
                expected_management_epoch: 1,
                consent: consent.clone(),
            };
            let mut forged = admit.clone();
            forged.consent.signature[0] ^= 1;
            assert!(matches!(
                a.unary(ProcId::AdmitClusterMember, Some(forged.encode()))
                    .await,
                ReqResMessage::ResponseUnaryError { .. }
            ));
            ok(&a, ProcId::AdmitClusterMember, Some(admit.encode())).await;
            let joined_history = history(&a, initial_head.cluster_id.clone()).await;
            ok(
                &b,
                ProcId::FinishClusterJoin,
                Some(
                    FinishClusterJoinReq {
                        operation_id: vec![11; 32],
                        history: joined_history.clone(),
                    }
                    .encode(),
                ),
            )
            .await;
            let (_, target_head, _) = member(get(&b).await);
            assert_eq!(target_head, joined_history.head);
            let acceptance = ClusterTransferAcceptance::decode(
                &ok(
                    &b,
                    ProcId::PreparePrimaryTransfer,
                    Some(
                        PreparePrimaryTransferReq {
                            operation_id: vec![13; 32],
                            expected_head: target_head,
                        }
                        .encode(),
                    ),
                )
                .await,
            )
            .unwrap();
            let seal = SealPrimaryTransferReq { acceptance };
            let first = ok(&a, ProcId::SealPrimaryTransfer, Some(seal.encode())).await;
            assert_eq!(
                ok(&a, ProcId::SealPrimaryTransfer, Some(seal.encode())).await,
                first
            );
            let transferred = history(&a, initial_head.cluster_id).await;
            assert!(matches!(
                b.unary(
                    ProcId::ApplyClusterHistory,
                    Some(
                        ApplyClusterHistoryReq {
                            history: transferred.clone()
                        }
                        .encode()
                    )
                )
                .await,
                ReqResMessage::ResponseUnaryError { .. }
            ));
            ok(
                &b,
                ProcId::ActivateClusterPrimary,
                Some(
                    ActivateClusterPrimaryReq {
                        operation_id: vec![13; 32],
                        history: transferred,
                    }
                    .encode(),
                ),
            )
            .await;
            let (_, new_head, _) = member(get(&b).await);
            assert_eq!(new_head.management_epoch, 2);
            assert!(matches!(
                get(&a).await,
                ClusterState::Member {
                    primary_transition: ClusterPrimaryTransition::Sealed,
                    ..
                }
            ));
            save_client_credentials(&a.credentials_path, &ClientCredentials::default()).unwrap();
            assert!(matches!(
                a.unary(ProcId::SealPrimaryTransfer, Some(seal.encode()))
                    .await,
                ReqResMessage::ResponseUnaryError { .. }
            ));
        })
        .await
        .unwrap();
    }
    #[tokio::test]
    async fn actual_webtransport_cancelled_join_rejects_old_admit_and_confirms_remote_removal() {
        tokio::time::timeout(Duration::from_secs(20), async {
            let a = Fixture::new().await;
            let b = Fixture::new().await;
            a.authenticate().await;
            b.authenticate().await;
            let (genesis, head, _) = member(
                ClusterState::decode(
                    &ok(
                        &a,
                        ProcId::CreateCluster,
                        Some(
                            CreateClusterReq {
                                operation_id: vec![1; 32],
                                confirmed: true,
                            }
                            .encode(),
                        ),
                    )
                    .await,
                )
                .unwrap(),
            );
            let consent = ClusterJoinConsent::decode(
                &ok(
                    &b,
                    ProcId::PrepareClusterJoin,
                    Some(
                        PrepareClusterJoinReq {
                            operation_id: vec![2; 32],
                            genesis,
                            confirmed: true,
                        }
                        .encode(),
                    ),
                )
                .await,
            )
            .unwrap();
            let admit = AdmitClusterMemberReq {
                operation_id: vec![3; 32],
                expected_management_epoch: 1,
                consent: consent.clone(),
            };
            ok(&a, ProcId::AdmitClusterMember, Some(admit.encode())).await;
            let stale = history(&a, head.cluster_id.clone()).await;
            ok(
                &b,
                ProcId::CancelClusterJoin,
                Some(
                    CancelClusterJoinReq {
                        operation_id: vec![2; 32],
                    }
                    .encode(),
                ),
            )
            .await;
            assert!(matches!(get(&b).await, ClusterState::RemovalPending { .. }));
            assert!(matches!(
                b.unary(
                    ProcId::FinishClusterJoin,
                    Some(
                        FinishClusterJoinReq {
                            operation_id: vec![2; 32],
                            history: stale
                        }
                        .encode()
                    )
                )
                .await,
                ReqResMessage::ResponseUnaryError { .. }
            ));
            ok(
                &a,
                ProcId::RemoveClusterMember,
                Some(
                    RemoveClusterMemberReq {
                        operation_id: vec![4; 32],
                        expected_management_epoch: 1,
                        admission_id: consent.admission_id,
                    }
                    .encode(),
                ),
            )
            .await;
            let latest = history(&a, head.cluster_id).await;
            ok(
                &b,
                ProcId::ApplyClusterHistory,
                Some(ApplyClusterHistoryReq { history: latest }.encode()),
            )
            .await;
            assert!(matches!(get(&b).await, ClusterState::Removed { .. }));
            // Old successful receipt is replayable but cannot recreate membership.
            ok(&a, ProcId::AdmitClusterMember, Some(admit.encode())).await;
            assert!(matches!(get(&b).await, ClusterState::Removed { .. }));
        })
        .await
        .unwrap();
    }
    #[tokio::test]
    async fn actual_webtransport_node_proof_and_automatic_adoption_retry() {
        tokio::time::timeout(Duration::from_secs(25), async {
            use rieul_daemon_core::cbor::Value;
            use ring::signature::{Ed25519KeyPair, KeyPair};
            let a = Fixture::new().await;
            let b = Fixture::new().await;
            a.authenticate().await;
            b.authenticate().await;
            let (genesis, head, _) = member(
                ClusterState::decode(
                    &ok(
                        &a,
                        ProcId::CreateCluster,
                        Some(
                            CreateClusterReq {
                                operation_id: vec![1; 32],
                                confirmed: true,
                            }
                            .encode(),
                        ),
                    )
                    .await,
                )
                .unwrap(),
            );
            let consent = ClusterJoinConsent::decode(
                &ok(
                    &b,
                    ProcId::PrepareClusterJoin,
                    Some(
                        PrepareClusterJoinReq {
                            operation_id: vec![2; 32],
                            genesis,
                            confirmed: true,
                        }
                        .encode(),
                    ),
                )
                .await,
            )
            .unwrap();
            ok(
                &a,
                ProcId::AdmitClusterMember,
                Some(
                    AdmitClusterMemberReq {
                        operation_id: vec![3; 32],
                        expected_management_epoch: 1,
                        consent,
                    }
                    .encode(),
                ),
            )
            .await;
            let h = history(&a, head.cluster_id.clone()).await;
            ok(
                &b,
                ProcId::FinishClusterJoin,
                Some(
                    FinishClusterJoinReq {
                        operation_id: vec![2; 32],
                        history: h,
                    }
                    .encode(),
                ),
            )
            .await;
            let path = b._dir.path().join("rieul.cluster.sqlite");
            let challenge =
                ClusterPeerChallenge::decode(&ok(&a, ProcId::GetClusterPeerChallenge, None).await)
                    .unwrap();
            let root_public: [u8; 32] = member(get(&a).await).0.root_public_key.try_into().unwrap();
            let proof = runtime::peer::sign(
                &path,
                root_public,
                &challenge,
                ProcId::ReadClusterHistory,
                ReadClusterHistoryReq {
                    cluster_id: head.cluster_id,
                }
                .encode(),
                "paired:fixture".into(),
            )
            .unwrap();
            ok(&a, ProcId::ExecuteClusterPeerRequest, Some(proof.encode())).await;
            assert!(matches!(
                a.unary(ProcId::ExecuteClusterPeerRequest, Some(proof.encode()))
                    .await,
                ReqResMessage::ResponseUnaryError { .. }
            ));
            let pair = Ed25519KeyPair::from_seed_unchecked(&[91; 32]).unwrap();
            let begin = BeginClusterClientAdoptionReq {
                client_public_key: pair.public_key().as_ref().to_vec(),
            };
            let challenge = ClusterClientAdoptionChallenge::decode(
                &ok(&b, ProcId::BeginClusterClientAdoption, Some(begin.encode())).await,
            )
            .unwrap();
            assert_eq!(
                ClusterClientAdoptionChallenge::decode(
                    &ok(&b, ProcId::BeginClusterClientAdoption, Some(begin.encode())).await
                )
                .unwrap(),
                challenge
            );
            let body = Value::Array(vec![
                Value::Text("rieul.cluster.client-possession.v1".into()),
                Value::Bytes(challenge.cluster_id.clone()),
                Value::Bytes(challenge.grant_id.clone()),
                Value::Bytes(challenge.issuer_admission_id.clone()),
                Value::Bytes(challenge.client_public_key.clone()),
                Value::U64(challenge.expires_at_unix as u64),
            ])
            .encode();
            let complete = CompleteClusterClientAdoptionReq {
                grant_id: challenge.grant_id.clone(),
                client_proof: pair.sign(&body).as_ref().to_vec(),
            };
            assert_eq!(
                ClusterClientAdoptionState::decode(
                    &ok(
                        &b,
                        ProcId::CompleteClusterClientAdoption,
                        Some(complete.encode())
                    )
                    .await
                )
                .unwrap(),
                ClusterClientAdoptionState::Pending
            );
            assert!(runtime::worker::tick(&path, &b._client).await.is_err());
            assert_eq!(
                ClusterClientAdoptionState::decode(
                    &ok(
                        &b,
                        ProcId::GetClusterClientAdoption,
                        Some(
                            GetClusterClientAdoptionReq {
                                grant_id: challenge.grant_id.clone()
                            }
                            .encode()
                        )
                    )
                    .await
                )
                .unwrap(),
                ClusterClientAdoptionState::Pending
            );
            runtime::worker::tick(&path, &a._client).await.unwrap();
            let response = ClusterClientAdoptionState::decode(
                &ok(
                    &b,
                    ProcId::GetClusterClientAdoption,
                    Some(
                        GetClusterClientAdoptionReq {
                            grant_id: challenge.grant_id.clone(),
                        }
                        .encode(),
                    ),
                )
                .await,
            )
            .unwrap();
            assert!(matches!(
                response,
                ClusterClientAdoptionState::Accepted { .. }
            ));
            let before = member(get(&a).await).1.sequence;
            runtime::worker::tick(&path, &a._client).await.unwrap();
            assert_eq!(member(get(&a).await).1.sequence, before);
        })
        .await
        .unwrap();
    }
    #[test]
    fn raw_cluster_input_limits_precede_generic_decoding() {
        assert!(bounded_payload(
            &CreateClusterReq {
                operation_id: vec![1; 32],
                confirmed: true
            }
            .encode()
        ));
        let mut deep = vec![0x81; 18];
        deep.push(0xf6);
        assert!(!bounded_payload(&deep));
        assert!(!bounded_payload(&vec![0; runtime::MAX_RPC_BYTES + 1]));
        assert!(!bounded_payload(&[
            0x9b, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff
        ]));
    }
}

handler!(
    begin_cluster_client_adoption_rpc,
    BeginClusterClientAdoption,
    BeginClusterClientAdoptionReq
);
handler!(
    complete_cluster_client_adoption_rpc,
    CompleteClusterClientAdoption,
    CompleteClusterClientAdoptionReq
);
handler!(
    get_cluster_client_adoption_rpc,
    GetClusterClientAdoption,
    GetClusterClientAdoptionReq
);
handler!(
    adopt_cluster_client_rpc,
    AdoptClusterClient,
    AdoptClusterClientReq
);
handler!(
    revoke_cluster_client_grant_rpc,
    RevokeClusterClientGrant,
    RevokeClusterClientGrantReq
);

struct PendingPeerChallenge {
    nonce: [u8; 32],
    issued: std::time::Instant,
    used: bool,
}
static PEER_CHALLENGES: std::sync::OnceLock<std::sync::Mutex<BTreeMap<u64, PendingPeerChallenge>>> =
    std::sync::OnceLock::new();
fn peer_challenges() -> &'static std::sync::Mutex<BTreeMap<u64, PendingPeerChallenge>> {
    PEER_CHALLENGES.get_or_init(Default::default)
}
pub(super) struct ConnectionCleanup(pub u64);
impl Drop for ConnectionCleanup {
    fn drop(&mut self) {
        if let Ok(mut challenges) = peer_challenges().lock() {
            challenges.remove(&self.0);
        }
    }
}
fn fresh_peer_challenge(connection: u64) -> Option<[u8; 32]> {
    use ring::rand::SecureRandom;
    let mut challenges = peer_challenges().lock().ok()?;
    let now = std::time::Instant::now();
    challenges.retain(|_, c| now.duration_since(c.issued) < Duration::from_secs(5));
    if challenges
        .get(&connection)
        .is_some_and(|c| now.duration_since(c.issued) < Duration::from_secs(1))
        || challenges.len() >= 128 && !challenges.contains_key(&connection)
    {
        return None;
    }
    let mut nonce = [0; 32];
    ring::rand::SystemRandom::new().fill(&mut nonce).ok()?;
    challenges.insert(
        connection,
        PendingPeerChallenge {
            nonce,
            issued: now,
            used: false,
        },
    );
    Some(nonce)
}
fn consume_peer_challenge(connection: u64, nonce: &[u8]) -> bool {
    let Ok(mut challenges) = peer_challenges().lock() else {
        return false;
    };
    let Some(challenge) = challenges.get_mut(&connection) else {
        return false;
    };
    if challenge.used
        || challenge.issued.elapsed() >= Duration::from_secs(5)
        || challenge.nonce != nonce
    {
        return false;
    }
    challenge.used = true;
    true
}
impl HostRpcHandler {
    pub(super) fn get_cluster_peer_challenge_rpc<'a>(
        &'a mut self,
        _: (),
    ) -> RpcHandlerFuture<'a, Result<UnaryRpcOutcome>> {
        Box::pin(async move {
            let connection = rpc_session_id(&self.session_state).await;
            let proc = ProcId::GetClusterPeerChallenge.as_u64();
            let Some(nonce) = fresh_peer_challenge(connection) else {
                return Ok(UnaryRpcOutcome::Message(error_message(
                    proc,
                    "limit_exceeded",
                    "Cluster challenge rate or capacity limit",
                )));
            };
            let path = self.config_path.with_extension("cluster.sqlite");
            match tokio::task::spawn_blocking(move || {
                runtime::peer::challenge(&path, connection, nonce)
            })
            .await?
            {
                Ok(challenge) => Ok(RpcResponse::GetClusterPeerChallenge(challenge).into()),
                Err(_) => Ok(UnaryRpcOutcome::Message(unauthorized_message(proc))),
            }
        })
    }
    pub(super) fn execute_cluster_peer_request_rpc<'a>(
        &'a mut self,
        r: ClusterPeerRequest,
    ) -> RpcHandlerFuture<'a, Result<UnaryRpcOutcome>> {
        Box::pin(async move {
            let proc = ProcId::ExecuteClusterPeerRequest.as_u64();
            let connection = rpc_session_id(&self.session_state).await;
            if r.connection_id <= 0
                || r.connection_id as u64 != connection
                || !consume_peer_challenge(connection, &r.nonce)
            {
                return Ok(UnaryRpcOutcome::Message(unauthorized_message(proc)));
            }
            let Some(inner) = u64::try_from(r.procedure_id)
                .ok()
                .and_then(ProcId::from_u64)
            else {
                return Ok(UnaryRpcOutcome::Message(unauthorized_message(proc)));
            };
            if !runtime::peer::permitted(inner) || !bounded_payload(&r.payload) {
                return Ok(UnaryRpcOutcome::Message(unauthorized_message(proc)));
            }
            let path = self.config_path.with_extension("cluster.sqlite");
            let config = load_runtime_config(&self.config_path, &self.config_state).await?;
            let endpoint = format!("{}/rieul/rpc", pairing_daemon_url(&config));
            let result = tokio::task::spawn_blocking(move || {
                let auth = runtime::peer::authenticate(&path, &r)?;
                let request = RpcRequest::decode(inner.as_u64(), Some(&r.payload))
                    .map_err(|_| RuntimeError::InvalidProof)?;
                runtime::execute(&path, &auth, request, &endpoint)
            })
            .await?;
            match result {
                Ok(response) => Ok(RpcResponse::ExecuteClusterPeerRequest(ClusterPeerResponse {
                    payload: response.encode_payload().unwrap_or_default(),
                })
                .into()),
                Err(RuntimeError::PrimaryUnavailable) => {
                    Ok(UnaryRpcOutcome::Message(error_message(
                        proc,
                        "primary_unavailable",
                        "Cluster primary is unavailable or management epoch changed",
                    )))
                }
                Err(RuntimeError::Limit) => Ok(UnaryRpcOutcome::Message(error_message(
                    proc,
                    "limit_exceeded",
                    "Cluster history or request exceeds limits",
                ))),
                Err(_) => Ok(UnaryRpcOutcome::Message(unauthorized_message(proc))),
            }
        })
    }
}
