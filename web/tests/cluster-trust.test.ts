import { test } from "node:test";
import assert from "node:assert/strict";
import { encodeCbor, type CborValue } from "../src/protocol/cbor.ts";
import {
  hash,
  sign,
  hex,
  verifyHistory,
  adoptionBody,
  sessionBody,
} from "../src/cluster/trust.ts";
import type {
  ClusterHistory,
  ClusterJournalEntry,
} from "../src/protocol/generated/rpc.ts";
const id = (n: number) => new Uint8Array(32).fill(n);
const concat = (...parts: Uint8Array[]) =>
  Uint8Array.from(parts.flatMap((p) => Array.from(p)));
const u64 = (n: number) => {
  const bytes = new Uint8Array(8);
  new DataView(bytes.buffer).setBigUint64(0, BigInt(n));
  return bytes;
};
async function keys() {
  const pair = (await crypto.subtle.generateKey("Ed25519", false, [
    "sign",
    "verify",
  ])) as CryptoKeyPair;
  return {
    private: pair.privateKey,
    public: new Uint8Array(
      await crypto.subtle.exportKey("raw", pair.publicKey),
    ),
  };
}
async function fixture() {
  const root = await keys(),
    member = await keys(),
    client = await keys();
  const genesis = {
    nonce: id(1),
    rootAdmissionId: id(2),
    rootPublicKey: root.public,
    rootEndpoint: "https://root.test/rieul/rpc",
  };
  const clusterId = await hash([
    "rieul.cluster.genesis.v1",
    genesis.nonce,
    genesis.rootAdmissionId,
    root.public,
    genesis.rootEndpoint,
  ]);
  let history: ClusterHistory = {
    genesis,
    entries: [],
    head: {
      clusterId,
      managementEpoch: 1,
      sequence: 0,
      entryHash: clusterId,
      primaryAdmissionId: id(2),
    },
  };
  let operation = 10;
  async function append(
    values: CborValue[],
    mutation: Uint8Array,
    signer = root.private,
  ) {
    const h = history.head,
      operationId = id(operation++);
    const requestHash = await hash([
      "rieul.cluster.management-request.v1",
      clusterId,
      h.managementEpoch,
      operationId,
      values,
    ]);
    const body: CborValue[] = [
      "rieul.cluster.management.v1",
      clusterId,
      h.managementEpoch,
      h.sequence + 1,
      h.entryHash,
      operationId,
      requestHash,
      values,
    ];
    const signature = await sign(signer, body);
    const entry: ClusterJournalEntry = {
      clusterId,
      managementEpoch: h.managementEpoch,
      sequence: h.sequence + 1,
      previousHash: h.entryHash,
      operationId,
      requestHash,
      mutation,
      signature,
    };
    history = {
      genesis,
      entries: [...history.entries, entry],
      head: {
        ...h,
        sequence: entry.sequence,
        entryHash: await hash([encodeCbor(body), signature]),
      },
    };
    return history;
  }
  async function admit(admission = id(3)) {
    const address = "https://member.test/rieul/rpc";
    return append(
      [0, admission, member.public, id(4), address],
      concat(
        new Uint8Array([0]),
        admission,
        member.public,
        id(4),
        new TextEncoder().encode(address),
      ),
    );
  }
  async function adopt() {
    const expires = 2_000_000_000;
    const possession = adoptionBody({
      clusterId,
      grantId: id(5),
      issuerAdmissionId: id(3),
      clientPublicKey: client.public,
      expiresAtUnix: expires,
    });
    const proof = await sign(client.private, possession);
    const issuerProof = await sign(member.private, [
      "rieul.cluster.pairing-adoption.v1",
      encodeCbor(possession),
      proof,
    ]);
    return append(
      [3, id(5), id(3), client.public, expires, proof, issuerProof],
      concat(
        new Uint8Array([3]),
        id(5),
        id(3),
        client.public,
        u64(expires),
        proof,
        issuerProof,
      ),
    );
  }
  return {
    root,
    member,
    client,
    append,
    admit,
    adopt,
    get history() {
      return history;
    },
  };
}
test("browser verifies adoption, non-cascading issuer removal and explicit grant revocation", async () => {
  const f = await fixture();
  await f.admit();
  const adopted = await f.adopt();
  assert.equal((await verifyHistory(adopted)).grants.size, 1);
  await f.append([1, id(3)], concat(new Uint8Array([1]), id(3)));
  const removed = await verifyHistory(f.history, adopted);
  assert.equal(removed.members.size, 1);
  assert.equal(removed.grants.size, 1);
  await f.admit(id(6));
  assert.equal((await verifyHistory(f.history)).members.size, 2);
  await f.append([4, id(5)], concat(new Uint8Array([4]), id(5)));
  assert.equal((await verifyHistory(f.history)).grants.size, 0);
  await assert.rejects(verifyHistory(adopted, f.history));
});
test("browser rejects modified signed suffix, wrong genesis, reused admission and oversized history", async () => {
  const f = await fixture();
  const prefix = structuredClone(f.history);
  await f.admit();
  await f.adopt();
  for (const field of [
    "signature",
    "requestHash",
    "previousHash",
    "clusterId",
    "mutation",
  ] as const) {
    const bad = structuredClone(f.history);
    bad.entries[1][field][0] ^= 1;
    await assert.rejects(verifyHistory(bad, prefix), field);
  }
  const other = await fixture();
  await assert.rejects(verifyHistory(f.history, other.history));
  const large = structuredClone(f.history);
  large.entries = Array(513).fill(large.entries[0]);
  await assert.rejects(verifyHistory(large));
  await f.append([1, id(3)], concat(new Uint8Array([1]), id(3)));
  await f.admit();
  await assert.rejects(verifyHistory(f.history));
});
test("session proof changes across target incarnation, nonce and cluster", async () => {
  const f = await fixture();
  const request = {
    knownHead: f.history.head,
    serverAdmissionId: id(2),
    serverPublicKey: f.root.public,
    grantId: id(5),
    clientPublicKey: f.client.public,
    nonce: id(7),
    connectionId: 1,
    signature: new Uint8Array(),
  };
  const body = hex(encodeCbor(sessionBody(request)));
  for (const field of ["serverAdmissionId", "nonce", "grantId"] as const) {
    const changed = structuredClone(request);
    changed[field][0] ^= 1;
    assert.notEqual(hex(encodeCbor(sessionBody(changed))), body);
  }
});

test("signed HTTPS default port survives machine persistence without becoming port 9012", async () => {
  const { loadMachines, saveMachines } = await import(
    "../src/state/machines.ts"
  );
  let value: string | null = null;
  const storage = {
    getItem: () => value,
    setItem: (_key: string, next: string) => {
      value = next;
    },
    removeItem: () => {
      value = null;
    },
  };
  const machine = {
    id: "cluster-fixture",
    name: "Fixture",
    baseUrl: "https://fixture.test",
    cluster: { id: hex(id(1)), admissionId: hex(id(2)) },
  };
  saveMachines([machine], storage);
  assert.equal(loadMachines(storage)[0].baseUrl, "https://fixture.test");
  saveMachines(loadMachines(storage), storage);
  assert.equal(loadMachines(storage)[0].baseUrl, "https://fixture.test");
});
