import {
  decodeDatagramMessage,
  encodeDatagramMessage,
  DatagramMessageKind,
} from "../src/protocol/wire.ts";
import { createRoot, createSignal, flush as flushSolid } from "solid-js";
import { test, mock } from "node:test";
import assert from "node:assert/strict";
import { bunja, createBunjaStore, createReadScopeFn, override } from "bunja";
import { nowBunja } from "../src/state/now.ts";
import * as protocol from "../src/protocol/client.ts";
import * as client from "../src/protocol/generated/client.ts";
import { machineBunja, machineStoreBunja } from "../src/state/machine-store.ts";
import {
  MachineIdScope,
  MachineBaseUrlScope,
} from "../src/state/machine-scopes.ts";
import { MachineStorageScope } from "../src/state/machine-storage.ts";
import { WorkbenchTabIdScope } from "../src/state/workbench-scopes.ts";
import type { DaemonInfo } from "../src/protocol/generated/rpc.ts";
import { rpcSessionStub } from "./helpers/rpc-session.ts";
let open: typeof protocol.openWebTransport;
let getInfo: typeof client.getDaemonInfo;
let renew: typeof client.renewClientCredential;
mock.module("../src/protocol/client.ts", {
  namedExports: {
    ...protocol,
    authenticateWebTransport: async () => {},
    openWebTransport: (...args: Parameters<typeof open>) => open(...args),
  },
});
mock.module("../src/protocol/generated/client.ts", {
  namedExports: {
    ...client,
    renewClientCredential: (...args: Parameters<typeof renew>) =>
      renew(...args),
    getDaemonInfo: (...args: Parameters<typeof getInfo>) => getInfo(...args),
  },
});
const { rpcSessionBunja } = await import("../src/state/rpc-session.ts");
const { machineModalBunja } = await import("../src/state/machine-modal.ts");
const { fileViewerBunja, FsEntryPathScope: pathScope } = await import(
  "../src/view/workbench/tool/files/content/file-viewer/state.tsx"
);
async function flush() {
  for (let i = 0; i < 40; i++) {
    flushSolid();
    await Promise.resolve();
  }
  flushSolid();
}
function fixture(overrides: Parameters<typeof createBunjaStore>[0] = {}) {
  const store = createBunjaStore({
    wrapInstance: (init) => createRoot(init),
    overrides: [
      override(nowBunja, () => {
        const [value] = createSignal(0);
        return {
          now: value,
          nowEverySecond: value,
        };
      }),
      ...(overrides.overrides ?? []),
    ],
  });
  const storage = {
    getItem: (key: string) =>
      key === "rieul.machines.v1"
        ? JSON.stringify([{ id: "a", name: "A", baseUrl: "https://a" }])
        : "a",
    setItem() {},
    removeItem() {},
  };
  const read = createReadScopeFn(
    [
      [MachineStorageScope, storage],
      [MachineIdScope, "a"],
      [MachineBaseUrlScope, "https://a"],
      [WorkbenchTabIdScope, "tab"],
      [pathScope, "/file.txt"],
    ],
    () => undefined as never,
  );
  return { store, read };
}
function transport() {
  const closed = Promise.withResolvers<void>();
  let reader!: ReadableStreamDefaultController<Uint8Array>;
  let ended = false;
  return {
    closed: closed.promise,
    datagrams: {
      readable: new ReadableStream<Uint8Array>({
        start(c) {
          reader = c;
        },
      }),
      writable: new WritableStream<Uint8Array>(),
    },
    close() {
      if (!ended) {
        ended = true;
        reader.close();
        closed.resolve();
      }
    },
  } as unknown as WebTransport;
}
const info = (instanceId: string): DaemonInfo => ({
  instanceId,
  version: "fixture",
  os: "fixture",
  supportedProcIds: [],
  startedAtMs: 0,
  serverTimeMs: 0,
});
test("reconnected RPC ignores old daemon info success and failure", async (t) => {
  const requests: ReturnType<typeof Promise.withResolvers<DaemonInfo>>[] = [];
  open = async () => transport();
  getInfo = () => {
    const pending = Promise.withResolvers<DaemonInfo>();
    requests.push(pending);
    return pending.promise;
  };
  const f = fixture(),
    entry = f.store.get(rpcSessionBunja, f.read),
    stop = entry.mount();
  t.after(() => {
    stop();
    f.store.dispose();
  });
  await flush();
  entry.value.reconnect();
  await flush();
  requests[1].resolve(info("new"));
  await flush();
  requests[0].resolve(info("old"));
  await flush();
  assert.equal((flushSolid(), entry.value.daemonInstanceId()), "new");
  entry.value.reconnect();
  await flush();
  entry.value.reconnect();
  await flush();
  requests[3].resolve(info("newest"));
  await flush();
  requests[2].reject(new Error("old failure"));
  await flush();
  assert.equal((flushSolid(), entry.value.daemonInstanceId()), "newest");
});
test("pair completion cannot update credentials or a replacement modal after cancellation", async () => {
  const pending = Promise.withResolvers<{
    clientId: string;
    clientSecret: string;
    clientCredentialExpiresAtUnix: number;
  }>();
  const f = fixture({
    overrides: [
      override(rpcSessionBunja, () => {
        bunja.use(machineBunja);
        return rpcSessionStub({
          startPairingSession: async () => ({ pairingCodeExpiresAtUnix: 100 }),
          completePairingSession: () => pending.promise,
        });
      }),
    ],
  });
  const entry = f.store.get(machineModalBunja, f.read),
    stop = entry.mount();
  entry.value.openPairMachineModal("a");
  await flush();
  entry.value.setPairingCode("1234");
  flushSolid();
  const complete = entry.value.pairSelected();
  entry.value.closeMachineModal();
  entry.value.openAddMachineModal();
  pending.resolve({
    clientId: "old",
    clientSecret: "old",
    clientCredentialExpiresAtUnix: 100,
  });
  await complete;
  assert.equal(
    f.store.get(machineStoreBunja, f.read).value.findMachine("a")?.clientSecret,
    undefined,
  );
  assert.equal((flushSolid(), entry.value.machineModalMode()), "add");
  stop();
  f.store.dispose();
});
test("file viewer exposes transport failure instead of staying in detection", async () => {
  const f = fixture({
    overrides: [
      override(rpcSessionBunja, () =>
        rpcSessionStub({
          webTransport: async () => {
            throw new Error("offline fixture");
          },
        }),
      ),
    ],
  });
  const entry = f.store.get(fileViewerBunja, f.read),
    stop = entry.mount();
  await flush();
  assert.deepEqual((flushSolid(), entry.value.state()), {
    phase: "error",
    message: "offline fixture",
  });
  stop();
  f.store.dispose();
});

