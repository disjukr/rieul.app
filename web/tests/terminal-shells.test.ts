import { test } from "node:test";
import assert from "node:assert/strict";
import { bunja, createBunjaStore, createReadScopeFn } from "bunja";
import { atom, createStore } from "jotai/vanilla";
import { JotaiStoreScope } from "unsaturated/store";
import { createTerminalShellsBunja } from "../src/state/terminal-shells-model.ts";
import { MachineIdScope } from "../src/state/machine-scopes.ts";
import { MachineStorageScope } from "../src/state/machine-storage.ts";
import { machineBunja, machineStoreBunja } from "../src/state/machine-store.ts";
import type {
  AvailableShellInfo,
  AvailableShellsTableEvent,
} from "../src/protocol/generated/rpc.ts";
const row = (shellId: string): AvailableShellInfo => ({
  shellId,
  name: shellId,
  command: shellId,
  args: [],
  isDefault: true,
});
async function flush() {
  for (let i = 0; i < 20; i++) await Promise.resolve();
}
function stream() {
  let pending =
    Promise.withResolvers<IteratorResult<AvailableShellsTableEvent>>();
  let returns = 0;
  const iterator: AsyncGenerator<AvailableShellsTableEvent> = {
    next: () => pending.promise,
    // Leave the read pending to simulate a remote reply racing cancellation.
    return: () => {
      returns++;
      return Promise.resolve({ done: true, value: undefined });
    },
    throw: (error) => Promise.reject(error),
    [Symbol.asyncIterator]() {
      return this;
    },
    [Symbol.asyncDispose]: async () => {},
  };
  return {
    iterator,
    returns: () => returns,
    send(event: AvailableShellsTableEvent) {
      const old = pending;
      pending = Promise.withResolvers();
      old.resolve({ done: false, value: event });
    },
    fail(error: unknown) {
      pending.reject(error);
    },
  };
}

function fixture() {
  const state = createStore(),
    store = createBunjaStore();
  const storage = {
    getItem: () => null,
    setItem: () => {},
    removeItem: () => {},
  };
  const machines = ["a", "b"].map((id) => ({
    id,
    name: id,
    baseUrl: `https://${id}`,
    clientId: id,
    clientSecret: id,
  }));
  const sessions = machines.map(() => ({
    daemonInstanceIdAtom: atom<string | undefined>("daemon"),
    webTransport: async () => ({}) as WebTransport,
  }));
  const streams: ReturnType<typeof stream>[] = [];
  const sessionBunja = bunja(
    () => sessions[bunja.use(machineBunja).machineId === "a" ? 0 : 1],
  );
  const model = createTerminalShellsBunja(sessionBunja, () => {
    const channel = stream();
    streams.push(channel);
    return channel.iterator;
  });
  const scopes = (id = "a") =>
    createReadScopeFn(
      [
        [JotaiStoreScope, state],
        [MachineStorageScope, storage],
        [MachineIdScope, id],
      ],
      () => {
        throw new Error("missing scope");
      },
    );
  const machineStore = store.get(machineStoreBunja, scopes());
  const releaseMachines = machineStore.mount();
  state.set(machineStore.value.machinesAtom, machines);
  state.set(machineStore.value.selectedIdAtom, "a");
  const get = (id = "a") => store.get(model, scopes(id));
  return {
    state,
    store,
    sessions,
    streams,
    machineStore: machineStore.value,
    releaseMachines,
    get,
  };
}

test("shell consumers share per machine, ignore selection and release only the final owner", async () => {
  const f = fixture(),
    a = f.get(),
    b = f.get(),
    other = f.get("b");
  assert.equal(a.value, b.value);
  assert.notEqual(a.value, other.value);
  assert.equal(f.streams.length, 0);
  const stopA = a.mount(),
    stopB = b.mount(),
    stopOther = other.mount();
  await flush();
  assert.equal(f.streams.length, 2);
  f.streams[0].send({ type: "snapshot", rows: [row("sh")] });
  await flush();
  f.machineStore.selectMachine("b");
  f.machineStore.selectMachine(undefined);
  await flush();
  assert.equal(
    f.streams.length,
    2,
    "global selection must not restart either scoped subscription",
  );
  assert.deepEqual(f.state.get(a.value.terminalShellsAtom), [row("sh")]);
  assert.deepEqual(f.state.get(other.value.terminalShellsAtom), []);
  f.machineStore.clearMachineCredentials("b");
  assert.equal(f.streams[0].returns(), 0);
  assert.equal(f.streams[1].returns(), 1);
  stopA();
  assert.equal(f.streams[0].returns(), 0);
  stopB();
  assert.equal(f.streams[0].returns(), 1);
  stopOther();
  f.releaseMachines();
  f.store.dispose();
});

test("pairing and daemon replacement reject late events/errors; pending transport cannot survive remount", async () => {
  const f = fixture(),
    a = f.get();
  const stop = a.mount();
  await flush();
  f.streams[0].send({ type: "snapshot", rows: [row("old")] });
  await flush();
  f.machineStore.clearMachineCredentials("a");
  assert.deepEqual(f.state.get(a.value.terminalShellsAtom), []);
  f.machineStore.setMachineCredentials("a", {
    clientId: "new",
    clientSecret: "new",
    clientCredentialExpiresAtUnix: 100,
  });
  await flush();
  f.streams[0].send({ type: "snapshot", rows: [row("stale")] });
  f.streams[1].send({ type: "snapshot", rows: [row("new")] });
  await flush();
  assert.deepEqual(f.state.get(a.value.terminalShellsAtom), [row("new")]);
  f.state.set(f.sessions[0].daemonInstanceIdAtom, "replacement");
  await flush();
  f.streams[1].fail(new Error("late error"));
  f.streams[2].send({ type: "snapshot", rows: [row("fresh")] });
  await flush();
  f.streams[2].send({
    type: "patch",
    removes: [{ shellId: "fresh" }],
    upserts: [row("patched")],
  });
  await flush();
  assert.deepEqual(f.state.get(a.value.defaultShellAtom), row("patched"));
  stop();
  const pending = Promise.withResolvers<WebTransport>();
  f.sessions[0].webTransport = () => pending.promise;
  const pendingEntry = f.get(),
    stopPending = pendingEntry.mount();
  stopPending();
  f.sessions[0].webTransport = async () => ({}) as WebTransport;
  const next = f.get(),
    stopNext = next.mount();
  await flush();
  pending.resolve({} as WebTransport);
  await flush();
  assert.equal(f.streams.length, 4);
  f.streams[3].send({ type: "snapshot", rows: [row("remounted")] });
  await flush();
  assert.deepEqual(f.state.get(next.value.terminalShellsAtom), [
    row("remounted"),
  ]);
  stopNext();
  f.releaseMachines();
  f.store.dispose();
});
