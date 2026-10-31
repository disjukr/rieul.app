import { test } from "node:test";
import assert from "node:assert/strict";
import { bunja, createBunjaStore, createReadScopeFn, override } from "bunja";
import { createStore } from "jotai/vanilla";
import { machineModalBunja } from "../src/state/machine-modal.ts";
import { machineStoreBunja } from "../src/state/machine-store.ts";
import { MachineIdScope } from "../src/state/machine-scopes.ts";
import { MachineStorageScope } from "../src/state/machine-storage.ts";
import { JotaiStoreScope } from "../src/state/jotai-store.ts";
import { rpcSessionBunja } from "../src/state/rpc-session.ts";
import { rpcSessionStub } from "./helpers/rpc-session.ts";

test("pending pairing waits for matching machine scope, shares consumption and stops on final release", async () => {
  const state = createStore();
  const calls: Array<{
    id: string | undefined;
    pending: ReturnType<
      typeof Promise.withResolvers<{ pairingCodeExpiresAtUnix: number }>
    >;
  }> = [];
  const storage = { getItem: () => null, setItem() {}, removeItem() {} };
  const store = createBunjaStore({
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
      [JotaiStoreScope, state],
      [MachineStorageScope, storage],
      [MachineIdScope, "A"],
    ],
    () => {
      throw new Error("unexpected scope");
    },
  );
  const readB = createReadScopeFn(
    [
      [JotaiStoreScope, state],
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
    assert.equal(state.get(machines.value.selectedIdAtom), "A");
    assert.equal(state.get(machines.value.pendingPairMachineIdAtom), undefined);
    machines.value.requestPairingForMachine("B");
    assert.equal(state.get(machines.value.selectedIdAtom), "B");
    assert.equal(state.get(machines.value.pendingPairMachineIdAtom), "B");
    assert.equal(calls.length, 0);
    const b = store.get(machineModalBunja, readB),
      secondB = store.get(machineModalBunja, readB);
    const stopB = b.mount(),
      stopSecondB = secondB.mount();
    assert.deepEqual(
      calls.map((call) => call.id),
      ["B"],
    );
    assert.equal(state.get(machines.value.pendingPairMachineIdAtom), undefined);
    assert.equal(state.get(b.value.machineModalModeAtom), "pair");
    stopA();
    machines.value.requestPairingForMachine("A");
    assert.deepEqual(
      calls.map((call) => call.id),
      ["B", "A"],
    );
    stopSecondA();
    calls[1].pending.resolve({ pairingCodeExpiresAtUnix: 123 });
    await Promise.resolve();
    assert.equal(state.get(a.value.pairingCodeExpiresAtUnixAtom), undefined);
    machines.value.requestPairingForMachine("A");
    assert.equal(calls.length, 2);
    assert.equal(state.get(machines.value.pendingPairMachineIdAtom), "A");
    const remountedA = store.get(machineModalBunja, readA);
    const stopRemountedA = remountedA.mount();
    assert.deepEqual(
      calls.map((call) => call.id),
      ["B", "A", "A"],
    );
    assert.equal(state.get(machines.value.pendingPairMachineIdAtom), undefined);
    stopRemountedA();
    stopB();
    stopSecondB();
    releaseMachines();
  } finally {
    store.dispose();
  }
});
