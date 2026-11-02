import { test, mock } from "node:test";
import assert from "node:assert/strict";
import { createBunjaStore, createReadScopeFn, override } from "bunja";
import { createRoot, createSignal, flush as flushSolid } from "solid-js";
import * as client from "../src/protocol/updates.ts";
import {
  ProcId,
  UpdatePhase,
  type UpdateStatus,
  type DaemonInfo,
} from "../src/protocol/generated/rpc.ts";
import { rpcSessionStub } from "./helpers/rpc-session.ts";
import * as runtime from "../src/protocol/client.ts";
let subscribe: (signal?: AbortSignal) => AsyncGenerator<UpdateStatus>;
mock.module("../src/protocol/client.ts", {
  namedExports: {
    ...runtime,
    callServerStream: (
      _transport: WebTransport,
      _proc: unknown,
      _request: unknown,
      signal?: AbortSignal,
    ) => subscribe(signal),
  },
});
let check: typeof client.checkForUpdates;
let install: typeof client.installUpdateConfirmed;
mock.module("../src/protocol/updates.ts", {
  namedExports: {
    ...client,
    checkForUpdates: (...args: Parameters<typeof check>) => check(...args),
    installUpdateConfirmed: (...args: Parameters<typeof install>) =>
      install(...args),
  },
});
const { rpcSessionBunja } = await import("../src/state/rpc-session.ts");
const { daemonUpdatesBunja } = await import("../src/state/daemon-updates.ts");
const ready = (instanceId: string, streaming = true) => ({
  phase: "ready" as const,
  receivedAtMs: 0,
  daemonInfo: {
    instanceId,
    version: "1.0.0",
    os: "macos",
    startedAtMs: 0,
    serverTimeMs: 0,
    supportedProcIds: streaming
      ? [
          ProcId.CheckForUpdates,
          ProcId.InstallUpdateConfirmed,
          ProcId.SubscribeUpdateStatus,
        ]
      : [],
  } satisfies DaemonInfo,
});
const status: UpdateStatus = {
  phase: UpdatePhase.Ready,
  currentVersion: "1.0.0",
  targetVersion: "1.0.1",
  canInstall: true,
  ordering: { epoch: "first", revision: 1 },
};
async function flush() {
  for (let i = 0; i < 30; i++) {
    flushSolid();
    await Promise.resolve();
  }
  flushSolid();
}
function fixture(
  transport: () => Promise<WebTransport> = async () => ({}) as WebTransport,
  streaming = true,
) {
  const [info, setInfo] = createSignal(ready("first", streaming));
  const store = createBunjaStore({
    wrapInstance: (init) => createRoot(init),
    overrides: [
      override(rpcSessionBunja, () =>
        rpcSessionStub({ daemonInfo: info, webTransport: transport }),
      ),
    ],
  });
  const entry = store.get(
    daemonUpdatesBunja,
    createReadScopeFn([], () => undefined as never),
  );
  const stop = entry.mount();
  return {
    setInfo,
    value: entry.value,
    close() {
      stop();
      store.dispose();
    },
  };
}
function eventQueue() {
  const waiting: ((value: UpdateStatus | undefined) => void)[] = [];
  let cancelled = false;
  return {
    push(value: UpdateStatus) {
      assert.ok(waiting.length);
      waiting.shift()!(value);
    },
    end() {
      assert.ok(waiting.length);
      waiting.shift()!(undefined);
    },
    get cancelled() {
      return cancelled;
    },
    async *stream(signal?: AbortSignal) {
      const abort = () => {
        cancelled = true;
        for (const resolve of waiting.splice(0)) resolve(undefined);
      };
      signal?.addEventListener("abort", abort, { once: true });
      try {
        while (!signal?.aborted) {
          const value = await new Promise<UpdateStatus | undefined>((resolve) =>
            waiting.push(resolve),
          );
          if (!value) return;
          yield value;
        }
      } finally {
        signal?.removeEventListener("abort", abort);
      }
    },
  };
}
const ordered = (
  phase: UpdatePhase,
  revision: number,
  epoch = "first",
): UpdateStatus => ({ ...status, phase, ordering: { epoch, revision } });

test("subscription replaces polling; immediate Checking and newer event wins over late command", async () => {
  const q = eventQueue();
  subscribe = (signal) => q.stream(signal);
  const response = Promise.withResolvers<UpdateStatus>();
  check = () => response.promise;
  const f = fixture(undefined, true);
  try {
    await flush();
    q.push(ordered(UpdatePhase.Idle, 1));
    await flush();
    const action = f.value.check();
    await flush();
    assert.equal(f.value.status()?.phase, UpdatePhase.Checking);
    q.push(ordered(UpdatePhase.Downloading, 3));
    await flush();
    q.push(ordered(UpdatePhase.Ready, 4));
    await flush();
    response.resolve(ordered(UpdatePhase.Downloading, 3));
    await action;
    await flush();
    assert.equal(f.value.status()?.phase, UpdatePhase.Ready);
    assert.equal(f.value.status()?.ordering?.revision, 4);
  } finally {
    f.close();
  }
  await flush();
  assert.ok(q.cancelled);
});