test("a transport opened before reconnect cannot publish state after the new connection", async (t) => {
  const pending = Promise.withResolvers<WebTransport>();
  let first = true;
  open = () => {
    if (first) {
      first = false;
      return pending.promise;
    }
    return Promise.resolve(transport());
  };
  getInfo = async () => info("current");
  const f = fixture(),
    entry = f.store.get(rpcSessionBunja, f.read),
    stop = entry.mount();
  t.after(() => {
    stop();
    f.store.dispose();
  });
  entry.value.reconnect();
  await flush();
  assert.equal((flushSolid(), entry.value.daemonInstanceId()), "current");
  const old = transport();
  pending.resolve(old);
  await flush();
  await old.closed;
  assert.equal((flushSolid(), entry.value.daemonInstanceId()), "current");
  assert.equal((flushSolid(), entry.value.connection()).phase, "reachable");
});

test("pairing late failure cannot overwrite a new machine or a disposed modal", async () => {
  for (const dispose of [false, true]) {
    const pending = Promise.withResolvers<never>();
    const f = fixture({
      overrides: [
        override(rpcSessionBunja, () =>
          rpcSessionStub({
            startPairingSession: async () => ({
              pairingCodeExpiresAtUnix: 100,
            }),
            completePairingSession: () => pending.promise,
          }),
        ),
      ],
    });
    const entry = f.store.get(machineModalBunja, f.read),
      stop = entry.mount();
    entry.value.openPairMachineModal("a");
    await flush();
    entry.value.setPairingCode("1234");
    flushSolid();
    const complete = entry.value.pairSelected();
    if (dispose) stop();
    else f.store.get(machineStoreBunja, f.read).value.selectMachine("b");
    flushSolid();
    const currentError = entry.value.machineFormError();
    pending.reject(new Error("late pairing failure"));
    await complete;
    assert.equal((flushSolid(), entry.value.machineFormError()), currentError);
    if (!dispose) stop();
    f.store.dispose();
  }
});

test("file viewer late transport failure cannot write after unmount", async () => {
  const pending = Promise.withResolvers<WebTransport>();
  const f = fixture({
    overrides: [
      override(rpcSessionBunja, () =>
        rpcSessionStub({ webTransport: () => pending.promise }),
      ),
    ],
  });
  const entry = f.store.get(fileViewerBunja, f.read),
    stop = entry.mount();
  stop();
  const before = (flushSolid(), entry.value.state());
  pending.reject(new Error("late transport failure"));
  await flush();
  assert.equal((flushSolid(), entry.value.state()), before);
  f.store.dispose();
});

