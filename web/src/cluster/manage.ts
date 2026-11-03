import * as rpc from "../protocol/generated/client.ts";
import {
  authenticateWebTransport,
  openWebTransport,
} from "../protocol/client.ts";
import type { Machine } from "../state/machines.ts";
import { authenticateCluster } from "./connection.ts";
import {
  hash,
  same,
  verifyHistory,
  hasAdmission,
  hasRemoval,
  hex,
  endpoint,
  equalHead,
} from "./trust.ts";
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
    if (!(await hasAdmission(history, consent)))
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
    if (!(await hasRemoval(history, admissionId)))
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

async function authenticatedMember(machine: Machine) {
  const transport = await openWebTransport(machine);
  try {
    if (machine.clientId && machine.clientSecret)
      await authenticateWebTransport(
        transport,
        machine.clientId,
        machine.clientSecret,
      );
    else await authenticateCluster(transport, machine);
    return transport;
  } catch (error) {
    transport.close();
    throw error;
  }
}

/** The source's durable seal is never undone, including after a lost response. */
export async function transferPrimary(source: WebTransport, target: Machine) {
  const state = await rpc.getClusterState(source);
  if (state.type !== "member")
    throw new Error("Cluster membership is required");
  let history = await rpc.readClusterHistory(source, {
    clusterId: state.head.clusterId,
  });
  let verified = await verifyHistory(history);
  const member =
    target.cluster && verified.members.get(target.cluster.admissionId);
  if (
    !member ||
    target.cluster?.id !== hex(verified.head.clusterId) ||
    endpoint(member.endpoint) !== new URL(target.baseUrl).origin
  )
    throw new Error("Choose a verified member of this cluster");
  const destination = await authenticatedMember(target);
  try {
    let operationId: Uint8Array;
    if (state.primaryTransition.type === "active") {
      if (
        !same(state.localAdmissionId, verified.head.primaryAdmissionId) ||
        same(member.admissionId, state.localAdmissionId)
      )
        throw new Error(
          "Only the current primary can transfer to another member",
        );
      await rpc.applyClusterHistory(destination, { history });
      const acceptance = await rpc.preparePrimaryTransfer(destination, {
        operationId: await hash([
          "rieul.cluster.browser-transfer.v1",
          verified.head.clusterId,
          verified.head.entryHash,
          member.admissionId,
        ]),
        expectedHead: verified.head,
      });
      if (
        !same(acceptance.targetAdmissionId, member.admissionId) ||
        !same(acceptance.targetPublicKey, member.nodePublicKey) ||
        !equalHead(acceptance.expectedHead, verified.head)
      )
        throw new Error(
          "Transfer acceptance does not match the selected target",
        );
      await rpc.sealPrimaryTransfer(source, { acceptance });
      operationId = acceptance.operationId;
      const sealed = await rpc.readClusterHistory(source, {
        clusterId: verified.head.clusterId,
      });
      verified = await verifyHistory(sealed, history);
      history = sealed;
    } else if (
      state.primaryTransition.type === "sealed" ||
      state.primaryTransition.type === "awaitingActivation"
    ) {
      // Recover the immutable operation from the verified journal, never choose
      // a new target or attempt to make the sealed source writable again.
      const transfer = [...history.entries]
        .reverse()
        .find((entry) => entry.mutation[0] === 2);
      if (
        !transfer ||
        !same(verified.head.primaryAdmissionId, member.admissionId)
      )
        throw new Error("Resume activation on the already selected primary");
      operationId = transfer.operationId;
    } else
      throw new Error("Select the primary to transfer management authority");
    if (!same(verified.head.primaryAdmissionId, member.admissionId))
      throw new Error("The signed handoff selected a different primary");
    const activated = await rpc.activateClusterPrimary(destination, {
      operationId,
      history,
    });
    if (
      activated.type !== "member" ||
      activated.primaryTransition.type !== "active" ||
      !same(activated.localAdmissionId, member.admissionId) ||
      !same(activated.head.primaryAdmissionId, member.admissionId)
    )
      throw new Error("Primary activation is still pending");
    return activated;
  } finally {
    destination.close();
  }
}

export async function revokeClusterGrant(
  transport: WebTransport,
  grantId: Uint8Array,
) {
  const state = await rpc.getClusterState(transport);
  if (state.type !== "member")
    throw new Error("An active cluster member is required");
  const history = await rpc.readClusterHistory(transport, {
    clusterId: state.head.clusterId,
  });
  await verifyHistory(history);
  if (
    history.entries.some(
      (entry) =>
        entry.mutation[0] === 4 && same(entry.mutation.slice(1), grantId),
    )
  )
    return;
  return rpc.revokeClusterClientGrant(transport, {
    operationId: await hash([
      "rieul.cluster.browser-revoke.v1",
      state.head.clusterId,
      grantId,
    ]),
    expectedManagementEpoch: history.head.managementEpoch,
    grantId,
  });
}
