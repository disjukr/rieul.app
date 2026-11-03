import * as rpc from "../protocol/generated/client.ts";
import {
  ProcId,
  type ClusterState,
  type AuthenticateClusterClientReq,
} from "../protocol/generated/rpc.ts";
import type { Machine } from "../state/machines.ts";
import {
  clusterKey,
  readCluster,
  storeHistory,
  resetGrantAfterPairing,
  type ClusterRecord,
} from "./storage.ts";
import {
  adoptionBody,
  endpoint,
  hex,
  same,
  sessionBody,
  sign,
  verify,
  verifyHistory,
} from "./trust.ts";
export interface ClusterStatus {
  message: string;
  supported: boolean;
  state?: ClusterState;
  record?: ClusterRecord;
}
export async function authenticateCluster(
  transport: WebTransport,
  machine: Machine,
): Promise<ClusterRecord> {
  const binding = machine.cluster;
  if (!binding) throw new Error("Missing cluster membership");
  const saved = await readCluster(binding.id);
  if (!saved?.history || !saved.grantId)
    throw new Error(
      "Cluster key or accepted grant is missing. Pair with a cluster member again.",
    );
  const verified = await verifyHistory(saved.history);
  const target = verified.members.get(binding.admissionId);
  const grant = verified.grants.get(hex(saved.grantId));
  if (
    !target ||
    endpoint(target.endpoint) !== new URL(machine.baseUrl).origin ||
    !grant ||
    !same(grant.client, saved.publicKey) ||
    grant.expires * 1000 <= Date.now()
  )
    throw new Error("Cluster member or grant is no longer valid");
  const nonce = await rpc.getClusterPeerChallenge(transport);
  await verify(
    target.nodePublicKey,
    [
      "rieul.cluster.peer-server.v1",
      verified.head.clusterId,
      target.nodePublicKey,
      nonce.connectionId,
      nonce.nonce,
    ],
    nonce.serverProof,
  );
  const request: AuthenticateClusterClientReq = {
    knownHead: verified.head,
    serverAdmissionId: target.admissionId,
    serverPublicKey: target.nodePublicKey,
    grantId: saved.grantId,
    clientPublicKey: saved.publicKey,
    nonce: nonce.nonce,
    connectionId: nonce.connectionId,
    signature: new Uint8Array(),
  };
  request.signature = await sign(saved.privateKey, sessionBody(request));
  const history = await rpc.authenticateClusterClient(transport, request);
  await verifyHistory(history, saved.history);
  return storeHistory(history, saved.grantId);
}
export async function synchronizeCluster(
  transport: WebTransport,
  machine: Machine,
  supportedProcIds: number[],
  newPairing = false,
): Promise<ClusterStatus> {
  if (!supportedProcIds.includes(ProcId.AuthenticateClusterClient))
    return {
      supported: false,
      message: "Cluster enrollment is not supported by this daemon.",
    };
  const state = await rpc.getClusterState(transport);
  if (state.type !== "member")
    return {
      supported: true,
      state,
      message:
        state.type === "unaffiliated"
          ? "Not in a cluster."
          : state.type === "joining"
            ? "Joining: waiting for primary approval and synchronization."
            : state.type === "leaving"
              ? "Leaving: waiting for primary removal."
              : state.type === "removalPending"
                ? "Join canceled locally; primary removal is still pending."
                : "This node was removed from its cluster.",
    };
  const history = await rpc.readClusterHistory(transport, {
    clusterId: state.head.clusterId,
  });
  const verified = await verifyHistory(history),
    id = hex(verified.head.clusterId);
  if (machine.cluster && machine.cluster.id !== id)
    throw new Error(
      "Daemon cluster changed. Existing cluster trust was not transferred.",
    );
  let saved = await clusterKey(id);
  if (saved.history) await verifyHistory(history, saved.history);
  saved = await storeHistory(history);
  if (saved.grantId) {
    const grant = verified.grants.get(hex(saved.grantId));
    if (
      !grant ||
      !same(grant.client, saved.publicKey) ||
      grant.expires * 1000 <= Date.now()
    ) {
      const renewableExpiry =
        grant &&
        same(grant.client, saved.publicKey) &&
        grant.expires * 1000 <= Date.now() &&
        machine.clientId &&
        machine.clientSecret;
      if (!newPairing && !renewableExpiry)
        return {
          supported: true,
          state,
          record: saved,
          message:
            "Cluster grant was revoked or expired. Local pairing remains available; pair again to request new cluster access.",
        };
      await resetGrantAfterPairing(id, saved.grantId);
      saved = await clusterKey(id);
    }
  }
  if (!saved.grantId && machine.clientId && machine.clientSecret) {
    const challenge = await rpc.beginClusterClientAdoption(transport, {
      clientPublicKey: saved.publicKey,
    });
    if (
      !same(challenge.clusterId, verified.head.clusterId) ||
      !same(challenge.clientPublicKey, saved.publicKey) ||
      !same(challenge.issuerAdmissionId, state.localAdmissionId) ||
      challenge.expiresAtUnix * 1000 <= Date.now()
    )
      throw new Error("Invalid pairing adoption challenge");
    const result = await rpc.completeClusterClientAdoption(transport, {
      grantId: challenge.grantId,
      clientProof: await sign(saved.privateKey, adoptionBody(challenge)),
    });
    if (result.type === "accepted") {
      await verifyHistory(result.history, saved.history);
      saved = await storeHistory(result.history, challenge.grantId);
    } else {
      return {
        supported: true,
        state,
        message:
          result.type === "pending"
            ? "Local pairing is ready. Cluster access is waiting for the primary."
            : result.type === "cancellationNeedsActiveMember"
              ? "Grant cancellation needs an active cluster member."
              : "Cluster pairing was rejected. Local access remains available.",
      };
    }
  }
  const issues = await rpc.getClusterRevocationIssues(transport);
  return {
    supported: true,
    state,
    record: saved,
    message: issues.issues.length
      ? "Cluster access is ready. A grant cancellation still needs an active member."
      : "Cluster access is ready.",
  };
}
