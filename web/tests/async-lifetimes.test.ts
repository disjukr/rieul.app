import { test, mock } from "node:test";
import assert from "node:assert/strict";
import { bunja, createBunjaStore, createReadScopeFn, override } from "bunja";
import { atom, createStore } from "jotai/vanilla";
import { nowBunja } from "unsaturated/now";
import { JotaiStoreScope } from "unsaturated/store";
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
mock.module("../src/protocol/client.ts", {
  namedExports: {
    ...protocol,
    openWebTransport: (...args: Parameters<typeof open>) => open(...args),
  },
});
mock.module("../src/protocol/generated/client.ts", {
  namedExports: {
    ...client,
    getDaemonInfo: (...args: Parameters<typeof getInfo>) => getInfo(...args),
  },
});
const { rpcSessionBunja } = await import("../src/state/rpc-session.ts");
const { machineModalBunja } = await import("../src/state/machine-modal.ts");
const { fileViewerBunja, FsEntryPathContext } = await import(
  "../src/view/workbench/tool/files/content/file-viewer/state.tsx"
);
const { scopeContextMap } = await import("bunja/react");
const pathScope = [...scopeContextMap].find(
  ([, context]) => context === FsEntryPathContext,
)![0];
async function flush() {
  for (let i = 0; i < 40; i++) await Promise.resolve();
}
function fixture(overrides: Parameters<typeof createBunjaStore>[0] = {}) {
  const state = createStore(),
    store = createBunjaStore({
      overrides: [
        override(nowBunja, () => {
          const value = atom(0);
          return {
            nowAtom: value,
            nowEverySecondAtom: value,
            nowEveryMinuteAtom: value,
            nowEveryUtcHourAtom: value,
            nowEveryLocalHourAtom: value,
            nowEveryUtcDayAtom: value,
            nowEveryLocalDayAtom: value,
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
      [JotaiStoreScope, state],
      [MachineStorageScope, storage],
      [MachineIdScope, "a"],
      [MachineBaseUrlScope, "https://a"],
      [WorkbenchTabIdScope, "tab"],
      [pathScope, "/file.txt"],
    ],
    () => undefined as never,
  );
  return { state, store, read };
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
  assert.equal(f.state.get(entry.value.daemonInstanceIdAtom), "new");
  entry.value.reconnect();
  await flush();
  entry.value.reconnect();
  await flush();
  requests[3].resolve(info("newest"));
  await flush();
  requests[2].reject(new Error("old failure"));
  await flush();
  assert.equal(f.state.get(entry.value.daemonInstanceIdAtom), "newest");
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
  f.state.set(entry.value.pairingCodeAtom, "1234");
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
  assert.equal(f.state.get(entry.value.machineModalModeAtom), "add");
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
  assert.deepEqual(f.state.get(entry.value.stateAtom), {
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
  assert.equal(f.state.get(entry.value.daemonInstanceIdAtom), "current");
  const old = transport();
  pending.resolve(old);
  await flush();
  await old.closed;
  assert.equal(f.state.get(entry.value.daemonInstanceIdAtom), "current");
  assert.equal(f.state.get(entry.value.connectionAtom).phase, "reachable");
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
    f.state.set(entry.value.pairingCodeAtom, "1234");
    const complete = entry.value.pairSelected();
    if (dispose) stop();
    else f.store.get(machineStoreBunja, f.read).value.selectMachine("b");
    f.state.set(entry.value.machineFormErrorAtom, "new form");
    pending.reject(new Error("late pairing failure"));
    await complete;
    assert.equal(f.state.get(entry.value.machineFormErrorAtom), "new form");
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
  const before = f.state.get(entry.value.stateAtom);
  pending.reject(new Error("late transport failure"));
  await flush();
  assert.equal(f.state.get(entry.value.stateAtom), before);
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
  assert.equal(f.state.get(entry.value.daemonInfoAtom).phase, "idle");
  assert.equal(f.state.get(entry.value.connectionAtom).phase, "offline");
});
