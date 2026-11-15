import { test, mock } from "node:test";
import assert from "node:assert/strict";
import { createBunjaStore, createReadScopeFn, override } from "bunja";
import { createRoot, createSignal, flush as flushSolid } from "solid-js";
import * as client from "../src/protocol/generated/client.ts";
import {
  DesktopAvailability,
  DesktopControlAction,
  ProcId,
  type DesktopEvent,
  type ConfigureDesktopViewportsReq,
  type SelectExistingDesktopReq,
} from "../src/protocol/generated/rpc.ts";
import { WorkbenchTabIdScope } from "../src/state/workbench-scopes.ts";
import { rpcSessionStub } from "./helpers/rpc-session.ts";
import { RpcError } from "../src/protocol/client.ts";
const displays = ["first", "second"].map((displayId) => ({
  displayId,
  bounds: { x: 0, y: 0, width: 1280, height: 720 },
  scale: 1,
  dpi: 96,
}));
const configurations: ConfigureDesktopViewportsReq[] = [];
const selections: SelectExistingDesktopReq[] = [];
let queryCount = 0;
let capabilityError: Error | undefined;
let releaseError = false;
const controls: { attachId: string; action: DesktopControlAction }[] = [];
const detached: string[] = [];
const streams = new Map<
  string,
  { signal: AbortSignal; push: (event: DesktopEvent | undefined) => void }
>();
let sequence = 0,
  codecEpoch = 0;
