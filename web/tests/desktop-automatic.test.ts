import { test, mock } from "node:test";
import assert from "node:assert/strict";
import { createBunjaStore, createReadScopeFn, override } from "bunja";
import { createRoot, createSignal, flush as flushSolid } from "solid-js";
import * as client from "../src/protocol/generated/client.ts";
import {
  DesktopAvailability,
  DesktopControlAction,
  type DesktopInputSources,
  DesktopQualityVerification,
  type DesktopQualityPolicy,
  ProcId,
  type DesktopEvent,
  type DesktopConfiguration,
} from "../src/protocol/generated/rpc.ts";
import { rpcSessionStub } from "./helpers/rpc-session.ts";
let inputSourceQueries = 0,
  inputSourceSelections = 0;
let sourceQuery: () => Promise<DesktopInputSources> = async () => ({
  currentId: "english",
  sources: [
    { id: "english", name: "ABC" },
    { id: "korean", name: "두벌식" },
  ],
});
let sourceSelect: (id: string) => Promise<DesktopInputSources> = async (
  id,
) => ({ ...(await sourceQuery()), currentId: id });
let qualityQueries = 0,
  qualityChanges = 0;
let configureCalls = 0,
  controlCalls = 0;
let procedure: number | undefined;
let enqueue: (event: DesktopEvent | undefined) => void;
let abortSignal: AbortSignal;
const configured: DesktopConfiguration[] = [];
let renderFrame: (id: string, frame: VideoFrame) => boolean;
const refreshes: string[] = [];
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
    queryDesktopInputSources: async () => {
      inputSourceQueries++;
      return sourceQuery();
    },
    selectDesktopInputSource: async (_: unknown, req: { sourceId: string }) => {
      inputSourceSelections++;
      return sourceSelect(req.sourceId);
    },
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
    setDesktopControl: async (
      _: unknown,
      req: { action: DesktopControlAction },
    ) => {
      controlCalls++;
      return {
        inputEpoch: 1,
        holderAttachId:
          req.action === DesktopControlAction.Release ? undefined : "auto",
      };
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
      constructor(
        _transport: unknown,
        _attach: unknown,
        render: typeof renderFrame,
      ) {
        renderFrame = render;
      }
      prepareConfiguration() {}
      requestRefresh(id: string) {
        refreshes.push(id);
      }
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
    assert.equal(renderFrame("screen", {} as VideoFrame), false);
    let draws = 0,
      lost = false;
    const canvas = {
      isConnected: true,
      width: 640,
      height: 480,
      addEventListener() {},
      removeEventListener() {},
      getContext: () => null,
    } as unknown as HTMLCanvasElement;
    const unregister = entry.value.registerSurface("screen", canvas);
    assert.equal(refreshes.at(-1), "screen");
    assert.equal(renderFrame("screen", {} as VideoFrame), false);
    canvas.getContext = (() => ({
      isContextLost: () => lost,
      drawImage() {
        draws++;
      },
    })) as any;
    assert.equal(renderFrame("screen", {} as VideoFrame), true);
    assert.equal(draws, 1);
    lost = true;
    assert.equal(renderFrame("screen", {} as VideoFrame), false);
    unregister();
    assert.equal(renderFrame("screen", {} as VideoFrame), false);
    // The real popup lifecycle keeps the document/canvas on a quality-only change.
    let popupClosed = 0;
    const element = () => ({
      style: {},
      setAttribute() {},
      append() {},
      addEventListener() {},
      removeEventListener() {},
    });
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

function inputSourceFixture(supported = true) {
  const store = createBunjaStore({
    wrapInstance: (init) => createRoot(init),
    overrides: [
      override(rpcSessionBunja, () =>
        rpcSessionStub({
          daemonInfo: createSignal({
            phase: "ready" as const,
            receivedAtMs: 0,
            daemonInfo: {
              instanceId: "ime",
              version: "1",
              os: "macos",
              startedAtMs: 0,
              serverTimeMs: 0,
              supportedProcIds: [
                ProcId.GetDesktopCapabilities,
                ProcId.AttachDesktop,
                ProcId.AttachExistingDesktop,
                ...(supported
                  ? [
                      ProcId.QueryDesktopInputSources,
                      ProcId.SelectDesktopInputSource,
                    ]
                  : []),
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
  return {
    value: entry.value,
    close() {
      stop();
      store.dispose();
    },
  };
}
test("input source queries never acquire control; selection requires current owning pane", async () => {
  inputSourceQueries = inputSourceSelections = controlCalls = 0;
  const f = inputSourceFixture();
  const viewer = Symbol(),
    other = Symbol();
  const unregister = f.value.registerViewer(viewer);
  try {
    await flush();
    await f.value.connect();
    await flush();
    assert.equal(f.value.inputSources()?.currentId, "english");
    assert.ok(inputSourceQueries > 0);
    assert.equal(controlCalls, 0);
    await f.value.chooseInputSource("korean", viewer);
    assert.equal(inputSourceSelections, 0);
    await f.value.acquire(viewer);
    await flush();
    await f.value.chooseInputSource("korean", other);
    await f.value.chooseInputSource("unlisted", viewer);
    assert.equal(inputSourceSelections, 0);
    sourceSelect = async () => ({
      ...(await sourceQuery()),
      currentId: "korean",
    });
    // Query remains the source of truth if the host changed again after selection.
    await f.value.chooseInputSource("korean", viewer);
    await flush();
    assert.equal(inputSourceSelections, 1);
    assert.equal(f.value.inputSources()?.currentId, "english");
    // Native query is the source of truth after a failed selection too.
    sourceSelect = async () => {
      throw Error("selection denied");
    };
    await f.value.chooseInputSource("korean", viewer);
    await flush();
    assert.equal(inputSourceSelections, 2);
    assert.match(f.value.inputSourceMessage()!, /selection denied/);
    assert.equal(f.value.inputSources()?.currentId, "english");
    let resolve!: (value: DesktopInputSources) => void;
    sourceSelect = () =>
      new Promise((done) => {
        resolve = done;
      });
    const pending = f.value.chooseInputSource("korean", viewer);
    await f.value.release();
    await flush();
    resolve({ currentId: "korean", sources: [] });
    await pending;
    await flush();
    assert.notEqual(f.value.inputSources()?.currentId, "korean");
    assert.equal(f.value.inputSourceBusy(), false);
  } finally {
    unregister();
    f.close();
  }
});
test("old daemons do not receive input-source calls and detached responses are ignored", async () => {
  inputSourceQueries = inputSourceSelections = controlCalls = 0;
  let f = inputSourceFixture(false);
  try {
    await flush();
    await f.value.connect();
    await flush();
    await f.value.refreshInputSources();
    assert.equal(inputSourceQueries, 0);
    assert.equal(f.value.inputSources(), undefined);
  } finally {
    f.close();
  }
  let resolve!: (value: DesktopInputSources) => void;
  sourceQuery = () =>
    new Promise((done) => {
      resolve = done;
    });
  f = inputSourceFixture();
  try {
    await flush();
    await f.value.connect();
    await flush();
    f.value.disconnect();
    resolve({ currentId: "stale", sources: [] });
    await flush();
    assert.equal(f.value.inputSources(), undefined);
    assert.equal(controlCalls, 0);
  } finally {
    f.close();
  }
});