test("daemon info arriving after transport close cannot restore ready state", async (t) => {
  const remote = transport(),
    pending = Promise.withResolvers<DaemonInfo>();
  open = async () => remote;
  getInfo = () => pending.promise;
  const f = fixture(),
    entry = f.store.get(rpcSessionBunja, f.read),
    stop = entry.mount();
  t.after(() => {
    stop();
    f.store.dispose();
  });
  await flush();
  remote.close();
  await flush();
  pending.resolve(info("closed"));
  await flush();
  assert.equal((flushSolid(), entry.value.daemonInfo()).phase, "idle");
  assert.equal((flushSolid(), entry.value.connection()).phase, "offline");
});

test("credential renewal from a replaced RPC session cannot overwrite its successor", async (t) => {
  const old = Promise.withResolvers<{
    clientCredentialExpiresAtUnix: number;
  }>();
  let first = true;
  renew = () => {
    if (first) {
      first = false;
      return old.promise;
    }
    return Promise.resolve({ clientCredentialExpiresAtUnix: 200 });
  };
  open = async () => transport();
  getInfo = async () => info("current");
  const f = fixture(),
    machines = f.store.get(machineStoreBunja, f.read).value;
  machines.setMachineCredentials("a", {
    clientId: "client",
    clientSecret: "secret",
    clientCredentialExpiresAtUnix: 0,
  });
  flushSolid();
  const entry = f.store.get(rpcSessionBunja, f.read),
    stop = entry.mount();
  t.after(() => {
    stop();
    f.store.dispose();
  });
  await flush();
  entry.value.reconnect();
  await flush();
  assert.equal(machines.findMachine("a")?.clientCredentialExpiresAtUnix, 200);
  old.resolve({ clientCredentialExpiresAtUnix: 100 });
  await flush();
  assert.equal(machines.findMachine("a")?.clientCredentialExpiresAtUnix, 200);
});

function observableTransport(closeNotification = true) {
  const closed = Promise.withResolvers<void>();
  let reader!: ReadableStreamDefaultController<Uint8Array>;
  let readableEnded = false;
  let writesFail = false;
  let closeCount = 0;
  const pings: number[] = [];
  const remote = {
    closed: closed.promise,
    datagrams: {
      readable: new ReadableStream<Uint8Array>({
        start(value) {
          reader = value;
        },
      }),
      writable: new WritableStream<Uint8Array>({
        write(bytes) {
          if (writesFail) throw new Error("datagram write failed");
          const message = decodeDatagramMessage(bytes);
          if (message.kind === DatagramMessageKind.Ping)
            pings.push(message.pingId);
        },
      }),
    },
    close() {
      closeCount++;
      if (!readableEnded) {
        readableEnded = true;
        reader.close();
      }
      if (closeNotification) closed.resolve();
    },
  } as unknown as WebTransport;
  return {
    remote,
    pings,
    closed,
    closeCount: () => closeCount,
    failWrites() {
      writesFail = true;
    },
    endDatagrams() {
      readableEnded = true;
      reader.close();
    },
    failDatagrams() {
      readableEnded = true;
      reader.error(new Error("receive failed"));
    },
    pong(id: number) {
      reader.enqueue(
        encodeDatagramMessage({ kind: DatagramMessageKind.Pong, pingId: id }),
      );
    },
  };
}

for (const failure of [
  "closed resolution",
  "closed rejection",
  "receive EOF",
  "receive failure",
  "write failure",
  "heartbeat timeout",
] as const) {
  test(`RPC stops reporting reachable on ${failure} even without a transport close notification`, async (t) => {
    t.mock.timers.enable({ apis: ["setTimeout", "setInterval"] });
    const remote = observableTransport();
    open = async () => remote.remote;
    getInfo = async () => info("live");
    const f = fixture(),
      entry = f.store.get(rpcSessionBunja, f.read),
      stop = entry.mount();
    t.after(() => {
      stop();
      f.store.dispose();
    });
    await flush();
    assert.equal(entry.value.connection().phase, "reachable");
    assert.equal(entry.value.daemonInstanceId(), "live");
    switch (failure) {
      case "closed resolution":
        remote.closed.resolve();
        break;
      case "closed rejection":
        remote.closed.reject(new Error("daemon exited"));
        break;
      case "receive EOF":
        remote.endDatagrams();
        break;
      case "receive failure":
        remote.failDatagrams();
        break;
      case "write failure":
        remote.pong(remote.pings[0]);
        await flush();
        remote.failWrites();
        t.mock.timers.tick(5000);
        break;
      case "heartbeat timeout":
        t.mock.timers.tick(4999);
        await flush();
        assert.equal(entry.value.connection().phase, "reachable");
        t.mock.timers.tick(1);
        break;
    }
    await flush();
    assert.equal(entry.value.connection().phase, "offline");
    assert.equal(entry.value.daemonInfo().phase, "idle");
    assert.equal(entry.value.daemonInstanceId(), undefined);
    if (!failure.startsWith("closed")) assert.equal(remote.closeCount(), 1);
    const sent = remote.pings.length;
    t.mock.timers.tick(20000);
    await flush();
    assert.equal(
      remote.pings.length,
      sent,
      "lost sessions release their heartbeat timer",
    );
  });
}