mock.module("../src/protocol/generated/client.ts", {
  namedExports: {
    ...client,
    getDesktopCapabilities: async () => {
      if (capabilityError) throw capabilityError;
      return {
        profile: 1,
        capture: DesktopAvailability.Available,
        input: DesktopAvailability.Available,
        codecs: [{ codec: "fixture", hardware: false }],
        maxViewports: 8,
      };
    },
    configureDesktopViewports: async (
      _: unknown,
      request: ConfigureDesktopViewportsReq,
    ) => {
      configurations.push(request);
      const epoch = ++codecEpoch;
      return {
        layoutEpoch: request.layoutEpoch,
        totalBitrate: request.totalBitrate,
        tracks: request.viewports.map((viewport, index) => ({
          trackId: index + 1,
          codecEpoch: epoch,
          codec: { codec: "fixture", hardware: false },
          viewport,
        })),
      };
    },
    selectExistingDesktop: async (
      _: unknown,
      request: SelectExistingDesktopReq,
    ) => {
      selections.push(request);
      const selection = request.selection;
      const chosen =
        selection.type === "display"
          ? displays.find((d) => d.displayId === selection.displayId)
          : undefined;
      const epoch = ++codecEpoch;
      return {
        layoutEpoch: request.expectedLayoutEpoch,
        totalBitrate: 20_000_000,
        tracks: chosen
          ? [
              {
                trackId: 1,
                codecEpoch: epoch,
                codec: { codec: "fixture", hardware: false },
                viewport: {
                  viewportId: chosen.displayId,
                  displayId: chosen.displayId,
                  crop: chosen.bounds,
                  width: 1280,
                  height: 720,
                  fps: 60,
                  bitrate: 20_000_000,
                },
              },
            ]
          : [],
      };
    },
    queryDesktopQualitySupport: async () => {
      queryCount++;
      return {
        layoutEpoch: 1,
        revision: 1,
        automaticAvailable: true,
        concurrentThroughputVerified: true,
        candidates: [],
        policy: { type: "auto" },
      };
    },
    setDesktopControl: async (
      _: unknown,
      request: { attachId: string; action: DesktopControlAction },
    ) => {
      controls.push(request);
      if (releaseError && request.action === DesktopControlAction.Release)
        throw new Error("Release failed");
      return {
        inputEpoch: controls.length,
        holderAttachId:
          request.action === DesktopControlAction.Release
            ? undefined
            : request.attachId,
      };
    },
    detachDesktop: async (_: unknown, request: { attachId: string }) => {
      detached.push(request.attachId);
    },
    renewDesktopLease: async () => ({ remainingMs: 15000 }),
  },
});
mock.module("../src/protocol/desktop-session.ts", {
  namedExports: {
    desktopEvents: async function* (
      _transport: unknown,
      _request: unknown,
      signal: AbortSignal,
      proc: number,
    ) {
      assert.equal(proc, ProcId.AttachDesktop);
      const id = `catalog-${++sequence}`;
      const queue: (DesktopEvent | undefined)[] = [];
      let wake: (() => void) | undefined;
      const push = (event: DesktopEvent | undefined) => {
        queue.push(event);
        wake?.();
      };
      streams.set(id, { signal, push });
      signal.addEventListener("abort", () => push(undefined), { once: true });
      yield {
        type: "attached",
        attachId: id,
        layoutEpoch: 1,
        displays,
        control: { inputEpoch: 1 },
        leaseMs: 15000,
      } satisfies DesktopEvent;
      for (;;) {
        if (!queue.length)
          await new Promise<void>((resolve) => {
            wake = resolve;
          });
        const event = queue.shift();
        if (!event) return;
        yield event;
      }
    },
  },
});
mock.module("../src/protocol/desktop-input.ts", {
  namedExports: {
    DesktopInputChannel: class {
      abort() {}
      send() {
        return true;
      }
      async flush() {}
    },
    bindDesktopInput: () => () => {},
  },
});
mock.module("../src/protocol/desktop-video.ts", {
  namedExports: {
    supportedDesktopCodecs: async () => ["fixture"],
    DesktopVideoReceiver: class {
      requestRefresh() {}
      async configure() {}
      close() {}
    },
  },
});
const { rpcSessionBunja } = await import("../src/state/rpc-session.ts");
const { desktopBunja } = await import("../src/state/desktop.ts");
async function flush() {
  for (let i = 0; i < 80; i++) {
    flushSolid();
    await Promise.resolve();
  }
}
function fixture(scoped = false) {
  const store = createBunjaStore({
    wrapInstance: (init) => createRoot(init),
    overrides: [
      override(rpcSessionBunja, () =>
        rpcSessionStub({
          daemonInfo: createSignal({
            phase: "ready" as const,
            receivedAtMs: 0,
            daemonInfo: {
              instanceId: "catalog",
              version: "1",
              os: "macos",
              startedAtMs: 0,
              serverTimeMs: 0,
              supportedProcIds: [
                ...(scoped ? [ProcId.SelectExistingDesktop] : []),
                ProcId.GetDesktopCapabilities,
                ProcId.AttachDesktop,
                ProcId.ConfigureDesktopViewports,
                ProcId.AttachExistingDesktop,
                ProcId.QueryDesktopQualitySupport,
                ProcId.SetDesktopQuality,
              ],
            },
          })[0],
          webTransport: async () => ({}) as WebTransport,
        }),
      ),
    ],
  });
  const cleanups: (() => void)[] = [];
  return {
    tab(id: string) {
      const entry = store.get(
        desktopBunja,
        createReadScopeFn(
          [[WorkbenchTabIdScope, id]],
          () => undefined as never,
        ),
      );
      cleanups.push(entry.mount());
      return entry.value;
    },
    close() {
      for (const cleanup of cleanups) cleanup();
      store.dispose();
    },
  };
}
test("managed Screen discovers without media or control and selects only one display", async () => {
  configurations.length = controls.length = detached.length = 0;
  const f = fixture(),
    screen = f.tab("one");
  try {
    screen.start();
    await flush();
    assert.equal(screen.phase(), "viewing");
    assert.deepEqual(screen.displays(), displays);
    assert.equal(screen.configuration(), undefined);
    assert.equal(configurations.length, 0);
    assert.equal(controls.length, 0);
    assert.equal(screen.qualitySupported(), false);
    await screen.selectDisplay("second");
    assert.deepEqual(
      configurations.at(-1)?.viewports.map((v) => v.displayId),
      ["second"],
    );
    assert.equal(screen.selectedDisplayId(), "second");
    assert.equal(screen.controlling(), false);
    await screen.acquire();
    assert.equal(screen.controlling(), true);
    await screen.leaveDisplay();
    assert.equal(screen.selectedDisplayId(), undefined);
    assert.equal(controls.at(-1)?.action, DesktopControlAction.Release);
    assert.deepEqual(configurations.at(-1)?.viewports, []);
    assert.equal(screen.controlling(), false);
    assert.equal(detached.length, 0);
  } finally {
    f.close();
  }
});
test("separate tabs retain selection but never authority across hide and show", async () => {
  const f = fixture(),
    first = f.tab("first"),
    second = f.tab("second");
  try {
    first.start();
    second.start();
    await flush();
    assert.notEqual(first, second);
    assert.notEqual(first.attachId(), second.attachId());
    await first.selectDisplay("first");
    await second.selectDisplay("second");
    await first.acquire();
    const secondAttach = second.attachId(),
      firstAttach = first.attachId()!;
    first.stop();
    await flush();
    assert.equal(streams.get(firstAttach)?.signal.aborted, true);
    assert.equal(streams.get(secondAttach!)?.signal.aborted, false);
    assert.equal(second.attachId(), secondAttach);
    assert.equal(second.selectedDisplayId(), "second");
    assert.equal(first.selectedDisplayId(), "first");
    first.start();
    await flush();
    assert.equal(first.selectedDisplayId(), "first");
    assert.equal(first.controlling(), false);
    assert.notEqual(first.attachId(), firstAttach);
    assert.deepEqual(
      first.configuration()?.tracks.map((t) => t.viewport.displayId),
      ["first"],
    );
  } finally {
    f.close();
  }
});
test("removing selected display returns to catalog and never substitutes a different monitor", async () => {
  const f = fixture(),
    screen = f.tab("hotplug");
  try {
    screen.start();
    await flush();
    await screen.selectDisplay("second");
    await screen.acquire();
    streams
      .get(screen.attachId()!)!
      .push({ type: "layout", layoutEpoch: 2, displays: [displays[0]!] });
    await flush();
    assert.equal(screen.selectedDisplayId(), undefined);
    assert.equal(screen.controlling(), false);
    assert.deepEqual(screen.configuration()?.tracks, []);
    assert.match(screen.message()!, /disconnected/);
    assert.deepEqual(configurations.at(-1)?.viewports, []);
  } finally {
    f.close();
  }
});

