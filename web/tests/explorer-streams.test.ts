import type { StreamState } from "../src/state/types.ts";
import { after, test, mock } from "node:test";
import assert from "node:assert/strict";
import { bunja, createBunjaStore, createReadScopeFn, override } from "bunja";
import { createStore, type Atom } from "jotai/vanilla";
import { JotaiStoreScope } from "../src/state/jotai-store.ts";
import * as client from "../src/protocol/generated/client.ts";
import { rpcSessionStub } from "./helpers/rpc-session.ts";
let subscribe: (
  transport: WebTransport,
  path?: string,
) => AsyncGenerator<RootsTableEvent | DirectoryTableEvent>;
mock.module("../src/protocol/generated/client.ts", {
  namedExports: {
    ...client,
    subscribeRoots: (transport: WebTransport) => subscribe(transport),
    subscribeDirectory: (transport: WebTransport, request: { path: string }) =>
      subscribe(transport, request.path),
  },
});
const {
  explorerRootsBunja: roots,
  explorerDirectoryBunja: directory,
  explorerNavigationBunja,
  explorerRefreshBunja,
} = await import("../src/state/explorer.ts");
const { rpcSessionBunja } = await import("../src/state/rpc-session.ts");
import { machineStoreBunja } from "../src/state/machine-store.ts";
import { MachineStorageScope } from "../src/state/machine-storage.ts";
import { MachineIdScope } from "../src/state/machine-scopes.ts";
import { WorkbenchTabIdScope } from "../src/state/workbench-scopes.ts";
import { RpcError } from "../src/protocol/client.ts";
import type {
  DirectoryTableEvent,
  FsEntry,
  RootsTableEvent,
} from "../src/protocol/generated/rpc.ts";
const originalWindow = Object.getOwnPropertyDescriptor(globalThis, "window");
after(() => {
  if (originalWindow)
    Object.defineProperty(globalThis, "window", originalWindow);
  else Reflect.deleteProperty(globalThis, "window");
});
async function flush() {
  for (let i = 0; i < 24; i++) await Promise.resolve();
}
function stream<T>() {
  let pending = Promise.withResolvers<IteratorResult<T>>();
  let returns = 0;
  const iterator: AsyncGenerator<T> = {
    next: () => pending.promise,
    return: () => {
      returns++;
      pending.resolve({ done: true, value: undefined });
      return Promise.resolve({ done: true, value: undefined });
    },
    throw: (error: unknown) => Promise.reject(error),
    [Symbol.asyncIterator]() {
      return this;
    },
    [Symbol.asyncDispose]() {
      return Promise.resolve();
    },
  };
  return {
    iterator,
    returns: () => returns,
    send(value: T) {
      const previous = pending;
      pending = Promise.withResolvers();
      previous.resolve({ done: false, value });
    },
    fail(error: unknown) {
      pending.reject(error);
    },
  };
}
const entry = (name: string): FsEntry => ({
  name,
  path: `/${name}`,
  kind: 1,
  readonly: false,
});
function fixture(kind: "roots" | "directory") {
  const state = createStore();
  const machines = ["a", "b"].map((id) => ({
    id,
    name: id,
    baseUrl: `https://${id}.invalid:9012`,
    clientId: id,
    clientSecret: "fixture",
  }));
  const persistence = new Map([
    ["rieul.machines.v1", JSON.stringify(machines)],
    ["rieul.selected-machine-id.v1", "a"],
  ]);
  const storage = {
    getItem: (key: string) => persistence.get(key) ?? null,
    setItem: (key: string, value: string) => {
      persistence.set(key, value);
    },
    removeItem: (key: string) => {
      persistence.delete(key);
    },
  };
  // Only this Node test worker gets a browser-storage fixture; nothing reaches disk.
  Object.defineProperty(globalThis, "window", {
    configurable: true,
    value: { localStorage: storage },
  });
  const read = (machine = "a", tab = "one") =>
    createReadScopeFn(
      [
        [JotaiStoreScope, state],
        [MachineStorageScope, storage],
        [MachineIdScope, machine],
        [WorkbenchTabIdScope, tab],
      ],
      () => {
        throw new Error("unexpected scope");
      },
    );
  const channels: {
    machine: string;
    path?: string;
    stream: ReturnType<typeof stream<RootsTableEvent | DirectoryTableEvent>>;
  }[] = [];
  let deferredTransport:
    | ReturnType<typeof Promise.withResolvers<WebTransport>>
    | undefined;
  let requests = 0,
    invalidations = 0;
  const session = rpcSessionBunja;
  const store = createBunjaStore({
    overrides: [
      override(session, () => {
        const machine = bunja.use(MachineIdScope)!;
        let alive = false;
        bunja.effect(() => {
          alive = true;
          return () => {
            alive = false;
          };
        });
        return rpcSessionStub({
          webTransport: () => {
            requests++;
            assert(alive, "stream must not use an unmounted RPC dependency");
            const waiting = deferredTransport;
            deferredTransport = undefined;
            return (
              waiting?.promise ??
              Promise.resolve({ machine } as unknown as WebTransport)
            );
          },
          closeRpcSession: () => {
            assert(
              alive,
              "consumer cleanup cannot call the disposed dependency",
            );
            invalidations++;
          },
        });
      }),
    ],
  });
  subscribe = (transport: WebTransport, path?: string) => {
    const channel = {
      machine: (transport as unknown as { machine: string }).machine,
      path,
      stream: stream<RootsTableEvent | DirectoryTableEvent>(),
    };
    channels.push(channel);
    return channel.stream.iterator;
  };
  const views = new WeakMap<
    object,
    { rowsAtom: Atom<FsEntry[]>; stateAtom: Atom<StreamState> }
  >();
  const navigation = (machine = "a", tab = "one") =>
    store.get(explorerNavigationBunja, read(machine, tab)).value;
  const get = (machine = "a", tab = "one") => {
    if (kind === "directory")
      navigation(machine, tab).replaceWithPath("/first");
    const entry =
      kind === "roots"
        ? store.get(roots, read(machine, tab))
        : store.get(directory, read(machine, tab));
    let value = views.get(entry.value);
    if (!value) {
      value =
        "rootsAtom" in entry.value
          ? {
              rowsAtom: entry.value.rootsAtom,
              stateAtom: entry.value.rootsStateAtom,
            }
          : {
              rowsAtom: entry.value.directoryRowsAtom,
              stateAtom: entry.value.directoryStateAtom,
            };
      views.set(entry.value, value);
    }
    return { ...entry, value };
  };
  return {
    state,
    store,
    read,
    get,
    session,
    channels,
    navigation,
    refresh: (machine = "a", tab = "one") =>
      store.get(explorerRefreshBunja, read(machine, tab)).value.refresh(),
    machines: () => store.get(machineStoreBunja, read()).value,
    requests: () => requests,
    invalidations: () => invalidations,
    delayNextTransport() {
      deferredTransport = Promise.withResolvers<WebTransport>();
      return deferredTransport;
    },
  };
}

