import { createRoot, createEffect, flush as flushSolid } from "solid-js";
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
  const bunjas = createBunjaStore({ wrapInstance: (init) => createRoot(init) });
  const read = readScopes([[MachineStorageScope, persistence.storage]]);
  const first = bunjas.get(machineStoreBunja, read);
  const stopFirst = first.mount();
  const second = bunjas.get(machineStoreBunja, read);
  const stopSecond = second.mount();
  assert(first.value === second.value, "consumers must share state");
  first.value.addMachine(machine);
  flushSolid();
  assert(
    persistence.writes() === 2,
    "one writer per signal despite multiple consumers",
  );
  stopFirst();
  second.value.selectMachine(undefined);
  flushSolid();
  assert(
    persistence.writes() === 3,
    "partial unmount must keep persistence alive",
  );
  stopSecond();
  second.value.selectMachine(machine.id);
  flushSolid();
  assert(persistence.writes() === 3, "final unmount must detach writers");
  persistence.values.set("rieul.selected-machine-id.v1", machine.id);
  const remounted = bunjas.get(machineStoreBunja, read);
  const stopRemounted = remounted.mount();
  assert(remounted.value !== first.value);
  assert((flushSolid(), remounted.value.selectedId()) === machine.id);
  assert((flushSolid(), remounted.value.machines())[0].id === machine.id);
  flushSolid();
  assert(persistence.writes() === 3, "mount must not overwrite stored data");
  stopRemounted();
  bunjas.dispose();
});

test("storage replacement and Bunja stores isolate identity and persistence", () => {
  const a = memoryStorage();
  const b = memoryStorage();
  b.values.set("rieul.machines.v1", JSON.stringify([machine]));
  b.values.set("rieul.selected-machine-id.v1", "missing");
  const bunjas = createBunjaStore({ wrapInstance: (init) => createRoot(init) });
  const isolatedStore = createBunjaStore({
    wrapInstance: (init) => createRoot(init),
  });
  const get = (storage: MachineStorage, owner = bunjas) =>
    owner.get(machineStoreBunja, readScopes([[MachineStorageScope, storage]]));
  const first = get(a.storage);
  const replacement = get(b.storage);
  const isolated = get(b.storage, isolatedStore);
  const stops = [first.mount(), replacement.mount(), isolated.mount()];
  assert(first.value !== replacement.value);
  assert(replacement.value !== isolated.value);
  assert((flushSolid(), first.value.machines()).length === 0);
  assert(
    (flushSolid(), replacement.value.selectedId()) === machine.id,
    "invalid selection falls back to first machine",
  );
  replacement.value.updateMachine(machine.id, (item) => ({
    ...item,
    name: "Changed",
  }));
  flushSolid();
  assert(a.writes() === 0);
  assert(b.writes() === 1);
  assert((flushSolid(), isolated.value.machines())[0].name === "One");
  first.value.addMachine({ ...machine, id: "two" });
  assert((flushSolid(), replacement.value.machines()).length === 1);
  stops.forEach((stop) => stop());
  isolatedStore.dispose();
  bunjas.dispose();
});

test("external storage edits are read on the next lifetime without live synchronization", () => {
  const persistence = memoryStorage();
  const bunjas = createBunjaStore({ wrapInstance: (init) => createRoot(init) });
  const read = readScopes([[MachineStorageScope, persistence.storage]]);
  const first = bunjas.get(machineStoreBunja, read);
  const stop = first.mount();
  persistence.values.set(
    "rieul.machines.v1",
    JSON.stringify([machine, { ...machine, id: "two" }]),
  );
  persistence.values.set("rieul.selected-machine-id.v1", "two");
  assert(
    (flushSolid(), first.value.machines()).length === 0,
    "no new cross-tab synchronization behavior",
  );
  stop();
  const next = bunjas.get(machineStoreBunja, read);
  const stopNext = next.mount();
  assert((flushSolid(), next.value.selectedId()) === "two");
  stopNext();
  persistence.values.set("rieul.machines.v1", "invalid JSON");
  const corrupt = bunjas.get(machineStoreBunja, read);
  const stopCorrupt = corrupt.mount();
  assert(
    (flushSolid(), corrupt.value.machines()).length === 0 &&
      (flushSolid(), corrupt.value.selectedId()) === undefined,
  );
  stopCorrupt();
  bunjas.dispose();
});