test("additive scoped selection preserves daemon-owned geometry and automatic quality", async () => {
  selections.length = 0;
  const before = configurations.length;
  const f = fixture(true),
    screen = f.tab("scoped");
  try {
    screen.start();
    await flush();
    assert.equal(selections.length, 0);
    assert.equal(screen.qualitySupported(), true);
    assert.equal(screen.serverOwnsGeometry(), true);
    await screen.selectDisplay("second");
    assert.deepEqual(selections.at(-1)?.selection, {
      type: "display",
      displayId: "second",
    });
    assert.equal(configurations.length, before);
    await screen.queryQuality();
    assert.equal(queryCount, 1);
    assert.equal(screen.qualitySupport()?.automaticAvailable, true);
    const oldConfiguration = screen.configuration()!;
    await screen.leaveDisplay();
    streams
      .get(screen.attachId()!)!
      .push({ type: "configured", configuration: oldConfiguration });
    await flush();
    assert.deepEqual(selections.at(-1)?.selection, { type: "clear" });
    assert.equal(screen.selectedDisplayId(), undefined);
    assert.deepEqual(screen.configuration()?.tracks, []);
  } finally {
    f.close();
  }
});

test("transient retry preserves only the selected monitor, adds jitter and never restores control", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  t.mock.method(Math, "random", () => 0.75);
  const f = fixture(),
    screen = f.tab("retry");
  try {
    screen.start();
    await flush();
    await screen.selectDisplay("second");
    await screen.acquire();
    const firstAttach = screen.attachId()!,
      actions = controls.length;
    streams.get(firstAttach)!.push(undefined);
    await flush();
    assert.equal(screen.phase(), "error");
    assert.equal(screen.selectedDisplayId(), "second");
    assert.equal(screen.controlling(), false);
    t.mock.timers.tick(1099);
    await flush();
    assert.equal(screen.attachId(), undefined);
    t.mock.timers.tick(1);
    await flush();
    assert.notEqual(screen.attachId(), firstAttach);
    assert.equal(screen.selectedDisplayId(), "second");
    assert.deepEqual(
      screen.configuration()?.tracks.map((track) => track.viewport.displayId),
      ["second"],
    );
    assert.equal(screen.controlling(), false);
    assert.equal(controls.length, actions);
    const nextAttach = screen.attachId()!;
    streams.get(nextAttach)!.push(undefined);
    await flush();
    screen.stop();
    await flush();
    const attempts = sequence;
    t.mock.timers.tick(20_000);
    await flush();
    assert.equal(sequence, attempts);
  } finally {
    f.close();
  }
});
for (const code of [
  "permissionDenied",
  "unauthorized",
  "invalidCredentials",
] as const) {
  test(`${code} stops automatic recovery without opening another attachment`, async (t) => {
    t.mock.timers.enable({ apis: ["setTimeout"] });
    const f = fixture(),
      screen = f.tab(code),
      attempts = sequence;
    capabilityError = new RpcError(code, "User action is required");
    try {
      screen.start();
      await flush();
      assert.equal(screen.phase(), "error");
      assert.equal(screen.controlling(), false);
      t.mock.timers.tick(60_000);
      await flush();
      assert.equal(sequence, attempts);
      assert.match(screen.message()!, /User action/);
    } finally {
      capabilityError = undefined;
      f.close();
    }
  });
}

test("Back detaches instead of retaining authority when release acknowledgement fails", async () => {
  const f = fixture(),
    screen = f.tab("release-failure");
  try {
    screen.start();
    await flush();
    await screen.selectDisplay("first");
    await screen.acquire();
    const oldAttach = screen.attachId()!;
    releaseError = true;
    await screen.leaveDisplay();
    await flush();
    assert.equal(detached.includes(oldAttach), true);
    assert.equal(screen.selectedDisplayId(), undefined);
    assert.equal(screen.controlling(), false);
    assert.notEqual(screen.attachId(), oldAttach);
  } finally {
    releaseError = false;
    f.close();
  }
});