for (const kind of ["roots", "directory"] as const) {
  test(`${kind}: row observation waits for its Bunja owner and final owner cleanup stops a retained observer`, async () => {
    const f = fixture(kind),
      first = f.get();
    const stopRows = f.state.sub(first.value.rowsAtom, () => {});
    await flush();
    assert.equal(
      f.requests(),
      0,
      "observation before owner mount must stay lazy",
    );
    const stopFirst = first.mount();
    const second = f.get();
    const stopSecond = second.mount();
    const stopOtherRows = f.state.sub(second.value.rowsAtom, () => {});
    await flush();
    assert.equal(f.requests(), 1);
    assert.equal(first.value, second.value);
    f.channels[0].stream.send({ type: "snapshot", rows: [entry("visible")] });
    await flush();
    assert.equal(f.state.get(first.value.rowsAtom)[0].name, "visible");
    stopFirst();
    stopRows();
    assert.equal(
      f.channels[0].stream.returns(),
      0,
      "partial owner/observer cleanup must retain the stream",
    );
    const refreshOld = f.store.get(explorerRefreshBunja, f.read()).value
      .refresh;
    stopSecond();
    assert.equal(
      f.channels[0].stream.returns(),
      1,
      "final Bunja cleanup must stop the stream even while rows remain observed",
    );
    const calls = f.requests();
    refreshOld();
    await flush();
    assert.equal(
      f.requests(),
      calls,
      "disposed owner must detach key listeners",
    );
    stopOtherRows();
    const oldObserver = f.state.sub(first.value.rowsAtom, () => {});
    await flush();
    assert.equal(
      f.requests(),
      calls,
      "old atoms must not resurrect disposed dependencies",
    );
    oldObserver();
    const fresh = f.get();
    const stopFresh = fresh.mount();
    const freshRows = f.state.sub(fresh.value.rowsAtom, () => {});
    await flush();
    assert.notEqual(fresh.value, first.value);
    assert.equal(f.requests(), calls + 1);
    freshRows();
    stopFresh();
    f.store.dispose();
  });
  test(`${kind}: last row observer stops the stream, re-observation restarts it, and old asynchronous work is ignored`, async () => {
    const f = fixture(kind),
      owner = f.get(),
      stop = owner.mount();
    await flush();
    assert.equal(f.requests(), 0, "mount alone must not subscribe");
    const waiting = f.delayNextTransport();
    const off = f.state.sub(owner.value.rowsAtom, () => {});
    f.refresh();
    await flush();
    assert.equal(
      f.channels.length,
      1,
      "replacement request can subscribe without waiting for old transport",
    );
    waiting.resolve({ machine: "a" } as unknown as WebTransport);
    await flush();
    assert.equal(
      f.channels.length,
      1,
      "cancelled transport cannot open a stream",
    );
    f.channels[0].stream.send({
      type: "snapshot",
      rows: [entry("old queued event")],
    });
    f.refresh();
    await flush();
    assert.deepEqual(
      f.state.get(owner.value.rowsAtom),
      [],
      "queued old events must not populate the next subscription",
    );
    const latest = f.channels.at(-1)!;
    latest.stream.send({ type: "snapshot", rows: [entry("new")] });
    await flush();
    assert.equal(f.state.get(owner.value.rowsAtom)[0].name, "new");
    off();
    assert.equal(latest.stream.returns(), 1);
    const calls = f.requests();
    f.refresh();
    await flush();
    assert.equal(f.requests(), calls, "unobserved refresh must not subscribe");
    const again = f.state.sub(owner.value.rowsAtom, () => {});
    await flush();
    assert.equal(f.requests(), calls + 1);
    assert.deepEqual(
      f.state.get(owner.value.rowsAtom).map((row) => row.name),
      kind === "roots" ? ["new"] : [],
      "keep roots cache and directory reload semantics",
    );
    stop();
    assert.equal(
      f.channels.at(-1)!.stream.returns(),
      1,
      "Bunja disposal must stop a still-observed stream",
    );
    again();
    f.store.dispose();
  });
  test(`${kind}: machine and tab scopes isolate streams and refresh while global selection changes`, async () => {
    const f = fixture(kind);
    const a = f.get("a", "one"),
      otherTab = f.get("a", "two"),
      b = f.get("b", "one");
    const stops = [a.mount(), otherTab.mount(), b.mount()];
    const rows = [a, otherTab, b].map((owner) =>
      f.state.sub(owner.value.rowsAtom, () => {}),
    );
    await flush();
    assert.equal(f.channels.length, 3);
    assert.notEqual(a.value, otherTab.value);
    assert.notEqual(a.value, b.value);
    f.channels.forEach((channel, index) =>
      channel.stream.send({ type: "snapshot", rows: [entry(String(index))] }),
    );
    await flush();
    assert.equal(f.state.get(a.value.rowsAtom)[0].name, "0");
    assert.equal(f.state.get(otherTab.value.rowsAtom)[0].name, "1");
    assert.equal(f.state.get(b.value.rowsAtom)[0].name, "2");
    f.machines().selectMachine("b");
    await flush();
    assert.equal(
      f.channels.length,
      3,
      "selection must not change another scoped observer",
    );
    f.refresh("a", "one");
    await flush();
    assert.equal(f.channels.length, 4);
    assert.equal(f.channels[0].stream.returns(), 1);
    assert.equal(f.channels[1].stream.returns(), 0);
    assert.equal(f.channels[2].stream.returns(), 0);
    f.machines().setMachineCredentials("a", {
      clientId: "a",
      clientSecret: "replacement",
      clientCredentialExpiresAtUnix: 100,
    });
    await flush();
    assert.equal(
      f.channels.length,
      6,
      "credential replacement restarts both tabs of its machine",
    );
    assert.equal(f.channels[1].stream.returns(), 1);
    assert.equal(f.channels[3].stream.returns(), 1);
    assert.equal(
      f.channels[2].stream.returns(),
      0,
      "the other machine must remain subscribed",
    );
    rows.forEach((off) => off());
    stops.forEach((off) => off());
    f.store.dispose();
  });
}

