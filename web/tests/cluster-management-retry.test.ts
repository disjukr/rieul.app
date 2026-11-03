import { test, mock } from "node:test";
import assert from "node:assert/strict";
import * as protocol from "../src/protocol/client.ts";
import * as rpc from "../src/protocol/generated/client.ts";
import { encodeCbor } from "../src/protocol/cbor.ts";
import { fixture, id, concat, u64 } from "./helpers/cluster-history.ts";
import { hash, sign, hasAdmission, hasRemoval } from "../src/cluster/trust.ts";
let current: unknown, history: unknown;
let mutations = 0,
  finishes = 0,
  cleanups = 0;
const sourceTransport = { close() {} };
mock.module("../src/protocol/client.ts", {
  namedExports: {
    ...protocol,
    openWebTransport: async () => sourceTransport,
    authenticateWebTransport: async () => {},
  },
});
mock.module("../src/protocol/generated/client.ts", {
  namedExports: {
    ...rpc,
    getClusterState: async (transport: unknown) =>
      transport === sourceTransport
        ? { type: "member", head: (history as { head: unknown }).head }
        : current,
    readClusterHistory: async () => history,
    admitClusterMember: async () => {
      mutations++;
      throw new Error("changed epoch request must not be replayed");
    },
    removeClusterMember: async () => {
      mutations++;
      throw new Error("changed epoch request must not be replayed");
    },
    configureClusterJoinSync: async () => {},
    finishClusterJoin: async () => {
      finishes++;
      return { type: "member" };
    },
    applyClusterHistory: async () => {
      cleanups++;
      return { type: "removed" };
    },
  },
});
const { joinCluster, cancelJoin } = await import("../src/cluster/manage.ts");
test("lost Admit/Remove response followed by primary handoff recovers exact signed evidence without a new epoch mutation", async () => {
  const f = await fixture();
  await f.admit(); // future primary
  const consent = {
    genesis: f.history.genesis,
    operationId: id(30),
    admissionId: id(31),
    nodePublicKey: (await crypto.subtle.generateKey("Ed25519", false, [
      "sign",
      "verify",
    ])) as CryptoKeyPair,
    endpoint: "https://joining.test/rieul/rpc",
    expiresAtUnix: 2_000_000_000,
  };
  const pair = consent.nodePublicKey;
  const publicKey = new Uint8Array(
    await crypto.subtle.exportKey("raw", pair.publicKey),
  );
  const body = [
    "rieul.cluster.target-consent.v2",
    f.history.head.clusterId,
    consent.operationId,
    consent.admissionId,
    publicKey,
    true,
    consent.endpoint,
    consent.expiresAtUnix,
  ];
  const signature = await sign(pair.privateKey, body);
  const request = { ...consent, nodePublicKey: publicKey, signature };
  const digest = await hash([encodeCbor(body), signature]);
  await f.append(
    [0, consent.admissionId, publicKey, digest, consent.endpoint],
    concat(
      new Uint8Array([0]),
      consent.admissionId,
      publicKey,
      digest,
      new TextEncoder().encode(consent.endpoint),
    ),
  );
  const head = f.history.head;
  const transferOp = id(12); // append's next operation after two admissions
  const acceptance = await sign(f.member.private, [
    "rieul.cluster.transfer-acceptance.v1",
    head.clusterId,
    1,
    2,
    transferOp,
    id(3),
    f.member.public,
    head.sequence,
    head.entryHash,
  ]);
  await f.append(
    [2, id(3), f.member.public, head.sequence, head.entryHash, acceptance],
    concat(
      new Uint8Array([2]),
      id(3),
      f.member.public,
      u64(head.sequence),
      head.entryHash,
      acceptance,
    ),
  );
  history = f.history;
  assert.equal(f.history.head.managementEpoch, 2);
  assert.equal(await hasAdmission(f.history, request), true);
  assert.equal(
    await hasAdmission(f.history, { ...request, operationId: id(99) }),
    false,
  );
  current = { type: "joining", consent: request };
  const source = {
    id: "source",
    name: "Source",
    baseUrl: "https://member.test",
    clientId: "fixture",
    clientSecret: "fixture",
  };
  await joinCluster({} as WebTransport, source);
  assert.equal(finishes, 1);
  // Removal committed in the new epoch, then another handoff before retry.
  await f.append(
    [1, consent.admissionId],
    concat(new Uint8Array([1]), consent.admissionId),
    f.member.private,
  );
  const removedHead = f.history.head;
  const back = await sign(f.root.private, [
    "rieul.cluster.transfer-acceptance.v1",
    removedHead.clusterId,
    2,
    3,
    id(14),
    id(2),
    f.root.public,
    removedHead.sequence,
    removedHead.entryHash,
  ]);
  await f.append(
    [
      2,
      id(2),
      f.root.public,
      removedHead.sequence,
      removedHead.entryHash,
      back,
    ],
    concat(
      new Uint8Array([2]),
      id(2),
      f.root.public,
      u64(removedHead.sequence),
      removedHead.entryHash,
      back,
    ),
    f.member.private,
  );
  history = f.history;
  current = {
    type: "removalPending",
    clusterId: f.history.head.clusterId,
    admissionId: consent.admissionId,
  };
  assert.equal(await hasRemoval(f.history, consent.admissionId), true);
  assert.equal(await hasAdmission(f.history, request), false);
  await cancelJoin({} as WebTransport, source);
  assert.equal(cleanups, 1);
  assert.equal(mutations, 0);
});
