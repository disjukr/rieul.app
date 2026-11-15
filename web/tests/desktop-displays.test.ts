import { test, mock } from "node:test";
import assert from "node:assert/strict";
import { createBunjaStore, createReadScopeFn, override } from "bunja";
import { createRoot, createSignal, flush as flushSolid } from "solid-js";
import * as client from "../src/protocol/generated/client.ts";
import { ProcId, type DesktopDisplay } from "../src/protocol/generated/rpc.ts";
import type { DaemonInfoState } from "../src/state/rpc-session.ts";
import { MachineIdScope } from "../src/state/machine-scopes.ts";
import { rpcSessionStub } from "./helpers/rpc-session.ts";
let query: () => Promise<DesktopDisplay[]>;
mock.module("../src/protocol/generated/client.ts", {
  namedExports: {
    ...client,
    listDisplays: async () => ({ displays: await query() }),
  },
});
const { rpcSessionBunja } = await import("../src/state/rpc-session.ts");
const { desktopDisplaysBunja } = await import(
  "../src/state/desktop-displays.ts"
);
const displays = (ids: string[]) =>
  ids.map((displayId) => ({
    displayId,
    bounds: { x: 0, y: 0, width: 1280, height: 720 },
    scale: 1,
    dpi: 96,
  }));
const ready = (id: string, supported = true): DaemonInfoState => ({
  phase: "ready",
  receivedAtMs: 0,
  daemonInfo: {
    instanceId: id,
    version: "fixture",
    os: "macos",
    startedAtMs: 0,
    serverTimeMs: 0,
    supportedProcIds: supported
      ? [ProcId.ListDisplays]
      : [ProcId.GetDesktopCapabilities, ProcId.AttachDesktop],
  },
});
async function flush() {
  for (let i = 0; i < 20; i++) {
    flushSolid();
    await Promise.resolve();
  }
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
function fixture(initial = ready("first")) {
  let opens = 0;
  const [info, setInfo] = createSignal(initial);
  const store = createBunjaStore({
    wrapInstance: (init) => createRoot(init),
    overrides: [
      override(rpcSessionBunja, () =>
        rpcSessionStub({
          daemonInfo: info,
          webTransport: async () => {
            opens++;
            return {} as WebTransport;
          },
        }),
      ),
    ],
  });
  const get = (id: string) =>
    store.get(
      desktopDisplaysBunja,
      createReadScopeFn([[MachineIdScope, id]], () => undefined as never),
    );
  const entry = get("A");
  const stop = entry.mount();
  return {
    value: entry.value,
    setInfo,
    opens: () => opens,
    get,
    close() {
      stop();
      store.dispose();
    },
  };
}

test("cold inventory is one lightweight authenticated query, with explicit refresh deduplication", async () => {
  let calls = 0;
  query = async () => {
    calls++;
    return displays(["first", "second"]);
  };
  const f = fixture();
  try {
    await flush();
    assert.equal(f.opens(), 1);
    assert.equal(calls, 1);
    assert.deepEqual(
      f.value.displays().map((d) => d.displayId),
      ["first", "second"],
    );
    await flush();
    assert.equal(calls, 1, "mount must not poll or start media sessions");
    const pending = deferred<DesktopDisplay[]>();
    query = async () => {
      calls++;
      return pending.promise;
    };
    const a = f.value.refresh(),
      b = f.value.refresh();
    assert.equal(a, b);
    await flush();
    assert.equal(calls, 2);
    pending.resolve(displays(["second"]));
    await a;
    await flush();
    assert.deepEqual(
      f.value.displays().map((d) => d.displayId),
      ["second"],
    );
  } finally {
    f.close();
  }
});

test("legacy and unavailable daemons never query or attach; only live scoped Screen metadata is used", async () => {
  query = async () => {
    throw new Error("unexpected query");
  };
  const f = fixture(ready("old", false));
  try {
    await flush();
    assert.equal(f.opens(), 0);
    assert.deepEqual(f.value.displays(), []);
    const source = Symbol();
    f.value.publish(source, displays(["first", "second"]));
    await flush();
    assert.equal(f.value.displays().length, 2);
    f.value.clear(source);
    await flush();
    assert.deepEqual(f.value.displays(), []);
    f.value.publish(source, displays(["first", "second"]));
    await flush();
    f.setInfo({ phase: "loading" });
    await flush();
    assert.deepEqual(f.value.displays(), []);
    f.setInfo(ready("replacement", false));
    await flush();
    assert.deepEqual(f.value.displays(), []);
    assert.equal(f.opens(), 0);
  } finally {
    f.close();
  }
});

test("late queries cannot reveal another daemon's displays or update after disposal", async () => {
  const first = deferred<DesktopDisplay[]>(),
    second = deferred<DesktopDisplay[]>();
  let calls = 0;
  query = () => (++calls === 1 ? first.promise : second.promise);
  const f = fixture();
  await flush();
  f.setInfo(ready("second"));
  await flush();
  first.resolve(displays(["wrong-host"]));
  await flush();
  assert.deepEqual(f.value.displays(), []);
  second.resolve(displays(["correct-host"]));
  await flush();
  assert.equal(f.value.displays()[0].displayId, "correct-host");
  const late = deferred<DesktopDisplay[]>();
  query = () => late.promise;
  void f.value.refresh();
  await flush();
  f.close();
  late.resolve(displays(["after-dispose"]));
  await flush();
  assert.deepEqual(
    f.value.displays().map((d) => d.displayId),
    ["correct-host"],
    "disposed memo retains its last snapshot but must reject late updates",
  );
});

test("live layout updates win over in-flight inventory and cannot fall back to stale query data", async () => {
  query = async () => displays(["removed", "current"]);
  const f = fixture();
  try {
    await flush();
    const pending = deferred<DesktopDisplay[]>();
    query = () => pending.promise;
    void f.value.refresh();
    await flush();
    const source = Symbol();
    f.value.publish(source, displays(["current"]));
    await flush();
    pending.resolve(displays(["removed", "current"]));
    await flush();
    assert.deepEqual(
      f.value.displays().map((d) => d.displayId),
      ["current"],
    );
    f.value.clear(source);
    await flush();
    assert.deepEqual(f.value.displays(), []);
  } finally {
    f.close();
  }
});

test("query failures hide old cold inventory without retries and never erase live updates", async () => {
  query = async () => displays(["first", "second"]);
  const f = fixture();
  try {
    await flush();
    let calls = 0;
    query = async () => {
      calls++;
      throw new Error("offline");
    };
    await f.value.refresh();
    await flush();
    assert.deepEqual(f.value.displays(), []);
    await flush();
    assert.equal(calls, 1);
    const source = Symbol();
    f.value.publish(source, displays(["live"]));
    await flush();
    await f.value.refresh();
    await flush();
    assert.equal(f.value.displays()[0].displayId, "live");
  } finally {
    f.close();
  }
});

test("metadata is isolated by machine scope", async () => {
  query = async () => displays(["query"]);
  const f = fixture(ready("legacy", false));
  try {
    const b = f.get("B");
    b.mount();
    await flush();
    f.value.publish(Symbol(), displays(["A-only"]));
    await flush();
    assert.equal(f.value.displays()[0].displayId, "A-only");
    assert.deepEqual(b.value.displays(), []);
  } finally {
    f.close();
  }
});

test("inventory effects use their tracked daemon snapshot without strict read diagnostics", async (t) => {
  const diagnostics: string[] = [];
  const warn = console.warn.bind(console);
  t.mock.method(console, "warn", (...args: unknown[]) => {
    const message = args.map(String).join(" ");
    if (message.includes("[STRICT_READ_UNTRACKED]")) diagnostics.push(message);
    warn(...args);
  });
  query = async () => displays(["first", "second"]);
  const f = fixture();
  try {
    await flush();
    f.setInfo(ready("replacement"));
    await flush();
    await f.value.refresh();
    await flush();
    assert.deepEqual(diagnostics, []);
  } finally {
    f.close();
  }
});
