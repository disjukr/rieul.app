//! Cluster RPC boundary. No cluster identity is created during server startup.
use super::*;
use crate::cluster::runtime::{self, Authorized, RuntimeError};
use rieul_daemon_core::generated::rpc::*;

pub(super) fn is_cluster_proc(proc: u64) -> bool {
    matches!(
        ProcId::from_u64(proc),
        Some(
            ProcId::AuthenticateClusterClient
                | ProcId::ReadClusterJoinHistory
                | ProcId::ConfigureClusterJoinSync
                | ProcId::GetClusterRevocationIssues
                | ProcId::LeaveCluster
                | ProcId::GetClusterRemovalProof
                | ProcId::GetClusterPeerChallenge
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
        let principal = self.session_state.lock().await.cluster_principal.clone();
        let record = records
            .clients
            .iter()
            .find(|r| r.client_id == client && r.expires_at_unix > now_unix());
        let expires_at_unix = if let Some((path, grant)) = principal.clone() {
            match tokio::task::spawn_blocking(move || runtime::client::validate(&path, &grant))
                .await?
            {
                Ok(expires) => expires,
                Err(_) => return Ok(UnaryRpcOutcome::Message(unauthorized_message(proc))),
            }
        } else if let Some(record) = record {
            record.expires_at_unix
        } else {
            return Ok(UnaryRpcOutcome::Message(unauthorized_message(proc)));
        };
        let auth = Authorized {
            expires_at_unix,
            client_id: client.clone(),
            grant: principal.clone().map(|(_, grant)| grant),
            peer: None,
        };
        let path = self.config_path.with_extension("cluster.sqlite");
        let config = load_runtime_config(&self.config_path, &self.config_state).await?;
        let endpoint = format!("{}/rieul/rpc", pairing_daemon_url(&config));
        let forward_path = path.clone();
        let expires = auth.expires_at_unix;
        let result = tokio::task::spawn_blocking(move || {
            let active: Vec<_> = records
                .clients
                .iter()
                .filter(|r| r.expires_at_unix > now_unix())
                .map(|r| r.client_id.clone())
                .collect();
            let _credentials = records;
            runtime::reconcile_pairing_revocations(&path, &active)?;
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
                if principal.is_some() {
                    if !is_authenticated(&self.session_state).await {
                        return Ok(UnaryRpcOutcome::Message(unauthorized_message(proc)));
                    }
                } else if !records
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
                    principal
                        .as_ref()
                        .map(|(_, grant)| grant.origin())
                        .unwrap_or_else(|| ClusterOriginalPrincipal::LocalPairing {
                            client_id: client.clone(),
                        }),
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
handler!(
    get_cluster_removal_proof_rpc,
    GetClusterRemovalProof,
    ReadClusterHistoryReq
);
handler!(
    get_cluster_revocation_issues_rpc,
    GetClusterRevocationIssues,
    ()
);
handler!(leave_cluster_rpc, LeaveCluster, LeaveClusterReq);
handler!(
    configure_cluster_join_sync_rpc,
    ConfigureClusterJoinSync,
    ConfigureClusterJoinSyncReq
);
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

#[cfg(all(test, not(windows)))]
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
    async fn raw_join_call(
        session: &web_transport_quinn::Session,
        proc: ProcId,
        payload: Option<Vec<u8>>,
    ) -> ReqResMessage {
        let (mut send, mut recv) = session.open_bi().await.unwrap();
        send.write_all(
            &ReqResMessage::RequestUnary {
                proc_id: proc.as_u64(),
                payload,
            }
            .encode(),
        )
        .await
        .unwrap();
        send.finish().unwrap();
        ReqResMessage::decode_sequence(
            &recv
                .read_to_end(runtime::MAX_RPC_BYTES + 4096)
                .await
                .unwrap(),
        )
        .unwrap()
        .remove(0)
    }
    async fn blocked_import_survives_disconnect(
        f: &Fixture,
        session: &web_transport_quinn::Session,
        history: ClusterHistory,
    ) {
        let path = f._dir.path().join("rieul.cluster.sqlite");
        let mut writer = rusqlite::Connection::open(path).unwrap();
        let held = writer
            .transaction_with_behavior(rusqlite::TransactionBehavior::Immediate)
            .unwrap();
        let baseline = f.gate.active();
        let (mut send, recv) = session.open_bi().await.unwrap();
        send.write_all(
            &ReqResMessage::RequestUnary {
                proc_id: ProcId::ApplyClusterHistory.as_u64(),
                payload: Some(ApplyClusterHistoryReq { history }.encode()),
            }
            .encode(),
        )
        .await
        .unwrap();
        send.finish().unwrap();
        tokio::time::timeout(Duration::from_secs(2), async {
            while f.gate.active() <= baseline {
                tokio::task::yield_now().await;
            }
        })
        .await
        .unwrap();
        tokio::time::sleep(Duration::from_millis(100)).await;
        session.close(0, b"disconnect during blocked mutation");
        tokio::time::sleep(Duration::from_millis(150)).await;
        assert!(
            f.gate.active() > 0,
            "admitted blocking operation retains its guard"
        );
        assert!(f.gate.begin_drain().is_none());
        held.rollback().unwrap();
        drop(recv);
        tokio::time::timeout(Duration::from_secs(3), async {
            while f.gate.active() != 0 {
                tokio::task::yield_now().await;
            }
        })
        .await
        .unwrap();
        assert!(f.gate.begin_drain().is_some());
    }
    #[tokio::test]
    async fn paired_disconnect_does_not_release_drain_before_blocking_operation_finishes() {
        tokio::time::timeout(Duration::from_secs(10), async {
            let f = Fixture::new().await;
            f.authenticate().await;
            let state = ClusterState::decode(
                &ok(
                    &f,
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
            .unwrap();
            let (_, head, _) = member(state);
            let history = history(&f, head.cluster_id).await;
            blocked_import_survives_disconnect(&f, &f.session, history).await;
        })
        .await
        .unwrap();
    }
    #[tokio::test]
    async fn actual_webtransport_join_sync_is_consent_bound_and_never_authenticates_session() {
        tokio::time::timeout(Duration::from_secs(25), async {
            for cancel in [false, true] {
                let a = Fixture::new().await;
                let b = Fixture::new().await;
                a.authenticate().await;
                b.authenticate().await;
                let initial = ClusterState::decode(
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
                .unwrap();
                let (g, head, _) = member(initial);
                let c = ClusterJoinConsent::decode(
                    &ok(
                        &b,
                        ProcId::PrepareClusterJoin,
                        Some(
                            PrepareClusterJoinReq {
                                operation_id: vec![2; 32],
                                genesis: g.clone(),
                                confirmed: true,
                            }
                            .encode(),
                        ),
                    )
                    .await,
                )
                .unwrap();
                let bootstrap = history(&a, head.cluster_id.clone()).await;
                let mut wrong = bootstrap.clone();
                wrong.genesis.nonce[0] ^= 1;
                assert!(matches!(
                    b.unary(
                        ProcId::ConfigureClusterJoinSync,
                        Some(
                            ConfigureClusterJoinSyncReq {
                                operation_id: vec![2; 32],
                                bootstrap_history: wrong
                            }
                            .encode()
                        )
                    )
                    .await,
                    ReqResMessage::ResponseUnaryError { .. }
                ));
                ok(
                    &b,
                    ProcId::ConfigureClusterJoinSync,
                    Some(
                        ConfigureClusterJoinSyncReq {
                            operation_id: vec![2; 32],
                            bootstrap_history: bootstrap,
                        }
                        .encode(),
                    ),
                )
                .await;
                let path = b._dir.path().join("rieul.cluster.sqlite");
                let public: [u8; 32] = g.root_public_key.clone().try_into().unwrap();
                assert!(runtime::worker::join_exchange(
                    &a._client,
                    &path,
                    public,
                    &g.root_endpoint
                )
                .await
                .is_err());
                assert!(matches!(get(&b).await, ClusterState::Joining { .. }));
                ok(
                    &a,
                    ProcId::AdmitClusterMember,
                    Some(
                        AdmitClusterMemberReq {
                            operation_id: vec![3; 32],
                            expected_management_epoch: 1,
                            consent: c,
                        }
                        .encode(),
                    ),
                )
                .await;
                let session = a
                    ._client
                    .connect(web_transport_quinn::proto::ConnectRequest::new(
                        url::Url::parse(&g.root_endpoint).unwrap(),
                    ))
                    .await
                    .unwrap();
                let challenge =
                    match raw_join_call(&session, ProcId::GetClusterPeerChallenge, None).await {
                        ReqResMessage::ResponseUnaryOk {
                            payload: Some(bytes),
                        } => ClusterPeerChallenge::decode(&bytes).unwrap(),
                        x => panic!("{x:?}"),
                    };
                let request = runtime::join::sign(&path, public, &challenge).unwrap();
                let response = raw_join_call(
                    &session,
                    ProcId::ReadClusterJoinHistory,
                    Some(request.encode()),
                )
                .await;
                let h = match response {
                    ReqResMessage::ResponseUnaryOk {
                        payload: Some(bytes),
                    } => ClusterHistory::decode(&bytes).unwrap(),
                    x => panic!("{x:?}"),
                };
                assert!(matches!(
                    raw_join_call(
                        &session,
                        ProcId::ReadClusterJoinHistory,
                        Some(request.encode())
                    )
                    .await,
                    ReqResMessage::ResponseUnaryError { .. }
                ));
                assert!(matches!(
                    raw_join_call(
                        &session,
                        ProcId::ReadClusterHistory,
                        Some(
                            ReadClusterHistoryReq {
                                cluster_id: head.cluster_id
                            }
                            .encode()
                        )
                    )
                    .await,
                    ReqResMessage::ResponseUnaryError { .. }
                ));
                session.close(0, b"fixture complete");
                if cancel {
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
                    assert!(matches!(
                        b.unary(
                            ProcId::FinishClusterJoin,
                            Some(
                                FinishClusterJoinReq {
                                    operation_id: vec![2; 32],
                                    history: h
                                }
                                .encode()
                            )
                        )
                        .await,
                        ReqResMessage::ResponseUnaryError { .. }
                    ));
                    assert!(runtime::worker::join_exchange(
                        &a._client,
                        &path,
                        public,
                        &g.root_endpoint
                    )
                    .await
                    .is_err());
                    assert!(matches!(get(&b).await, ClusterState::RemovalPending { .. }));
                } else {
                    runtime::worker::tick(&path, &a._client).await.unwrap();
                    assert!(matches!(get(&b).await, ClusterState::Member { .. }));
                }
            }
        })
        .await
        .unwrap();
    }
    #[tokio::test]
    async fn actual_webtransport_leave_waits_for_primary_and_recovers_lost_remove_response() {
        tokio::time::timeout(Duration::from_secs(25), async {
            for lose_response in [false, true] {
                let a = Fixture::new().await;
                let b = Fixture::new().await;
                a.authenticate().await;
                b.authenticate().await;
                let created = ClusterState::decode(
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
                .unwrap();
                let (genesis, head, _) = member(created);
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
                let admission = consent.admission_id.clone();
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
                ok(
                    &b,
                    ProcId::FinishClusterJoin,
                    Some(
                        FinishClusterJoinReq {
                            operation_id: vec![2; 32],
                            history: history(&a, head.cluster_id).await,
                        }
                        .encode(),
                    ),
                )
                .await;
                let leave = LeaveClusterReq {
                    operation_id: vec![4; 32],
                };
                assert!(matches!(
                    a.unary(ProcId::LeaveCluster, Some(leave.encode())).await,
                    ReqResMessage::ResponseUnaryError { .. }
                ));
                let pending = ok(&b, ProcId::LeaveCluster, Some(leave.encode())).await;
                assert!(matches!(
                    ClusterState::decode(&pending).unwrap(),
                    ClusterState::Leaving { .. }
                ));
                assert_eq!(
                    ok(&b, ProcId::LeaveCluster, Some(leave.encode())).await,
                    pending
                );
                let path = b._dir.path().join("rieul.cluster.sqlite");
                assert!(runtime::worker::tick(&path, &b._client).await.is_err());
                assert!(matches!(get(&b).await, ClusterState::Leaving { .. }));
                if lose_response {
                    // Commit at the primary but deliberately never apply the
                    // returned entry at B, modeling response loss/restart.
                    ok(
                        &a,
                        ProcId::RemoveClusterMember,
                        Some(
                            RemoveClusterMemberReq {
                                operation_id: leave.operation_id.clone(),
                                expected_management_epoch: 1,
                                admission_id: admission,
                            }
                            .encode(),
                        ),
                    )
                    .await;
                }
                runtime::worker::tick(&path, &a._client).await.unwrap();
                assert!(matches!(get(&b).await, ClusterState::Removed { .. }));
                assert!(matches!(
                    ClusterState::decode(&ok(&b, ProcId::LeaveCluster, Some(leave.encode())).await)
                        .unwrap(),
                    ClusterState::Removed { .. }
                ));
                assert!(matches!(
                    b.unary(
                        ProcId::LeaveCluster,
                        Some(
                            LeaveClusterReq {
                                operation_id: vec![5; 32]
                            }
                            .encode()
                        )
                    )
                    .await,
                    ReqResMessage::ResponseUnaryError { .. }
                ));
                assert_eq!(member(get(&a).await).1.sequence, 2);
                ok(
                    &b,
                    ProcId::CreateCluster,
                    Some(
                        CreateClusterReq {
                            operation_id: vec![6; 32],
                            confirmed: true,
                        }
                        .encode(),
                    ),
                )
                .await;
                assert!(matches!(
                    b.unary(ProcId::LeaveCluster, Some(leave.encode())).await,
                    ReqResMessage::ResponseUnaryError { .. }
                ));
                assert!(matches!(get(&b).await, ClusterState::Member { .. }));
            }
        })
        .await
        .unwrap();
    }
    #[tokio::test]
    async fn actual_webtransport_discovers_transferred_primary_after_old_primary_stops() {
        tokio::time::timeout(Duration::from_secs(25), async {
            let a = Fixture::new().await;
            let b = Fixture::new().await;
            let c = Fixture::new().await;
            for f in [&a, &b, &c] {
                f.authenticate().await;
            }
            let initial = ClusterState::decode(
                &ok(
                    &a,
                    ProcId::CreateCluster,
                    Some(
                        CreateClusterReq {
                            operation_id: vec![101; 32],
                            confirmed: true,
                        }
                        .encode(),
                    ),
                )
                .await,
            )
            .unwrap();
            let (genesis, head, _) = member(initial);
            for (f, operation) in [(&b, 102), (&c, 104)] {
                let consent = ClusterJoinConsent::decode(
                    &ok(
                        f,
                        ProcId::PrepareClusterJoin,
                        Some(
                            PrepareClusterJoinReq {
                                operation_id: vec![operation; 32],
                                genesis: genesis.clone(),
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
                            operation_id: vec![operation + 1; 32],
                            expected_management_epoch: 1,
                            consent,
                        }
                        .encode(),
                    ),
                )
                .await;
                ok(
                    f,
                    ProcId::FinishClusterJoin,
                    Some(
                        FinishClusterJoinReq {
                            operation_id: vec![operation; 32],
                            history: history(&a, head.cluster_id.clone()).await,
                        }
                        .encode(),
                    ),
                )
                .await;
            }
            let before = history(&a, head.cluster_id.clone()).await;
            ok(
                &b,
                ProcId::ApplyClusterHistory,
                Some(
                    ApplyClusterHistoryReq {
                        history: before.clone(),
                    }
                    .encode(),
                ),
            )
            .await;
            let acceptance = ClusterTransferAcceptance::decode(
                &ok(
                    &b,
                    ProcId::PreparePrimaryTransfer,
                    Some(
                        PreparePrimaryTransferReq {
                            operation_id: vec![106; 32],
                            expected_head: before.head.clone(),
                        }
                        .encode(),
                    ),
                )
                .await,
            )
            .unwrap();
            ok(
                &a,
                ProcId::SealPrimaryTransfer,
                Some(SealPrimaryTransferReq { acceptance }.encode()),
            )
            .await;
            let transferred = history(&a, head.cluster_id).await;
            ok(
                &b,
                ProcId::ActivateClusterPrimary,
                Some(
                    ActivateClusterPrimaryReq {
                        operation_id: vec![106; 32],
                        history: transferred.clone(),
                    }
                    .encode(),
                ),
            )
            .await;
            // C only knows A as primary. The newly active B is one of its
            // already authenticated cached members, not an external hint.
            assert_eq!(member(get(&c).await).1.management_epoch, 1);
            drop(a);
            let path = c._dir.path().join("rieul.cluster.sqlite");
            runtime::worker::tick(&path, &b._client).await.unwrap();
            assert_eq!(member(get(&c).await).1, transferred.head);
            // Repeat remains idempotent and cannot elect or manufacture a log.
            runtime::worker::tick(&path, &b._client).await.unwrap();
            assert_eq!(member(get(&c).await).1, transferred.head);
        })
        .await
        .unwrap();
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
            assert!(matches!(
                a.unary(ProcId::GetClusterRevocationIssues, None).await,
                ReqResMessage::ResponseUnaryError { .. }
            ));
            a.authenticate().await;
            b.authenticate().await;
            assert!(ClusterRevocationIssues::decode(
                &ok(&a, ProcId::GetClusterRevocationIssues, None).await
            )
            .unwrap()
            .issues
            .is_empty());
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
            // A durable acceptance cannot be discarded by Cancel, either
            // before sealing or after activation.
            assert!(matches!(
                b.unary(
                    ProcId::CancelClusterJoin,
                    Some(
                        CancelClusterJoinReq {
                            operation_id: vec![12; 32],
                        }
                        .encode()
                    )
                )
                .await,
                ReqResMessage::ResponseUnaryError { .. }
            ));
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
                ClusterOriginalPrincipal::LocalPairing {
                    client_id: "fixture".into(),
                },
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
            // New connections possess only the adopted client key, never a paired secret.
            let mut grant_sessions = Vec::new();
            let mut held_streams = Vec::new();
            for fixture in [&a, &b] {
                let ClusterState::Member {
                    head,
                    local_admission_id,
                    members,
                    ..
                } = get(fixture).await
                else {
                    panic!()
                };
                let target = members
                    .iter()
                    .find(|m| m.admission_id == local_admission_id)
                    .unwrap();
                let session = fixture
                    ._client
                    .connect(url::Url::parse(&target.endpoint).unwrap())
                    .await
                    .unwrap();
                assert!(matches!(
                    raw_join_call(&session, ProcId::GetDaemonEnvironment, None).await,
                    ReqResMessage::ResponseUnaryError { .. }
                ));
                let ReqResMessage::ResponseUnaryOk {
                    payload: Some(bytes),
                } = raw_join_call(&session, ProcId::GetClusterPeerChallenge, None).await
                else {
                    panic!()
                };
                let nonce = ClusterPeerChallenge::decode(&bytes).unwrap();
                let mut request = AuthenticateClusterClientReq {
                    known_head: head,
                    server_admission_id: local_admission_id,
                    server_public_key: target.node_public_key.clone(),
                    grant_id: challenge.grant_id.clone(),
                    client_public_key: pair.public_key().as_ref().to_vec(),
                    nonce: nonce.nonce,
                    connection_id: nonce.connection_id,
                    signature: Vec::new(),
                };
                request.signature = pair
                    .sign(&runtime::client::proof_body(&request).unwrap())
                    .as_ref()
                    .to_vec();
                assert!(matches!(
                    raw_join_call(
                        &session,
                        ProcId::AuthenticateClusterClient,
                        Some(request.encode())
                    )
                    .await,
                    ReqResMessage::ResponseUnaryOk { .. }
                ));
                assert!(matches!(
                    raw_join_call(
                        &session,
                        ProcId::AuthenticateClusterClient,
                        Some(request.encode())
                    )
                    .await,
                    ReqResMessage::ResponseUnaryError { .. }
                ));
                assert!(matches!(
                    raw_join_call(&session, ProcId::GetDaemonEnvironment, None).await,
                    ReqResMessage::ResponseUnaryOk { .. }
                ));
                assert!(matches!(
                    raw_join_call(&session, ProcId::GetDesktopCapabilities, None).await,
                    ReqResMessage::ResponseUnaryOk { .. }
                ));
                assert!(matches!(
                    raw_join_call(
                        &session,
                        ProcId::ReadClusterHistory,
                        Some(
                            ReadClusterHistoryReq {
                                cluster_id: challenge.cluster_id.clone()
                            }
                            .encode()
                        )
                    )
                    .await,
                    ReqResMessage::ResponseUnaryOk { .. }
                ));
                held_streams.push(fixture.hold_key_on(&session).await);
                grant_sessions.push(session);
            }
            // Grant-authenticated connection cancellation has the same drain boundary.
            let latest = history(&b, challenge.cluster_id.clone()).await;
            blocked_import_survives_disconnect(&b, &grant_sessions[1], latest).await;
            b.assert_control_released().await;
            // Reconnect explicitly so later removal still tests a live grant session.
            let ClusterState::Member {
                head,
                local_admission_id,
                members,
                ..
            } = get(&b).await
            else {
                panic!()
            };
            let target = members
                .iter()
                .find(|m| m.admission_id == local_admission_id)
                .unwrap();
            let reconnected = b
                ._client
                .connect(url::Url::parse(&target.endpoint).unwrap())
                .await
                .unwrap();
            let ReqResMessage::ResponseUnaryOk {
                payload: Some(bytes),
            } = raw_join_call(&reconnected, ProcId::GetClusterPeerChallenge, None).await
            else {
                panic!()
            };
            let nonce = ClusterPeerChallenge::decode(&bytes).unwrap();
            let mut request = AuthenticateClusterClientReq {
                known_head: head,
                server_admission_id: local_admission_id,
                server_public_key: target.node_public_key.clone(),
                grant_id: challenge.grant_id.clone(),
                client_public_key: pair.public_key().as_ref().to_vec(),
                nonce: nonce.nonce,
                connection_id: nonce.connection_id,
                signature: vec![],
            };
            request.signature = pair
                .sign(&runtime::client::proof_body(&request).unwrap())
                .as_ref()
                .to_vec();
            assert!(matches!(
                raw_join_call(
                    &reconnected,
                    ProcId::AuthenticateClusterClient,
                    Some(request.encode())
                )
                .await,
                ReqResMessage::ResponseUnaryOk { .. }
            ));
            held_streams.push(b.hold_key_on(&reconnected).await);
            grant_sessions[1] = reconnected;
            let before = member(get(&a).await).1.sequence;
            runtime::worker::tick(&path, &a._client).await.unwrap();
            assert_eq!(member(get(&a).await).1.sequence, before);
            let (_, head, bid) = member(get(&b).await);
            ok(
                &a,
                ProcId::RemoveClusterMember,
                Some(
                    RemoveClusterMemberReq {
                        operation_id: vec![110; 32],
                        expected_management_epoch: 1,
                        admission_id: bid,
                    }
                    .encode(),
                ),
            )
            .await;
            // An unrelated later record must not be exposed to the removed node.
            ok(
                &a,
                ProcId::RevokeClusterClientGrant,
                Some(
                    RevokeClusterClientGrantReq {
                        operation_id: vec![111; 32],
                        expected_management_epoch: 1,
                        grant_id: vec![112; 32],
                    }
                    .encode(),
                ),
            )
            .await;
            let endpoint = member(get(&a).await).0.root_endpoint;
            assert!(runtime::worker::call(
                &a._client,
                &path,
                root_public,
                &endpoint,
                ProcId::ReadClusterHistory,
                ReadClusterHistoryReq {
                    cluster_id: head.cluster_id.clone()
                }
                .encode(),
                ClusterOriginalPrincipal::Node
            )
            .await
            .is_err());
            let proof = runtime::worker::call(
                &a._client,
                &path,
                root_public,
                &endpoint,
                ProcId::GetClusterRemovalProof,
                ReadClusterHistoryReq {
                    cluster_id: head.cluster_id,
                }
                .encode(),
                ClusterOriginalPrincipal::Node,
            )
            .await
            .unwrap();
            let proof = ClusterHistory::decode(&proof).unwrap();
            assert_eq!(proof.head.sequence, before + 1);
            assert_eq!(member(get(&a).await).1.sequence, before + 2);
            runtime::worker::tick(&path, &a._client).await.unwrap();
            assert!(matches!(get(&b).await, ClusterState::Removed { .. }));
            // Issuer removal does not revoke the already adopted grant on A.
            assert!(matches!(
                raw_join_call(&grant_sessions[0], ProcId::GetDaemonEnvironment, None).await,
                ReqResMessage::ResponseUnaryOk { .. }
            ));
            tokio::time::timeout(Duration::from_secs(2), grant_sessions[1].closed())
                .await
                .unwrap();
            b.assert_control_released().await;
            ok(
                &a,
                ProcId::RevokeClusterClientGrant,
                Some(
                    RevokeClusterClientGrantReq {
                        operation_id: vec![113; 32],
                        expected_management_epoch: 1,
                        grant_id: challenge.grant_id,
                    }
                    .encode(),
                ),
            )
            .await;
            tokio::time::timeout(Duration::from_secs(2), grant_sessions[0].closed())
                .await
                .unwrap();
            a.assert_control_released().await;
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
            load_runtime_client_credentials(&self.credentials_path, &self.client_credentials)
                .await?;
            let records = self.client_credentials.clone().lock_owned().await;
            let result = tokio::task::spawn_blocking(move || {
                let auth = runtime::peer::authenticate(&path, &r)?;
                let active: Vec<_> = records
                    .clients
                    .iter()
                    .filter(|r| r.expires_at_unix > now_unix())
                    .map(|r| r.client_id.clone())
                    .collect();
                let _credentials = records;
                runtime::reconcile_pairing_revocations(&path, &active)?;
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

impl HostRpcHandler {
    pub(super) fn read_cluster_join_history_rpc<'a>(
        &'a mut self,
        r: ReadClusterJoinHistoryReq,
    ) -> RpcHandlerFuture<'a, Result<UnaryRpcOutcome>> {
        Box::pin(async move {
            let proc = ProcId::ReadClusterJoinHistory.as_u64();
            let connection = self.session_state.lock().await.session_id;
            if r.connection_id != connection as i64 || !consume_peer_challenge(connection, &r.nonce)
            {
                return Ok(UnaryRpcOutcome::Message(unauthorized_message(proc)));
            }
            let path = self.config_path.with_extension("cluster.sqlite");
            let result = tokio::task::spawn_blocking(move || runtime::join::read(&path, r)).await?;
            Ok(match result {
                Ok(history) => RpcResponse::ReadClusterJoinHistory(history).into(),
                Err(_) => UnaryRpcOutcome::Message(unauthorized_message(proc)),
            })
        })
    }
}

impl HostRpcHandler {
    pub(super) fn authenticate_cluster_client_rpc<'a>(
        &'a mut self,
        request: AuthenticateClusterClientReq,
    ) -> RpcHandlerFuture<'a, Result<UnaryRpcOutcome>> {
        Box::pin(async move {
            let proc = ProcId::AuthenticateClusterClient.as_u64();
            let connection = rpc_session_id(&self.session_state).await;
            if request.connection_id != connection as i64
                || !consume_peer_challenge(connection, &request.nonce)
            {
                return Ok(UnaryRpcOutcome::Message(unauthorized_message(proc)));
            }
            let path = self.config_path.with_extension("cluster.sqlite");
            let auth_path = path.clone();
            let result = tokio::task::spawn_blocking(move || {
                runtime::client::authenticate(&auth_path, &request)
            })
            .await?;
            match result {
                Ok((principal, history)) => {
                    let mut state = self.session_state.lock().await;
                    if state.authenticated_client_id.is_some() || state.cluster_principal.is_some()
                    {
                        return Ok(UnaryRpcOutcome::Message(unauthorized_message(proc)));
                    }
                    state.authenticated_client_id = Some(principal.subject());
                    state.cluster_principal = Some((path, principal));
                    Ok(RpcResponse::AuthenticateClusterClient(history).into())
                }
                Err(_) => Ok(UnaryRpcOutcome::Message(unauthorized_message(proc))),
            }
        })
    }
}
