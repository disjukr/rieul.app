import { test, mock } from "node:test";
import assert from "node:assert/strict";
import { createBunjaStore, createReadScopeFn, override } from "bunja";
import { createRoot, createSignal, flush as flushSolid } from "solid-js";
import * as client from "../src/protocol/generated/client.ts";
import {
  DesktopAvailability,
  ProcId,
  type DesktopConfiguration,
  type AttachDesktopReq,
  type ConfigureDesktopViewportsReq,
} from "../src/protocol/generated/rpc.ts";
import { rpcSessionStub } from "./helpers/rpc-session.ts";
const av1 = "av01.0.13M.08",
  h264 = "avc1.42e02a";
let mode = "configure",
  next = 0,
  controlCalls = 0;
let offers: string[][] = [];
let selected = h264;
let configurations: ConfigureDesktopViewportsReq[] = [];
const display = {
  displayId: "d",
  bounds: { x: 0, y: 0, width: 1921, height: 1081 },
  scale: 1,
  dpi: 96,
};
mock.module("../src/protocol/generated/client.ts", {
  namedExports: {
    ...client,
    getDesktopCapabilities: async () => ({
      profile: 1,
      capture: DesktopAvailability.Available,
      input: DesktopAvailability.Available,
      codecs: [
        { codec: av1, hardware: true },
        { codec: h264, hardware: true },
      ],
      composition: false,
      relativePointer: false,
      maxViewports: 8,
      maxInputFrameBytes: 16384,
      maxInputStreamBytes: 8388608,
    }),
    configureDesktopViewports: async (
      _transport: unknown,
      request: ConfigureDesktopViewportsReq,
    ) => {
      configurations.push(request);
      return {
        layoutEpoch: 1,
        totalBitrate: 1000,
        tracks: [
          {
            trackId: 1,
            codecEpoch: 1,
            codec: { codec: selected, hardware: true },
            viewport: {
              viewportId: "d",
              displayId: "d",
              crop: { x: 0, y: 0, width: 64, height: 64 },
              width: 64,
              height: 64,
              fps: 60,
              bitrate: 1000,
            },
          },
        ],
      };
    },
    setDesktopControl: async () => {
      controlCalls++;
      return { inputEpoch: 1 };
    },
    detachDesktop: async () => {},
    renewDesktopLease: async () => ({ remainingMs: 15000 }),
  },
});
mock.module("../src/protocol/desktop-session.ts", {
  namedExports: {
    desktopEvents: async function* (
      _transport: unknown,
      request: AttachDesktopReq,
      signal: AbortSignal,
    ) {
      offers.push(request.codecs);
      selected = request.codecs[0];
      yield {
        type: "attached",
        attachId: `a${++next}`,
        layoutEpoch: 1,
        displays: [display],
        control: { inputEpoch: next },
        leaseMs: 15000,
      };
      if (mode === "encoder" && request.codecs[0] === av1)
        throw new Error("Native encoder failed");
      if (!signal.aborted)
        await new Promise<void>((resolve) =>
          signal.addEventListener("abort", () => resolve(), { once: true }),
        );
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
      flush() {}
    },
    bindDesktopInput: () => () => {},
  },
});
mock.module("../src/protocol/desktop-video.ts", {
  namedExports: {
    // Represents a client with separately verified hardware; never a claim about
    // the test runner/browser. Ordinary browser policy excludes AV1 before attach.
    supportedDesktopCodecs: async () => [av1, h264],
    DesktopVideoReceiver: class {
      constructor(
        _t: unknown,
        _id: string,
        _render: unknown,
        _stats: unknown,
        _fail: unknown,
        private codecFailed: (codec: string) => void,
      ) {}
      async configure(config: DesktopConfiguration) {
        const codec = config.tracks[0].codec.codec;
        if (codec === av1) {
          if (mode === "configure") throw Error("AV1 configuration failed");
          if (mode === "decode") queueMicrotask(() => this.codecFailed(codec));
        }
      }
      close() {}
    },
  },
});
const { rpcSessionBunja } = await import("../src/state/rpc-session.ts");
const { desktopBunja } = await import("../src/state/desktop.ts");
for (const failure of ["configure", "decode", "encoder"]) {
  test(`AV1 ${failure} failure reattaches with H264 once and never restores control`, async () => {
    mode = failure;
    offers = [];
    configurations = [];
    controlCalls = 0;
    const store = createBunjaStore({
      wrapInstance: (init) => createRoot(init),
      overrides: [
        override(rpcSessionBunja, () =>
          rpcSessionStub({
            daemonInfo: createSignal({
              phase: "ready" as const,
              receivedAtMs: 0,
              daemonInfo: {
                instanceId: "f",
                version: "1",
                os: "windows",
                startedAtMs: 0,
                serverTimeMs: 0,
                supportedProcIds: [ProcId.GetDesktopCapabilities],
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
      for (let i = 0; i < 30; i++) {
        flushSolid();
        await Promise.resolve();
      }
      await entry.value.connect();
      for (let i = 0; i < 100; i++) {
        flushSolid();
        await Promise.resolve();
      }
      assert.deepEqual(
        offers,
        [[av1, h264], [h264]],
        JSON.stringify({
          phase: entry.value.phase(),
          message: entry.value.message(),
        }),
      );
      assert.equal(entry.value.phase(), "viewing");
      assert.equal(entry.value.configuration()?.tracks[0].codec.codec, h264);
      assert.equal(entry.value.controlling(), false);
      assert.equal(controlCalls, 0);
      const configured = configurations.at(-1)!;
      assert.equal(configured.viewports[0].width % 2, 0);
      assert.equal(configured.viewports[0].height % 2, 0);
      await entry.value.resize(720);
      assert.equal(entry.value.outputHeight(), 720);
      assert.ok(configurations.at(-1)!.viewports[0].height <= 720);
      assert.equal(configurations.at(-1)!.viewports[0].displayId, "d");
      assert.equal(controlCalls, 0);
      await entry.value.resize(999);
      assert.equal(entry.value.outputHeight(), 720);
    } finally {
      stop();
      store.dispose();
    }
  });
}
