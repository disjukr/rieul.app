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
import { fixture, id, concat, u64 } from "./helpers/cluster-history.ts";
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
