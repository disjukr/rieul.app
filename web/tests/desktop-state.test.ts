import { test, mock } from "node:test";
import assert from "node:assert/strict";
import { createBunjaStore, createReadScopeFn, override } from "bunja";
import { createRoot, createSignal, flush as flushSolid } from "solid-js";
import * as client from "../src/protocol/generated/client.ts";
import {
  DesktopAvailability,
  ProcId,
  type DesktopCapabilities,
} from "../src/protocol/generated/rpc.ts";
import { rpcSessionStub } from "./helpers/rpc-session.ts";
let capabilities: typeof client.getDesktopCapabilities;
mock.module("../src/protocol/generated/client.ts", {
  namedExports: {
    ...client,
    getDesktopCapabilities: (...args: Parameters<typeof capabilities>) =>
      capabilities(...args),
  },
});
const { rpcSessionBunja } = await import("../src/state/rpc-session.ts");
const { desktopBunja } = await import("../src/state/desktop.ts");
const ready = (instanceId: string) => ({
  phase: "ready" as const,
  receivedAtMs: 0,
  daemonInfo: {
    instanceId,
    version: "1",
    os: "macos",
    startedAtMs: 0,
    serverTimeMs: 0,
    supportedProcIds: [ProcId.GetDesktopCapabilities, ProcId.AttachDesktop],
  },
});
async function flush() {
  for (let i = 0; i < 30; i++) {
    flushSolid();
    await Promise.resolve();
  }
}
function fixture() {
  let opens = 0;
  const [info, setInfo] = createSignal(ready("first"));
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
  const entry = store.get(
    desktopBunja,
    createReadScopeFn([], () => undefined as never),
  );
  const stop = entry.mount();
  return {
    value: entry.value,
    setInfo,
    opens: () => opens,
    close() {
      stop();
      store.dispose();
    },
  };
}
test("desktop requires explicit connect and reports unsupported without opening media or acquiring control", async () => {
  let calls = 0;
  capabilities = async () => {
    calls++;
    return {
      profile: 1,
      composition: false,
      relativePointer: false,
      maxViewports: 8,
      maxInputFrameBytes: 16384,
      maxInputStreamBytes: 8388608,
      capture: DesktopAvailability.Unsupported,
      input: DesktopAvailability.Unsupported,
      codecs: [],
      reason: "Native capture is unavailable",
    } as DesktopCapabilities;
  };
  const f = fixture();
  try {
    await flush();
    assert.equal(f.opens(), 0);
    assert.equal(f.value.controlling(), false);
    await f.value.connect();
    assert.equal(calls, 1);
    assert.equal(f.value.phase(), "unsupported");
    assert.equal(f.value.message(), "Native capture is unavailable");
    f.value.disconnect();
    await flush();
    assert.equal(f.value.message(), undefined);
    assert.equal(f.opens(), 1);
  } finally {
    f.close();
  }
});
test("replacement and unmount discard pending capability responses without reconnecting", async () => {
  const pending = Promise.withResolvers<DesktopCapabilities>();
  capabilities = () => pending.promise;
  const f = fixture();
  await flush();
  const connecting = f.value.connect();
  await flush();
  f.setInfo(ready("replacement"));
  await flush();
  pending.resolve({
    capture: DesktopAvailability.Unsupported,
    reason: "old daemon",
  } as DesktopCapabilities);
  await connecting;
  assert.equal(f.value.phase(), "idle");
  assert.equal(f.value.message(), undefined);
  assert.equal(f.opens(), 1);
  f.close();
});

test("available capture without a browser codec stays disconnected", async () => {
  capabilities = async () => ({
    profile: 1,
    capture: DesktopAvailability.Available,
    input: DesktopAvailability.Available,
    codecs: [{ codec: "fixture", hardware: true }],
    composition: false,
    relativePointer: false,
    maxViewports: 8,
    maxInputFrameBytes: 16384,
    maxInputStreamBytes: 8388608,
  });
  const f = fixture();
  try {
    await flush();
    await f.value.connect();
    await flush();
    assert.equal(f.value.phase(), "unsupported");
    assert.match(f.value.message()!, /no supported video codec/);
    assert.equal(f.value.controlling(), false);
  } finally {
    f.close();
  }
});

test("disconnect cancels capability negotiation and permits a fresh explicit retry", async () => {
  const pending = Promise.withResolvers<DesktopCapabilities>();
  capabilities = () => pending.promise;
  const f = fixture();
  try {
    await flush();
    const connecting = f.value.connect();
    await flush();
    assert.equal(f.value.phase(), "connecting");
    f.value.disconnect();
    pending.resolve({
      capture: DesktopAvailability.Unsupported,
      reason: "stale",
    } as DesktopCapabilities);
    await connecting;
    assert.equal(f.value.phase(), "idle");
    assert.equal(f.value.message(), undefined);
    capabilities = async () =>
      ({
        capture: DesktopAvailability.PermissionRequired,
        reason: "Allow screen recording in OS settings",
        maxViewports: 1,
      }) as DesktopCapabilities;
    await f.value.connect();
    assert.equal(f.value.phase(), "unsupported");
    assert.match(f.value.message()!, /screen recording/);
    assert.equal(f.value.maxViewports(), 1);
    assert.equal(f.value.controlling(), false);
  } finally {
    f.close();
  }
});

test("custom-only discovery cannot silently open existing displays", async () => {
  const f = fixture();
  try {
    f.setInfo({
      ...ready("custom-only"),
      daemonInfo: {
        ...ready("custom-only").daemonInfo,
        supportedProcIds: [
          ProcId.GetDesktopLayoutCapabilities,
          ProcId.AttachDesktopWithLayout,
        ],
      },
    });
    await flush();
    assert.deepEqual(f.value.modes(), { existing: false, custom: true });
    await f.value.connect();
    assert.equal(f.opens(), 0);
    assert.equal(f.value.phase(), "idle");
  } finally {
    f.close();
  }
});
