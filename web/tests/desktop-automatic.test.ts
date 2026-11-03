import { test, mock } from "node:test";
import assert from "node:assert/strict";
import { createBunjaStore, createReadScopeFn, override } from "bunja";
import { createRoot, createSignal, flush as flushSolid } from "solid-js";
import * as client from "../src/protocol/generated/client.ts";
import {
  DesktopAvailability,
  DesktopQualityVerification,
  type DesktopQualityPolicy,
  ProcId,
  type DesktopEvent,
  type DesktopConfiguration,
} from "../src/protocol/generated/rpc.ts";
import { rpcSessionStub } from "./helpers/rpc-session.ts";
let qualityQueries = 0,
  qualityChanges = 0;
let configureCalls = 0,
  controlCalls = 0;
let procedure: number | undefined;
let enqueue: (event: DesktopEvent | undefined) => void;
let abortSignal: AbortSignal;
const configured: DesktopConfiguration[] = [];
const display = {
  displayId: "screen",
  bounds: { x: 0, y: 0, width: 1280, height: 720 },
  scale: 1,
  dpi: 96,
};
function config(epoch: number): DesktopConfiguration {
  return {
    layoutEpoch: epoch,
    totalBitrate: 1000,
    tracks: [
      {
        trackId: 1,
        codecEpoch: epoch,
        codec: { codec: "fixture", hardware: false },
        viewport: {
          viewportId: "screen",
          displayId: "screen",
          crop: { ...display.bounds },
          width: 1280,
          height: 720,
          fps: 60,
          bitrate: 1000,
        },
      },
    ],
  };
}
mock.module("../src/protocol/generated/client.ts", {
  namedExports: {
    ...client,
    queryDesktopQualitySupport: async () => {
      qualityQueries++;
      return {
        layoutEpoch: 1,
        revision: 1,
        automaticAvailable: true,
        concurrentThroughputVerified: false,
        policy: { type: "manual", target: { fps: 60, totalBitrate: 1000 } },
        candidates: [
          {
            target: { fps: 30, totalBitrate: 5_000_000 },
            tracks: config(1).tracks,
            verification: DesktopQualityVerification.Verified,
            reason: "fixture",
          },
        ],
      };
    },
    setDesktopQuality: async (
      _: unknown,
      request: { policy: DesktopQualityPolicy },
    ) => {
      qualityChanges++;
      const next = config(1);
      next.tracks[0]!.codecEpoch = 2;
      next.tracks[0]!.viewport.fps = 30;
      enqueue({ type: "configured", configuration: next });
      return next;
    },
    getDesktopCapabilities: async () => ({
      profile: 1,
      capture: DesktopAvailability.Available,
      input: DesktopAvailability.Available,
      codecs: [{ codec: "fixture", hardware: false }],
      maxViewports: 8,
    }),
    configureDesktopViewports: async () => {
      configureCalls++;
      throw Error("Must not configure existing OS displays");
    },
    setDesktopControl: async () => {
      controlCalls++;
      return { inputEpoch: 1 };
    },
    detachDesktop: async () => {},
    renewDesktopLease: async () => ({ remainingMs: 15000 }),
  },
});
mock.module("../src/solid/popup-styles.ts", {
  namedExports: { copyDocumentStyles: () => () => {} },
});
mock.module("../src/protocol/desktop-session.ts", {
  namedExports: {
    desktopEvents: async function* (
      _transport: unknown,
      _request: unknown,
      signal: AbortSignal,
      proc: number,
    ) {
      procedure = proc;
      abortSignal = signal;
      const queue: (DesktopEvent | undefined)[] = [];
      let wake: (() => void) | undefined;
      enqueue = (event) => {
        queue.push(event);
        wake?.();
      };
      signal.addEventListener("abort", () => enqueue(undefined), {
        once: true,
      });
      yield {
        type: "attached",
        attachId: "auto",
        layoutEpoch: 1,
        displays: [display],
        control: { inputEpoch: 1 },
        leaseMs: 15000,
      } satisfies DesktopEvent;
      yield {
        type: "configured",
        configuration: config(1),
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
      async configure(value: DesktopConfiguration) {
        configured.push(value);
      }
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
test("automatic existing displays consume server tracks and layout changes without configuration RPC", async () => {
  const store = createBunjaStore({
    wrapInstance: (init) => createRoot(init),
    overrides: [
      override(rpcSessionBunja, () =>
        rpcSessionStub({
          daemonInfo: createSignal({
            phase: "ready" as const,
            receivedAtMs: 0,
            daemonInfo: {
              instanceId: "auto",
              version: "1",
              os: "macos",
              startedAtMs: 0,
              serverTimeMs: 0,
              supportedProcIds: [
                ProcId.GetDesktopCapabilities,
                ProcId.AttachExistingDesktop,
                ProcId.QueryDesktopQualitySupport,
                ProcId.SetDesktopQuality,
                ProcId.AttachDesktop,
              ],
            },
          })[0],
          webTransport: async () => ({}) as WebTransport,
        }),
      ),
    ],
  });
  const entry = store.get(
    desktopBunja,
    createReadScopeFn([], () => undefined as never),
  );
  const stop = entry.mount();
  try {
    await flush();
    await entry.value.connect();
    await flush();
    assert.equal(procedure, ProcId.AttachExistingDesktop);
    assert.equal(entry.value.phase(), "viewing");
    assert.deepEqual(entry.value.configuration(), config(1));
    assert.equal(configureCalls, 0);
    assert.equal(controlCalls, 0);
    // The real popup lifecycle keeps the document/canvas on a quality-only change.
    let popupClosed = 0;
    const element = () => ({ style: {}, setAttribute() {}, append() {} });
    const popup = {
      document: { body: element(), createElement: element },
      close() {
        popupClosed++;
      },
      addEventListener() {},
    };
    const oldWindow = globalThis.window,
      oldDocument = globalThis.document;
    Object.assign(globalThis, { window: { open: () => popup }, document: {} });
    try {
      entry.value.openWindow("screen");
      await entry.value.applyQuality({ type: "auto" });
      assert.equal(qualityChanges, 0); // no mutation before support query
      await entry.value.queryQuality({ fps: 30, totalBitrate: 5_000_000 });
      assert.equal(qualityQueries, 1);
      await entry.value.applyQuality({
        type: "manual",
        target: { fps: 30, totalBitrate: 5_000_000 },
      });
      await flush();
      assert.equal(qualityChanges, 1);
      assert.equal(popupClosed, 0);
      assert.equal(entry.value.configuration()?.tracks[0]?.viewport.fps, 30);
      assert.equal(entry.value.qualitySupport(), undefined);
      enqueue({ type: "configured", configuration: config(1) }); // late old epoch
      await flush();
      assert.equal(entry.value.configuration()?.tracks[0]?.codecEpoch, 2);
      assert.equal(controlCalls, 0);
      assert.equal(configureCalls, 0);
      enqueue({ type: "layout", layoutEpoch: 2, displays: [] });
      enqueue({
        type: "configured",
        configuration: { layoutEpoch: 2, totalBitrate: 1000, tracks: [] },
      });
      await flush();
      assert.equal(popupClosed, 1);
    } finally {
      Object.assign(globalThis, { window: oldWindow, document: oldDocument });
    }
    enqueue({ type: "layout", layoutEpoch: 2, displays: [] });
    enqueue({
      type: "configured",
      configuration: { layoutEpoch: 2, totalBitrate: 1000, tracks: [] },
    });
    await flush();
    assert.deepEqual(entry.value.displays(), []);
    assert.deepEqual(entry.value.configuration()?.tracks, []);
    enqueue({ type: "layout", layoutEpoch: 3, displays: [display] });
    enqueue({ type: "configured", configuration: config(3) });
    enqueue({ type: "configured", configuration: config(1) });
    await flush();
    assert.equal(entry.value.configuration()?.layoutEpoch, 3);
    assert.equal(configured.at(-1)?.layoutEpoch, 3);
    await entry.value.configure(["screen"]);
    await entry.value.resize(720);
    assert.equal(configureCalls, 0);
    enqueue(undefined);
    await flush();
    assert.equal(entry.value.phase(), "error");
    assert.equal(entry.value.configuration(), undefined);
    assert.equal(abortSignal.aborted, true);
    assert.equal(controlCalls, 0);
  } finally {
    stop();
    store.dispose();
  }
});