test("matching pongs keep a session live; unrelated pongs cannot extend its deadline", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "setInterval"] });
  const remote = observableTransport();
  open = async () => remote.remote;
  getInfo = async () => info("live");
  const f = fixture(),
    entry = f.store.get(rpcSessionBunja, f.read),
    stop = entry.mount();
  t.after(() => {
    stop();
    f.store.dispose();
  });
  await flush();
  for (let index = 0; index < 3; index++) {
    remote.pong(remote.pings.at(-1)!);
    await flush();
    t.mock.timers.tick(5000);
    await flush();
    assert.equal(entry.value.connection().phase, "reachable");
  }
  remote.pong(99999);
  await flush();
  t.mock.timers.tick(5000);
  await flush();
  assert.equal(entry.value.connection().phase, "offline");
});

test("a heartbeat timeout invalidates pending daemon info and old closure cannot affect reconnect", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "setInterval"] });
  const old = observableTransport(),
    fresh = observableTransport();
  const pendingInfo = Promise.withResolvers<DaemonInfo>();
  open = async () => old.remote;
  getInfo = () => pendingInfo.promise;
  const f = fixture(),
    entry = f.store.get(rpcSessionBunja, f.read),
    stop = entry.mount();
  t.after(() => {
    stop();
    f.store.dispose();
  });
  await flush();
  t.mock.timers.tick(5000);
  await flush();
  assert.equal(entry.value.connection().phase, "offline");
  open = async () => fresh.remote;
  getInfo = async () => info("fresh");
  entry.value.reconnect();
  await flush();
  pendingInfo.resolve(info("stale"));
  await flush();
  assert.equal(entry.value.connection().phase, "reachable");
  assert.equal(entry.value.daemonInstanceId(), "fresh");
});

test("transport loss during credential renewal cannot leave a connecting session alive", async (t) => {
  const remote = observableTransport(),
    renewal = Promise.withResolvers<{
      clientCredentialExpiresAtUnix: number;
    }>();
  open = async () => remote.remote;
  renew = () => renewal.promise;
  getInfo = async () => info("must not arrive");
  const f = fixture(),
    machines = f.store.get(machineStoreBunja, f.read).value;
  machines.setMachineCredentials("a", {
    clientId: "client",
    clientSecret: "secret",
    clientCredentialExpiresAtUnix: 0,
  });
  await flush();
  const entry = f.store.get(rpcSessionBunja, f.read),
    stop = entry.mount();
  t.after(() => {
    stop();
    f.store.dispose();
  });
  await flush();
  remote.closed.reject(new Error("lost during renewal"));
  await flush();
  assert.equal(entry.value.connection().phase, "offline");
  assert.equal(remote.closeCount(), 1);
  renewal.resolve({ clientCredentialExpiresAtUnix: 200 });
  await flush();
  assert.equal(entry.value.daemonInstanceId(), undefined);
  assert.equal(machines.findMachine("a")?.clientCredentialExpiresAtUnix, 0);
});

test("saved pairing credentials do not imply a live connection when opening fails", async (t) => {
  open = async () => {
    throw new Error("daemon not running");
  };
  const f = fixture(),
    machines = f.store.get(machineStoreBunja, f.read).value;
  machines.setMachineCredentials("a", {
    clientId: "client",
    clientSecret: "secret",
    clientCredentialExpiresAtUnix: 0,
  });
  await flush();
  const entry = f.store.get(rpcSessionBunja, f.read),
    stop = entry.mount();
  t.after(() => {
    stop();
    f.store.dispose();
  });
  await flush();
  assert.equal(entry.value.connection().phase, "offline");
  assert.equal(entry.value.daemonInfo().phase, "idle");
  assert.equal(machines.findMachine("a")?.clientId, "client");
});

test("a replaced transport's delayed close rejection cannot disconnect its successor", async (t) => {
  const old = observableTransport(false),
    fresh = observableTransport();
  open = async () => old.remote;
  getInfo = async () => info("old");
  const f = fixture(),
    entry = f.store.get(rpcSessionBunja, f.read),
    stop = entry.mount();
  t.after(() => {
    stop();
    f.store.dispose();
  });
  await flush();
  open = async () => fresh.remote;
  getInfo = async () => info("fresh");
  entry.value.reconnect();
  await flush();
  old.closed.reject(new Error("delayed old close"));
  await flush();
  assert.equal(entry.value.connection().phase, "reachable");
  assert.equal(entry.value.daemonInstanceId(), "fresh");
});
