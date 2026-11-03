import * as rpc from "../protocol/generated/client.ts";
import {
  authenticateWebTransport,
  openWebTransport,
} from "../protocol/client.ts";
import type { Machine } from "../state/machines.ts";
import { authenticateCluster } from "./connection.ts";
import { hash, same, verifyHistory } from "./trust.ts";
const operation = () => crypto.getRandomValues(new Uint8Array(32));
export async function createCluster(transport: WebTransport) {
  return rpc.createCluster(transport, {
    operationId: operation(),
    confirmed: true,
  });
}
export async function joinCluster(target: WebTransport, source: Machine) {
  const transport = await openWebTransport(source);
  try {
    if (source.clientId && source.clientSecret)
      await authenticateWebTransport(
        transport,
        source.clientId,
        source.clientSecret,
      );
    else await authenticateCluster(transport, source);
    const state = await rpc.getClusterState(transport);
    if (state.type !== "member")
      throw new Error("The selected source is not an active cluster member");
    const history = await rpc.readClusterHistory(transport, {
      clusterId: state.head.clusterId,
    });
    await verifyHistory(history);
    const current = await rpc.getClusterState(target);
    if (
      current.type !== "unaffiliated" &&
      current.type !== "removed" &&
      current.type !== "joining"
    )
      throw new Error(
        "This daemon already has a cluster operation in progress",
      );
    const consent =
      current.type === "joining"
        ? current.consent
        : await rpc.prepareClusterJoin(target, {
            operationId: operation(),
            genesis: history.genesis,
            confirmed: true,
          });
    if (
      !same(
        await hash([
          "rieul.cluster.genesis.v1",
          consent.genesis.nonce,
          consent.genesis.rootAdmissionId,
          consent.genesis.rootPublicKey,
          consent.genesis.rootEndpoint,
        ]),
        history.head.clusterId,
      )
    )
      throw new Error("Pending join belongs to a different cluster");
    await rpc.admitClusterMember(transport, {
      operationId: await hash([
        "rieul.cluster.browser-admit.v1",
        history.head.clusterId,
        consent.operationId,
      ]),
      expectedManagementEpoch: history.head.managementEpoch,
      consent,
    });
    const accepted = await rpc.readClusterHistory(transport, {
      clusterId: history.head.clusterId,
    });
    await verifyHistory(accepted, history);
    await rpc.configureClusterJoinSync(target, {
      operationId: consent.operationId,
      bootstrapHistory: accepted,
    });
    // Fresh authenticated read above plus the target's own scoped background sync
    // recover an interrupted Finish without granting an unpaired capability.
    return rpc.finishClusterJoin(target, {
      operationId: consent.operationId,
      history: accepted,
    });
  } finally {
    transport.close();
  }
}
export async function leaveCluster(transport: WebTransport) {
  return rpc.leaveCluster(transport, { operationId: operation() });
}
export async function cancelJoin(target: WebTransport, source: Machine) {
  const current = await rpc.getClusterState(target);
  if (current.type !== "joining" && current.type !== "removalPending")
    throw new Error("No pending join to cancel");
  const clusterId =
    current.type === "joining"
      ? await hash([
          "rieul.cluster.genesis.v1",
          current.consent.genesis.nonce,
          current.consent.genesis.rootAdmissionId,
          current.consent.genesis.rootPublicKey,
          current.consent.genesis.rootEndpoint,
        ])
      : current.clusterId;
  const admissionId =
    current.type === "joining"
      ? current.consent.admissionId
      : current.admissionId;
  // Retire locally first, even if the primary is unreachable. Never label this
  // remote removal until the signed removal history has been applied.
  if (current.type === "joining")
    await rpc.cancelClusterJoin(target, {
      operationId: current.consent.operationId,
    });
  const transport = await openWebTransport(source);
  try {
    if (source.clientId && source.clientSecret)
      await authenticateWebTransport(
        transport,
        source.clientId,
        source.clientSecret,
      );
    else await authenticateCluster(transport, source);
    const history = await rpc.readClusterHistory(transport, { clusterId });
    await verifyHistory(history);
    if (!same(history.head.clusterId, clusterId))
      throw new Error("Cleanup source belongs to a different cluster");
    await rpc.removeClusterMember(transport, {
      operationId: await hash([
        "rieul.cluster.browser-cancel.v1",
        clusterId,
        admissionId,
      ]),
      expectedManagementEpoch: history.head.managementEpoch,
      admissionId,
    });
    const removed = await rpc.readClusterHistory(transport, { clusterId });
    await verifyHistory(removed, history);
    return rpc.applyClusterHistory(target, { history: removed });
  } finally {
    transport.close();
  }
}