test("reconnect receives a fresh snapshot; server epoch reset rejects old command results", async () => {
  const queues = [eventQueue(), eventQueue()];
  let count = 0;
  subscribe = (signal) => queues[count++].stream(signal);
  const response = Promise.withResolvers<UpdateStatus>();
  check = () => response.promise;
  const f = fixture(undefined, true);
  try {
    await flush();
    queues[0].push(ordered(UpdatePhase.Idle, 50));
    await flush();
    const action = f.value.check();
    await flush();
    f.setInfo(ready("replacement", true));
    await flush();
    assert.ok(queues[0].cancelled);
    queues[1].push(ordered(UpdatePhase.Idle, 1, "replacement"));
    await flush();
    response.resolve(ordered(UpdatePhase.Ready, 51));
    await action;
    await flush();
    assert.equal(f.value.status()?.ordering?.epoch, "replacement");
    assert.equal(f.value.status()?.phase, UpdatePhase.Idle);
  } finally {
    f.close();
  }
});

test("failed command clears optimistic Checking without corrupting last snapshot", async () => {
  const q = eventQueue();
  subscribe = (signal) => q.stream(signal);
  check = async () => {
    throw new Error("busy");
  };
  const f = fixture();
  try {
    await flush();
    q.push(ordered(UpdatePhase.Idle, 1));
    await flush();
    await f.value.check();
    await flush();
    assert.equal(f.value.status()?.phase, UpdatePhase.Idle);
    assert.match(f.value.message()!, /failed/);
  } finally {
    f.close();
  }
});

test("unsupported old daemon is explicit and no polling or commands are attempted", async () => {
  let calls = 0;
  subscribe = async function* () {
    calls++;
  };
  check = install = async () => {
    calls++;
    return status;
  };
  const f = fixture(undefined, false);
  try {
    await flush();
    await f.value.check();
    assert.equal(f.value.supported(), false);
    assert.match(f.value.message()!, /newer daemon/);
    assert.equal(calls, 0);
  } finally {
    f.close();
  }
});

test("explicit installation is single-flight and stale confirmation cannot reach replacement daemon", async () => {
  const queues = [eventQueue(), eventQueue()];
  let count = 0;
  subscribe = (signal) => queues[count++].stream(signal);
  const pending = Promise.withResolvers<UpdateStatus>();
  let calls = 0;
  install = () => {
    calls++;
    return pending.promise;
  };
  const f = fixture();
  try {
    await flush();
    queues[0].push(ordered(UpdatePhase.Ready, 1));
    await flush();
    const token = f.value.confirmationToken();
    const first = f.value.installConfirmed(token);
    const duplicate = f.value.installConfirmed(token);
    await flush();
    assert.equal(calls, 1);
    pending.resolve(ordered(UpdatePhase.Deferred, 2));
    await Promise.all([first, duplicate]);
    f.setInfo(ready("replacement"));
    await flush();
    queues[1].push(ordered(UpdatePhase.Ready, 1, "replacement"));
    await flush();
    await f.value.installConfirmed(token);
    assert.equal(calls, 1);
  } finally {
    f.close();
  }
});

test("unmount while waiting for transport never opens subscription or sends command", async () => {
  const pending = Promise.withResolvers<WebTransport>();
  let calls = 0;
  subscribe = async function* () {
    calls++;
  };
  check = async () => {
    calls++;
    return status;
  };
  const f = fixture(() => pending.promise);
  await flush();
  const action = f.value.check();
  f.close();
  pending.resolve({} as WebTransport);
  await action;
  await flush();
  assert.equal(calls, 0);
});

for (const commandError of [false, true]) {
  test(`same-revision subscription recovery clears only its connection warning (command error=${commandError})`, async () => {
    const queues = [eventQueue(), eventQueue()];
    let count = 0;
    subscribe = (signal) => queues[count++].stream(signal);
    check = async () => {
      throw new Error("fixture command failure");
    };
    const f = fixture();
    try {
      await flush();
      queues[0].push(ordered(UpdatePhase.Idle, 7));
      await flush();
      if (commandError) {
        await f.value.check();
        await flush();
      }
      queues[0].end();
      await flush();
      assert.match(f.value.message()!, /disconnected/);
      void f.value.refresh();
      await flush();
      queues[1].push(ordered(UpdatePhase.Idle, 7));
      await flush();
      assert.equal(f.value.status()?.ordering?.revision, 7);
      if (commandError) assert.match(f.value.message()!, /check failed/);
      else assert.equal(f.value.message(), undefined);
    } finally {
      f.close();
    }
  });
}
