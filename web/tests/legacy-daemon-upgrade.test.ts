import { test, mock } from "node:test";
import assert from "node:assert/strict";
import { createBunjaStore, createReadScopeFn, override } from "bunja";
import { createRoot, createSignal, flush as flushSolid } from "solid-js";
import * as adapter from "../src/protocol/legacy-upgrade.ts";
import { UpdatePhase, type DaemonInfo } from "../src/protocol/generated/rpc.ts";
import { rpcSessionStub } from "./helpers/rpc-session.ts";
let call: typeof adapter.legacyUpgrade;
mock.module("../src/protocol/legacy-upgrade.ts", {
  namedExports: {
    ...adapter,
    legacyUpgrade: (...args: Parameters<typeof call>) => call(...args),
  },
});
const { rpcSessionBunja } = await import("../src/state/rpc-session.ts");
const { legacyDaemonUpgradeBunja } = await import(
  "../src/state/legacy-daemon-upgrade.ts"
);
const info = (version = "0.1.0", ids = [64, 65]) => ({
  phase: "ready" as const,
  receivedAtMs: 0,
  daemonInfo: {
    instanceId: version,
    version,
    os: "macOS Tahoe 26.6.2 64bit",
    startedAtMs: 0,
    serverTimeMs: 0,
    supportedProcIds: ids,
  } satisfies DaemonInfo,
});
const ready: adapter.LegacyUpdateStatus = {
  phase: UpdatePhase.Ready,
  currentVersion: "0.6.16",
  targetVersion: "0.6.20",
  canInstall: true,
};
async function flush() {
  for (let i = 0; i < 30; i++) {
    flushSolid();
    await Promise.resolve();
  }
  flushSolid();
}
function fixture(transport = async () => ({}) as WebTransport) {
  const [daemonInfo, setInfo] =
    createSignal<
      ReturnType<typeof rpcSessionStub>["daemonInfo"] extends () => infer V
        ? V
        : never
    >(info());
  let reconnects = 0;
  const store = createBunjaStore({
    wrapInstance: (init) => createRoot(init),
    overrides: [
      override(rpcSessionBunja, () =>
        rpcSessionStub({
          daemonInfo,
          webTransport: transport,
          reconnect: () => {
            reconnects++;
          },
        }),
      ),
    ],
  });
  const entry = store.get(
    legacyDaemonUpgradeBunja,
    createReadScopeFn([], () => undefined as never),
  );
  const stop = entry.mount();
  return {
    value: entry.value,
    setInfo,
    reconnects: () => reconnects,
    close() {
      stop();
      store.dispose();
    },
  };
}
test("legacy is click-only, requires confirmed installed version, and never auto-installs", async () => {
  const calls: string[] = [];
  call = async (_, action) => {
    calls.push(action);
    return ready;
  };
  const f = fixture();
  try {
    await flush();
    assert.equal(f.value.supported(), true);
    assert.deepEqual(calls, []);
    await f.value.check();
    assert.deepEqual(calls, []);
    await f.value.readStatus();
    await flush();
    assert.equal(f.value.verified(), true);
    await f.value.check();
    await flush();
    assert.deepEqual(calls, ["status", "check"]);
    await f.value.installConfirmed("stale");
    assert.equal(calls.length, 2);
    await f.value.installConfirmed(f.value.confirmationToken());
    assert.deepEqual(calls, ["status", "check", "install"]);
  } finally {
    f.close();
  }
});
test("new daemon reconnect retires legacy state and late response/confirmation", async () => {
  const pending = Promise.withResolvers<adapter.LegacyUpdateStatus>();
  let calls = 0;
  call = () => {
    calls++;
    return pending.promise;
  };
  const f = fixture();
  try {
    await flush();
    const read = f.value.readStatus();
    await flush();
    const old = f.value.confirmationToken();
    f.setInfo(info("0.6.20", [73, 74, 75]));
    await flush();
    pending.resolve(ready);
    await read;
    await flush();
    assert.equal(f.value.supported(), false);
    assert.equal(f.value.status(), undefined);
    assert.equal(f.value.busy(), false);
    await f.value.installConfirmed(old);
    assert.equal(calls, 1);
    f.setInfo(info());
    await flush();
    assert.equal(f.value.status(), undefined);
    assert.equal(f.value.verified(), false);
  } finally {
    f.close();
  }
});
test("identity changes while authentication awaits cannot send a legacy command", async () => {
  const transport = Promise.withResolvers<WebTransport>();
  let calls = 0;
  call = async () => {
    calls++;
    return ready;
  };
  const f = fixture(() => transport.promise);
  try {
    await flush();
    const read = f.value.readStatus();
    f.setInfo(info("0.6.20", [73, 74, 75]));
    transport.resolve({} as WebTransport);
    await read;
    await flush();
    assert.equal(calls, 0);
  } finally {
    f.close();
  }
});
test("unknown versions, failed identity and lost installation ack fail closed without retry", async () => {
  let calls = 0;
  call = async () => {
    calls++;
    return { ...ready, currentVersion: "0.7.0" };
  };
  const f = fixture();
  try {
    await flush();
    await f.value.readStatus();
    await flush();
    await f.value.check();
    assert.equal(calls, 1);
    assert.equal(f.value.verified(), false);
    call = async () => ready;
    await f.value.readStatus();
    await flush();
    call = async () => {
      calls++;
      throw Error("closed");
    };
    await f.value.installConfirmed(f.value.confirmationToken());
    await flush();
    assert.match(f.value.message()!, /may have accepted/);
    assert.equal(f.value.status(), undefined);
    assert.equal(f.value.busy(), false);
    const count = calls;
    await f.value.installConfirmed(f.value.confirmationToken());
    assert.equal(calls, count);
    f.setInfo({ phase: "error", message: "unreachable" });
    await flush();
    assert.equal(f.value.supported(), false);
    await f.value.readStatus();
    assert.equal(calls, count);
  } finally {
    f.close();
  }
});