test("unavailable storage keeps the existing error contract instead of silently losing data", () => {
  const bunjas = createBunjaStore({ wrapInstance: (init) => createRoot(init) });
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
    bunjas.get(machineStoreBunja, readScopes([[MachineStorageScope, storage]]));
  } catch (error) {
    received = error;
  }
  assert(received === denied);
  bunjas.dispose();
});

test("deleting the selected machine publishes one coherent selection transition", () => {
  const persistence = memoryStorage(),
    bunjas = createBunjaStore({ wrapInstance: (init) => createRoot(init) });
  const owner = bunjas.get(
    machineStoreBunja,
    readScopes([[MachineStorageScope, persistence.storage]]),
  );
  const stop = owner.mount();
  owner.value.addMachine(machine);
  owner.value.addMachine({ ...machine, id: "two" });
  owner.value.selectMachine("one");
  const selected: (string | undefined)[] = [];
  flushSolid();
  const off = createRoot((dispose) => {
    createEffect(owner.value.selected, (value) => {
      selected.push(value?.id);
    });
    return dispose;
  });
  flushSolid();
  selected.length = 0;
  const removed = owner.value.deleteSelectedMachine();
  flushSolid();
  assert(removed?.id === "one");
  assert(
    selected.length === 1 && selected[0] === "two",
    `selection must not pass through a missing machine: ${JSON.stringify(selected)}`,
  );
  off();
  stop();
  bunjas.dispose();
});

test("cluster refresh preserves identity while still applying expiry, revocation and new local binding", async () => {
  const { fixture, id, concat } = await import("./helpers/cluster-history.ts");
  const { hex } = await import("../src/cluster/trust.ts");
  const f = await fixture();
  await f.admit();
  await f.adopt();
  const persistence = memoryStorage();
  const bunjas = createBunjaStore({ wrapInstance: (init) => createRoot(init) });
  const owner = bunjas.get(
    machineStoreBunja,
    readScopes([[MachineStorageScope, persistence.storage]]),
  );
  const stop = owner.mount();
  const state = owner.value;
  const record = () => ({
    id: hex(f.history.head.clusterId),
    privateKey: f.client.private,
    publicKey: f.client.public,
    grantId: id(5),
    history: f.history,
  });
  try {
    state.addMachine({
      id: "local",
      name: "Local",
      baseUrl: "https://root.test",
      clientSecret: "fixture",
    });
    await state.applyCluster(record(), "local", hex(id(2)));
    flushSolid();
    const first = state.machines(),
      selected = state.selected(),
      writes = persistence.writes();
    assert(first.length === 2 && selected?.cluster?.admissionId === hex(id(2)));
    await state.applyCluster(record(), "local", hex(id(2)));
    flushSolid();
    assert(
      state.machines() === first && state.selected() === selected,
      "identical poll must retain machine and list identity",
    );
    assert(
      persistence.writes() === writes,
      "identical poll must not persist again",
    );
    // An unchanged journal must still bind a newly paired source.
    state.addMachine({
      id: "second",
      name: "Second",
      baseUrl: "https://member.test",
      clientSecret: "fixture",
    });
    await state.applyCluster(record(), "second", hex(id(3)));
    flushSolid();
    assert(state.findMachine("second")?.cluster?.admissionId === hex(id(3)));
    // Expiry changes authorization without changing the journal head.
    const now = Date.now;
    try {
      Date.now = () => 2_000_000_001_000;
      await state.applyCluster(record(), "local", hex(id(2)));
      flushSolid();
      assert(
        state.machines().length === 2,
        "expired grant removes discovered-only member",
      );
      const expired = state.machines();
      await state.applyCluster(record(), "local", hex(id(2)));
      flushSolid();
      assert(
        state.machines() === expired,
        "unchanged unauthorized poll is also a no-op",
      );
    } finally {
      Date.now = now;
    }
    await f.append([4, id(5)], concat(new Uint8Array([4]), id(5)));
    await state.applyCluster(record());
    flushSolid();
    assert(
      state.machines().every((m) => m.clientSecret),
      "revocation preserves only local pairing access",
    );
  } finally {
    stop();
    bunjas.dispose();
  }
});
