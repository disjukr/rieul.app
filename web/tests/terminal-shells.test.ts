import { test } from "node:test";
import assert from "node:assert/strict";
import {
  bunja,
  createBunjaStore,
  createReadScopeFn,
  override,
  type Bunja,
} from "bunja";
import { atom, createStore } from "jotai/vanilla";
import { JotaiStoreScope } from "../src/state/jotai-store.ts";
import { terminalShellsBunja } from "../src/state/terminal-shells.ts";
import { rpcSessionBunja } from "../src/state/rpc-session.ts";
import { encodeAvailableShellsTableEventValue } from "../src/protocol/generated/rpc.ts";
import { encodeCbor } from "../src/protocol/cbor.ts";
import {
  encodeReqResMessageSequence,
  ReqResMessageKind,
} from "../src/protocol/wire.ts";
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
  let controller!: ReadableStreamDefaultController<Uint8Array>;
  let returns = 0;
  const readable = new ReadableStream<Uint8Array>({
    start(value) {
      controller = value;
    },
    cancel() {
      returns++;
    },
  });
  return {
    transportStream: { readable, writable: new WritableStream<Uint8Array>() },
    returns: () => returns,
    send(event: AvailableShellsTableEvent) {
      controller.enqueue(
        encodeReqResMessageSequence([
          {
            kind: ReqResMessageKind.ResponseStreamChunk,
            payload: encodeCbor(encodeAvailableShellsTableEventValue(event)),
          },
        ]),
      );
    },
    fail(error: unknown) {
      controller.error(error);
    },
  };
}
function fixture() {
  const state = createStore();
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
  const streams: ReturnType<typeof stream>[] = [];
  const transport = {
    async createBidirectionalStream() {
      const channel = stream();
      streams.push(channel);
      return channel.transportStream;
    },
  } as WebTransport;
  type RpcSession =
    typeof rpcSessionBunja extends Bunja<infer Value> ? Value : never;
  function unused(): never {
    throw new Error("Unexpected RPC method in shell test");
  }
  const sessions = machines.map(
    () =>
      ({
        closeRpcSession: unused,
        reconnect: unused,
        resetController: unused,
        startPairingSession: async () => unused(),
        completePairingSession: async () => unused(),
        connectionAtom: atom({ phase: "idle" as const }),
        daemonInfoAtom: atom({ phase: "idle" as const }),
        daemonServerTimeMsAtom: atom<number | undefined>(undefined),
        daemonUptimeSecondsAtom: atom<number | undefined>(undefined),
        daemonInstanceIdAtom: atom<string | undefined>("daemon"),
        webTransport: async () => transport,
      }) satisfies RpcSession,
  );
  const store = createBunjaStore({
    overrides: [
      override(rpcSessionBunja, () => {
        const session =
          sessions[bunja.use(machineBunja).machineId === "a" ? 0 : 1];
        return session;
      }),
    ],
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
  const get = (id = "a") => store.get(terminalShellsBunja, scopes(id));
  return {
    state,
    store,
    sessions,
    streams,
    machineStore: machineStore.value,
    releaseMachines,
    transport,
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
  f.streams[1].send({ type: "snapshot", rows: [] });
  await flush();
  assert.equal(f.streams[1].returns(), 1);
  stopA();
  assert.equal(f.streams[0].returns(), 0);
  stopB();
  f.streams[0].send({ type: "snapshot", rows: [row("late")] });
  await flush();
  assert.equal(f.streams[0].returns(), 1);
  assert.deepEqual(f.state.get(a.value.terminalShellsAtom), [row("sh")]);
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
  f.sessions[0].webTransport = async () => f.transport;
  const next = f.get(),
    stopNext = next.mount();
  await flush();
  pending.resolve(f.transport);
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
