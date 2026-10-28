import { test } from "node:test";
import assert from "node:assert/strict";
import { bunja, createBunjaStore, createReadScopeFn, createScope } from "bunja";
import { atom, createStore } from "jotai/vanilla";
import { JotaiStoreScope } from "unsaturated/store";
import { createProcessesBunja } from "../src/state/processes-model.ts";
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
  name,
  status: { type: "run" as const },
});
async function flush() {
  for (let i = 0; i < 20; i++) await Promise.resolve();
}
function stream() {
  let pending = Promise.withResolvers<IteratorResult<ProcessesTableEvent>>();
  let returns = 0;
  const iterator: AsyncGenerator<ProcessesTableEvent> = {
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
    send(event: ProcessesTableEvent) {
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
  const SessionScope = createScope<ReturnType<typeof session>>();
  function session() {
    return {
      daemonInfoAtom: atom<DaemonInfoState>(ready()),
      webTransport: async () => ({}) as WebTransport,
    };
  }
  const sessions = [session(), session()];
  const streams: ReturnType<typeof stream>[] = [];
  const model = createProcessesBunja(
    bunja(() => bunja.use(SessionScope)),
    () => {
      const channel = stream();
      streams.push(channel);
      return channel.iterator;
    },
  );
  const get = (index = 0) =>
    store.get(
      model,
      createReadScopeFn(
        [
          [JotaiStoreScope, state],
          [SessionScope, sessions[index]],
        ],
        () => {
          throw new Error("missing scope");
        },
      ),
    );
  return { state, store, sessions, streams, get };
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
  assert.deepEqual(f.state.get(a.value.stateAtom).rows, [
    row(1, "new"),
    row(3),
  ]);
  assert.deepEqual(f.state.get(other.value.stateAtom).rows, []);
  stopA();
  assert.equal(f.streams[0].returns(), 0);
  stopB();
  assert.equal(f.streams[0].returns(), 1);
  assert.equal(f.streams[1].returns(), 0);
  stopOther();
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
  f.state.set(f.sessions[0].daemonInfoAtom, { phase: "idle" });
  assert.deepEqual(f.state.get(entry.value.stateAtom), {
    phase: "loading",
    rows: [],
  });
  assert.equal(f.streams[0].returns(), 1);
  f.state.set(f.sessions[0].daemonInfoAtom, ready());
  await flush();
  f.streams[0].send({ type: "snapshot", rows: [row(99)] });
  f.streams[1].send({ type: "snapshot", rows: [row(2)] });
  await flush();
  assert.deepEqual(f.state.get(entry.value.stateAtom).rows, [row(2)]);
  f.state.set(f.sessions[0].daemonInfoAtom, { phase: "loading" });
  f.state.set(f.sessions[0].daemonInfoAtom, ready());
  await flush();
  f.streams[1].fail(new Error("stale failure"));
  f.streams[2].send({ type: "snapshot", rows: [row(3)] });
  await flush();
  assert.deepEqual(f.state.get(entry.value.stateAtom).rows, [row(3)]);
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
  f.sessions[0].webTransport = async () => ({}) as WebTransport;
  const next = f.get(),
    stopNext = next.mount();
  await flush();
  pending.resolve({} as WebTransport);
  await flush();
  assert.equal(f.streams.length, 1);
  f.streams[0].send({ type: "snapshot", rows: [row(4)] });
  await flush();
  assert.deepEqual(f.state.get(next.value.stateAtom).rows, [row(4)]);
  stopNext();
  f.store.dispose();
});

test("unsupported, daemon failure, and stream failure remain visible states", async () => {
  const f = fixture();
  f.state.set(f.sessions[0].daemonInfoAtom, ready(false));
  const entry = f.get(),
    stop = entry.mount();
  await flush();
  assert.equal(f.streams.length, 0);
  assert.equal(f.state.get(entry.value.stateAtom).phase, "unsupported");
  f.state.set(f.sessions[0].daemonInfoAtom, {
    phase: "error",
    message: "fixture",
  });
  assert.equal(
    f.state.get(entry.value.stateAtom).message,
    "Daemon info unavailable",
  );
  f.state.set(f.sessions[0].daemonInfoAtom, ready());
  await flush();
  f.streams[0].fail(new Error("stream failed"));
  await flush();
  assert.deepEqual(f.state.get(entry.value.stateAtom), {
    phase: "error",
    message: "stream failed",
    rows: [],
  });
  stop();
  f.store.dispose();
});