test("directory navigation replaces only its stream and ignores an old moved event", async () => {
  const f = fixture("directory"),
    owner = f.get(),
    stop = owner.mount();
  const off = f.state.sub(owner.value.rowsAtom, () => {});
  await flush();
  const navigation = f.navigation();
  f.channels[0].stream.send({
    type: "closed",
    reason: { type: "moved", to: "/stale" },
  });
  navigation.navigate("/second");
  await flush();
  assert.equal(f.state.get(navigation.directoryPathAtom), "/second");
  assert.equal(f.channels.at(-1)!.path, "/second");
  f.channels
    .at(-1)!
    .stream.send({ type: "closed", reason: { type: "moved", to: "/renamed" } });
  await flush();
  assert.equal(f.state.get(navigation.directoryPathAtom), "/renamed");
  assert.deepEqual(f.state.get(navigation.historyAtom), []);
  f.channels
    .at(-1)!
    .stream.send({ type: "snapshot", rows: [entry("renamed child")] });
  await flush();
  assert.equal(f.state.get(owner.value.stateAtom).phase, "live");
  off();
  stop();
  f.store.dispose();
});
test("active invalid credentials still clear pairing while cancelled errors cannot touch dependencies", async () => {
  for (const kind of ["roots", "directory"] as const) {
    const f = fixture(kind),
      owner = f.get(),
      stop = owner.mount();
    const off = f.state.sub(owner.value.rowsAtom, () => {});
    await flush();
    f.channels[0].stream.fail(new RpcError("invalidCredentials", "old"));
    f.refresh();
    await flush();
    assert.equal(f.invalidations(), 0);
    assert.equal(f.machines().findMachine("a")!.clientSecret, "fixture");
    f.channels
      .at(-1)!
      .stream.fail(new RpcError("invalidCredentials", "current"));
    await flush();
    assert.equal(f.invalidations(), 1);
    assert.equal(f.machines().findMachine("a")!.clientSecret, undefined);
    assert.deepEqual(f.state.get(owner.value.stateAtom), {
      phase: "error",
      message: "Pairing is no longer valid. Pair this machine again.",
    });
    off();
    stop();
    f.store.dispose();
  }
});

test("pending transports cannot open streams after owner disposal with rows retained", async () => {
  for (const kind of ["roots", "directory"] as const) {
    const f = fixture(kind),
      owner = f.get(),
      waiting = f.delayNextTransport();
    const stop = owner.mount();
    const off = f.state.sub(owner.value.rowsAtom, () => {});
    await flush();
    assert.equal(f.requests(), 1);
    assert.equal(f.channels.length, 0);
    stop();
    waiting.resolve({ machine: "a" } as unknown as WebTransport);
    await flush();
    assert.equal(
      f.channels.length,
      0,
      "the dependency may resolve after its owner has gone",
    );
    off();
    f.store.dispose();
  }
});
