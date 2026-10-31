import { test } from "node:test";
import {
  createBunjaStore,
  createReadScopeFn,
  type ScopeValuePairs,
} from "bunja";
const readScopes = (pairs: ScopeValuePairs) =>
  createReadScopeFn(pairs, () => {
    throw new Error("unexpected scope");
  });
import { createStore } from "jotai";
import { JotaiStoreScope } from "unsaturated/store";
import { machineStoreBunja } from "../src/state/machine-store.ts";
import {
  type MachineStorage,
  MachineStorageScope,
} from "../src/state/machine-storage.ts";

function assert(value: unknown, message = "assertion failed"): asserts value {
  if (!value) throw new Error(message);
}
function memoryStorage() {
  const values = new Map<string, string>();
  let writes = 0;
  const storage: MachineStorage = {
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => {
      writes++;
      values.set(key, value);
    },
    removeItem: (key) => {
      writes++;
      values.delete(key);
    },
  };
  return { storage, values, writes: () => writes };
}
const machine = { id: "one", name: "One", baseUrl: "https://one.example:9012" };

test("machine persistence is shared until final consumer leaves and reloads on remount", () => {
  const persistence = memoryStorage();
  const jotai = createStore();
  const bunjas = createBunjaStore();
  const read = readScopes([
    [JotaiStoreScope, jotai],
    [MachineStorageScope, persistence.storage],
  ]);
  const first = bunjas.get(machineStoreBunja, read);
  const stopFirst = first.mount();
  const second = bunjas.get(machineStoreBunja, read);
  const stopSecond = second.mount();
  assert(first.value === second.value, "consumers must share state");
  first.value.addMachine(machine);
  assert(
    persistence.writes() === 2,
    "one writer per atom despite multiple consumers",
  );
  stopFirst();
  second.value.selectMachine(undefined);
  assert(
    persistence.writes() === 3,
    "partial unmount must keep persistence alive",
  );
  stopSecond();
  second.value.selectMachine(machine.id);
  assert(persistence.writes() === 3, "final unmount must detach writers");
  persistence.values.set("rieul.selected-machine-id.v1", machine.id);
  const remounted = bunjas.get(machineStoreBunja, read);
  const stopRemounted = remounted.mount();
  assert(remounted.value !== first.value);
  assert(jotai.get(remounted.value.selectedIdAtom) === machine.id);
  assert(jotai.get(remounted.value.machinesAtom)[0].id === machine.id);
  assert(persistence.writes() === 3, "mount must not overwrite stored data");
  stopRemounted();
  bunjas.dispose();
});

test("storage replacement and Jotai domains isolate identity and persistence", () => {
  const a = memoryStorage();
  const b = memoryStorage();
  b.values.set("rieul.machines.v1", JSON.stringify([machine]));
  b.values.set("rieul.selected-machine-id.v1", "missing");
  const jotai = createStore();
  const otherJotai = createStore();
  const bunjas = createBunjaStore();
  const get = (storage: MachineStorage, state = jotai) =>
    bunjas.get(
      machineStoreBunja,
      readScopes([
        [JotaiStoreScope, state],
        [MachineStorageScope, storage],
      ]),
    );
  const first = get(a.storage);
  const replacement = get(b.storage);
  const isolated = get(b.storage, otherJotai);
  const stops = [first.mount(), replacement.mount(), isolated.mount()];
  assert(first.value !== replacement.value);
  assert(replacement.value !== isolated.value);
  assert(jotai.get(first.value.machinesAtom).length === 0);
  assert(
    jotai.get(replacement.value.selectedIdAtom) === machine.id,
    "invalid selection falls back to first machine",
  );
  replacement.value.updateMachine(machine.id, (item) => ({
    ...item,
    name: "Changed",
  }));
  assert(a.writes() === 0);
  assert(b.writes() === 1);
  assert(otherJotai.get(isolated.value.machinesAtom)[0].name === "One");
  first.value.addMachine({ ...machine, id: "two" });
  assert(jotai.get(replacement.value.machinesAtom).length === 1);
  stops.forEach((stop) => stop());
  bunjas.dispose();
});

test("external storage edits are read on the next lifetime without live synchronization", () => {
  const persistence = memoryStorage();
  const jotai = createStore();
  const bunjas = createBunjaStore();
  const read = readScopes([
    [JotaiStoreScope, jotai],
    [MachineStorageScope, persistence.storage],
  ]);
  const first = bunjas.get(machineStoreBunja, read);
  const stop = first.mount();
  persistence.values.set(
    "rieul.machines.v1",
    JSON.stringify([machine, { ...machine, id: "two" }]),
  );
  persistence.values.set("rieul.selected-machine-id.v1", "two");
  assert(
    jotai.get(first.value.machinesAtom).length === 0,
    "no new cross-tab synchronization behavior",
  );
  stop();
  const next = bunjas.get(machineStoreBunja, read);
  const stopNext = next.mount();
  assert(jotai.get(next.value.selectedIdAtom) === "two");
  stopNext();
  persistence.values.set("rieul.machines.v1", "invalid JSON");
  const corrupt = bunjas.get(machineStoreBunja, read);
  const stopCorrupt = corrupt.mount();
  assert(
    jotai.get(corrupt.value.machinesAtom).length === 0 &&
      jotai.get(corrupt.value.selectedIdAtom) === undefined,
  );
  stopCorrupt();
  bunjas.dispose();
});

test("unavailable storage keeps the existing error contract instead of silently losing data", () => {
  const jotai = createStore();
  const bunjas = createBunjaStore();
  const denied = new Error("storage unavailable");
  const storage: MachineStorage = {
    getItem() {
      throw denied;
    },
    setItem() {
      throw denied;
    },
    removeItem() {
      throw denied;
    },
  };
  let received: unknown;
  try {
    bunjas.get(
      machineStoreBunja,
      readScopes([
        [JotaiStoreScope, jotai],
        [MachineStorageScope, storage],
      ]),
    );
  } catch (error) {
    received = error;
  }
  assert(received === denied);
  bunjas.dispose();
});

test("deleting the selected machine publishes one coherent selection transition", () => {
  const persistence = memoryStorage(),
    state = createStore(),
    bunjas = createBunjaStore();
  const owner = bunjas.get(
    machineStoreBunja,
    readScopes([
      [JotaiStoreScope, state],
      [MachineStorageScope, persistence.storage],
    ]),
  );
  const stop = owner.mount();
  owner.value.addMachine(machine);
  owner.value.addMachine({ ...machine, id: "two" });
  owner.value.selectMachine("one");
  const selected: (string | undefined)[] = [];
  const off = state.sub(owner.value.selectedAtom, () =>
    selected.push(state.get(owner.value.selectedAtom)?.id),
  );
  const removed = owner.value.deleteSelectedMachine();
  assert(removed?.id === "one");
  assert(
    selected.length === 1 && selected[0] === "two",
    `selection must not pass through a missing machine: ${JSON.stringify(selected)}`,
  );
  off();
  stop();
  bunjas.dispose();
});
