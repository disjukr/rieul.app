import { createRoot, createSignal, flush as flushSolid } from "solid-js";
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  bunja,
  createBunjaStore,
  createReadScopeFn,
  createScope,
  override,
  type Bunja,
} from "bunja";
import { processesBunja } from "../src/state/processes.ts";
import { rpcSessionBunja } from "../src/state/rpc-session.ts";
import { encodeProcessesTableEventValue } from "../src/protocol/generated/rpc.ts";
import { encodeCbor } from "../src/protocol/cbor.ts";
import {
  encodeReqResMessageSequence,
  ReqResMessageKind,
} from "../src/protocol/wire.ts";
import {
  ProcId,
  type ProcessesTableEvent,
  type ProcessInfo,
} from "../src/protocol/generated/rpc.ts";
import type { DaemonInfoState } from "../src/state/rpc-session.ts";

const ready = (supported = true): DaemonInfoState => ({
  phase: "ready",
  receivedAtMs: 0,
  daemonInfo: {
    supportedProcIds: supported ? [ProcId.SubscribeProcesses] : [],
    version: "fixture",
    os: "fixture",
    instanceId: "fixture",
    startedAtMs: 0,
    serverTimeMs: 0,
  },
});
const row = (pid: number, name = String(pid)): ProcessInfo => ({
  pid,
  ppid: undefined,
  name,
  status: { type: "run" as const },
});
async function flush() {
  for (let i = 0; i < 20; i++) {
    flushSolid();
    await Promise.resolve();
  }
  flushSolid();
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
    send(event: ProcessesTableEvent) {
      controller.enqueue(
        encodeReqResMessageSequence([
          {
            kind: ReqResMessageKind.ResponseStreamChunk,
            payload: encodeCbor(encodeProcessesTableEventValue(event)),
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
  const SessionScope = createScope<ReturnType<typeof session>>();
  type RpcSession =
    typeof rpcSessionBunja extends Bunja<infer Value> ? Value : never;
  function unused(): never {
    throw new Error("Unexpected RPC method");
  }
  const streams: ReturnType<typeof stream>[] = [];
  const transport = {
    async createBidirectionalStream() {
      const channel = stream();
      streams.push(channel);
      return channel.transportStream;
    },
  } as WebTransport;
  function session() {
    const [daemonInstanceId, setDaemonInstanceId] = createSignal<
      string | undefined
    >("fixture");
    const [daemonInfo, setDaemonInfo] = createSignal<DaemonInfoState>(ready());
    return {
      cluster: () => ({ supported: false, message: "fixture" }),
      refreshCluster: async () => {},
      closeRpcSession: unused,
      reconnect: unused,
      resetController: unused,
      startPairingSession: async () => unused(),
      completePairingSession: async () => unused(),
      connection: createSignal({ phase: "idle" as const })[0],
      daemonInstanceId,
      setDaemonInstanceId,
      daemonServerTimeMs: createSignal(undefined)[0],
      daemonUptimeSeconds: createSignal(undefined)[0],
      daemonInfo,
      setDaemonInfo,
      webTransport: async () => transport,
    } satisfies RpcSession & {
      setDaemonInstanceId: typeof setDaemonInstanceId;
      setDaemonInfo: typeof setDaemonInfo;
    };
  }
  const sessions = [session(), session()];
  const store = createBunjaStore({
    wrapInstance: (init) => createRoot(init),
    overrides: [override(rpcSessionBunja, () => bunja.use(SessionScope))],
  });
  const get = (index = 0) =>
    store.get(
      processesBunja,
      createReadScopeFn([[SessionScope, sessions[index]]], () => {
        throw new Error("missing scope");
      }),
    );
  return { store, sessions, streams, get, transport };
}

test("list and tree share one stream, patches and final cleanup; sessions stay isolated", async () => {
  const f = fixture();
  const a = f.get(),
    b = f.get(),
    other = f.get(1);
  assert.equal(a.value, b.value);
  assert.notEqual(a.value, other.value);
  assert.equal(f.streams.length, 0, "resolution must not acquire resources");
  const stopA = a.mount(),
    stopB = b.mount(),
    stopOther = other.mount();
  await flush();
  assert.equal(f.streams.length, 2);
  f.streams[0].send({ type: "snapshot", rows: [row(2), row(1)] });
  await flush();
  f.streams[0].send({
    type: "patch",
    removePids: [2],
    upserts: [row(3), row(1, "new")],
  });
  await flush();
  assert.deepEqual((flushSolid(), a.value.state()).rows, [
    row(1, "new"),
    row(3),
  ]);
  assert.deepEqual((flushSolid(), other.value.state()).rows, []);
  stopA();
  assert.equal(f.streams[0].returns(), 0);
  stopB();
  f.streams[0].send({ type: "snapshot", rows: [] });
  await flush();
  assert.equal(f.streams[0].returns(), 1);
  assert.equal(f.streams[1].returns(), 0);
  stopOther();
  f.streams[1].send({ type: "snapshot", rows: [] });
  await flush();
  assert.equal(f.streams[1].returns(), 1);
  f.store.dispose();
});

test("disconnect/reconnect clears rows and rejects late events and failures", async () => {
  const f = fixture(),
    entry = f.get(),
    stop = entry.mount();
  await flush();
  f.streams[0].send({ type: "snapshot", rows: [row(1)] });
  await flush();
  f.sessions[0].setDaemonInfo({ phase: "idle" });
  flushSolid();
  assert.deepEqual((flushSolid(), entry.value.state()), {
    phase: "loading",
    rows: [],
  });
  f.sessions[0].setDaemonInfo(ready());
  flushSolid();
  await flush();
  f.streams[0].send({ type: "snapshot", rows: [row(99)] });
  f.streams[1].send({ type: "snapshot", rows: [row(2)] });
  await flush();
  assert.deepEqual((flushSolid(), entry.value.state()).rows, [row(2)]);
  f.sessions[0].setDaemonInfo({ phase: "loading" });
  flushSolid();
  f.sessions[0].setDaemonInfo(ready());
  flushSolid();
  await flush();
  f.streams[1].fail(new Error("stale failure"));
  f.streams[2].send({ type: "snapshot", rows: [row(3)] });
  await flush();
  assert.deepEqual((flushSolid(), entry.value.state()).rows, [row(3)]);
  stop();
  f.store.dispose();
});

test("unmount while transport is pending cannot subscribe after remount", async () => {
  const f = fixture(),
    pending = Promise.withResolvers<WebTransport>();
  f.sessions[0].webTransport = () => pending.promise;
  const entry = f.get(),
    stop = entry.mount();
  stop();
  f.sessions[0].webTransport = async () => f.transport;
  const next = f.get(),
    stopNext = next.mount();
  await flush();
  pending.resolve(f.transport);
  await flush();
  assert.equal(f.streams.length, 1);
  f.streams[0].send({ type: "snapshot", rows: [row(4)] });
  await flush();
  assert.deepEqual((flushSolid(), next.value.state()).rows, [row(4)]);
  stopNext();
  f.store.dispose();
});

test("unsupported, daemon failure, and stream failure remain visible states", async () => {
  const f = fixture();
  f.sessions[0].setDaemonInfo(ready(false));
  flushSolid();
  const entry = f.get(),
    stop = entry.mount();
  await flush();
  assert.equal(f.streams.length, 0);
  assert.equal((flushSolid(), entry.value.state()).phase, "unsupported");
  f.sessions[0].setDaemonInfo({
    phase: "error",
    message: "fixture",
  });
  flushSolid();
  assert.equal(
    (flushSolid(), entry.value.state()).message,
    "Daemon info unavailable",
  );
  f.sessions[0].setDaemonInfo(ready());
  flushSolid();
  await flush();
  f.streams[0].fail(new Error("stream failed"));
  await flush();
  assert.deepEqual((flushSolid(), entry.value.state()), {
    phase: "error",
    message: "stream failed",
    rows: [],
  });
  stop();
  f.store.dispose();
});
