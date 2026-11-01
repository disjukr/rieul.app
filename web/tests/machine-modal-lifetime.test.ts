import { createRoot, flush as flushSolid } from "solid-js";
import { test } from "node:test";
import assert from "node:assert/strict";
import { bunja, createBunjaStore, createReadScopeFn, override } from "bunja";
import { machineModalBunja } from "../src/state/machine-modal.ts";
import { machineStoreBunja } from "../src/state/machine-store.ts";
import { MachineIdScope } from "../src/state/machine-scopes.ts";
import { MachineStorageScope } from "../src/state/machine-storage.ts";
import { rpcSessionBunja } from "../src/state/rpc-session.ts";
import { rpcSessionStub } from "./helpers/rpc-session.ts";

async function flush() {
  for (let i = 0; i < 4; i++) {
    flushSolid();
    await Promise.resolve();
  }
}

test("pending pairing waits for matching machine scope, shares consumption and stops on final release", async () => {
  const calls: Array<{
    id: string | undefined;
    pending: ReturnType<
      typeof Promise.withResolvers<{ pairingCodeExpiresAtUnix: number }>
    >;
  }> = [];
  const storage = { getItem: () => null, setItem() {}, removeItem() {} };
  const store = createBunjaStore({
    wrapInstance: (init) => createRoot(init),
    overrides: [
      override(rpcSessionBunja, () => {
        const id = bunja.use(MachineIdScope);
        return rpcSessionStub({
          startPairingSession: () => {
            const pending = Promise.withResolvers<{
              pairingCodeExpiresAtUnix: number;
            }>();
            calls.push({ id, pending });
            return pending.promise;
          },
        });
      }),
    ],
  });
  const readA = createReadScopeFn(
    [
      [MachineStorageScope, storage],
      [MachineIdScope, "A"],
    ],
    () => {
      throw new Error("unexpected scope");
    },
  );
  const readB = createReadScopeFn(
    [
      [MachineStorageScope, storage],
      [MachineIdScope, "B"],
    ],
    () => {
      throw new Error("unexpected scope");
    },
  );
  try {
    const machines = store.get(machineStoreBunja, readA);
    const releaseMachines = machines.mount();
    machines.value.addMachine({
      id: "A",
      name: "A",
      baseUrl: "https://a.invalid",
    });
    machines.value.addMachine({
      id: "B",
      name: "B",
      baseUrl: "https://b.invalid",
    });
    machines.value.selectMachine("A");
    const a = store.get(machineModalBunja, readA),
      secondA = store.get(machineModalBunja, readA);
    assert.equal(a.value, secondA.value);
    const stopA = a.mount(),
      stopSecondA = secondA.mount();
    machines.value.requestPairingForMachine("missing");
    await flush();
    assert.equal((flushSolid(), machines.value.selectedId()), "A");
    assert.equal(
      (flushSolid(), machines.value.pendingPairMachineId()),
      undefined,
    );
    machines.value.requestPairingForMachine("B");
    await flush();
    assert.equal((flushSolid(), machines.value.selectedId()), "B");
    assert.equal((flushSolid(), machines.value.pendingPairMachineId()), "B");
    assert.equal(calls.length, 0);
    const b = store.get(machineModalBunja, readB),
      secondB = store.get(machineModalBunja, readB);
    const stopB = b.mount(),
      stopSecondB = secondB.mount();
    await flush();
    assert.deepEqual(
      calls.map((call) => call.id),
      ["B"],
    );
    assert.equal(
      (flushSolid(), machines.value.pendingPairMachineId()),
      undefined,
    );
    assert.equal((flushSolid(), b.value.machineModalMode()), "pair");
    stopA();
    machines.value.requestPairingForMachine("A");
    await flush();
    assert.deepEqual(
      calls.map((call) => call.id),
      ["B", "A"],
    );
    stopSecondA();
    calls[1].pending.resolve({ pairingCodeExpiresAtUnix: 123 });
    await Promise.resolve();
    assert.equal((flushSolid(), a.value.pairingCodeExpiresAtUnix()), undefined);
    machines.value.requestPairingForMachine("A");
    await flush();
    assert.equal(calls.length, 2);
    assert.equal((flushSolid(), machines.value.pendingPairMachineId()), "A");
    const remountedA = store.get(machineModalBunja, readA);
    const stopRemountedA = remountedA.mount();
    await flush();
    assert.deepEqual(
      calls.map((call) => call.id),
      ["B", "A", "A"],
    );
    assert.equal(
      (flushSolid(), machines.value.pendingPairMachineId()),
      undefined,
    );
    stopRemountedA();
    stopB();
    stopSecondB();
    releaseMachines();
  } finally {
    store.dispose();
  }
});
