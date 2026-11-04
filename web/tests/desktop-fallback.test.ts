import type { DesktopVideoStats } from "../src/protocol/desktop-video.ts";
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
let selectedProfile = 1,
  profiles: number[] = [],
  released = 0;
let rejectControl = false;
let configurations: ConfigureDesktopViewportsReq[] = [];
let feedbacks: unknown[] = [],
  statsHandlers: Array<(value: DesktopVideoStats) => void> = [];
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
      supportedProfiles: mode.startsWith("stripe") ? [1, 2] : undefined,
      capture: DesktopAvailability.Available,
      input: DesktopAvailability.Available,
      codecs: [
        { codec: av1, hardware: true },
        { codec: h264, hardware: true },
      ],
      composition: false,
      feedback: true,
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
            stripes:
              selectedProfile === 2
                ? [
                    { y: 0, height: 32 },
                    { y: 32, height: 32 },
                  ]
                : undefined,
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
      if (rejectControl) throw new Error("Control is held by another viewer");
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
      profiles.push(request.profile);
      selectedProfile = request.profile;
      selected = request.codecs[0];
      yield {
        type: "attached",
        attachId: `a${++next}`,
        layoutEpoch: 1,
        displays: [display],
        control: { inputEpoch: next },
        leaseMs: 15000,
      };
      if (
        (mode === "encoder" && request.codecs[0] === av1) ||
        (mode === "stripe-encoder" && request.profile === 2)
      )
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
      send(event: { type: string }) {
        if (event.type === "releaseAll") released++;
        if (event.type === "feedback") feedbacks.push(event);
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
    supportedDesktopCodecs: async () =>
      mode.startsWith("stripe") ? [h264] : [av1, h264],
    DesktopVideoReceiver: class {
      constructor(
        _t: unknown,
        _id: string,
        _render: unknown,
        stats: (value: DesktopVideoStats) => void,
        _fail: unknown,
        private codecFailed: (codec: string) => void,
      ) {
        statsHandlers.push(stats);
      }
      async configure(config: DesktopConfiguration) {
        const codec = config.tracks[0].codec.codec;
        if (
          mode === "stripe-both" ||
          (config.tracks[0].stripes && mode === "stripe-configure")
        )
          throw Error("Stripe configuration failed");
        if (config.tracks[0].stripes && mode === "stripe-decode")
          queueMicrotask(() => this.codecFailed(codec));
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
for (const failure of [
  "configure",
  "decode",
  "encoder",
  "stripe-configure",
  "stripe-decode",
  "stripe-encoder",
  "stripe-both",
]) {
  test(`${failure} failure renegotiates once and never restores control`, async () => {
    mode = failure;
    offers = [];
    configurations = [];
    controlCalls = 0;
    profiles = [];
    released = 0;
    feedbacks = [];
    statsHandlers = [];
    const canvas = globalThis.OffscreenCanvas;
    if (failure.startsWith("stripe"))
      globalThis.OffscreenCanvas =
        class {} as unknown as typeof OffscreenCanvas;
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
                supportedProcIds: [
                  ProcId.GetDesktopCapabilities,
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
        failure.startsWith("stripe") ? [[h264], [h264]] : [[av1, h264], [h264]],
        JSON.stringify({
          phase: entry.value.phase(),
          message: entry.value.message(),
        }),
      );
      assert.deepEqual(
        profiles,
        failure.startsWith("stripe") ? [2, 1] : [1, 1],
      );
      if (failure.startsWith("stripe")) assert.ok(released > 0);
      if (failure === "stripe-both") {
        assert.equal(entry.value.phase(), "error");
        assert.equal(controlCalls, 0);
        assert.equal(entry.value.controlling(), false);
        return;
      }
      assert.equal(entry.value.phase(), "viewing");
      const now = mock.method(performance, "now", () => 1000);
      try {
        const rendered = {
          trackId: 1,
          codecEpoch: 1,
          groupId: 1,
          objectId: 1,
          decodeMicros: 10,
          renderMicros: 5,
          queueDepth: 0,
          requestKeyframe: false,
        };
        statsHandlers.at(-1)!(rendered);
        statsHandlers.at(-1)!({ ...rendered, objectId: 2 });
        flushSolid();
        assert.equal(
          feedbacks.length,
          2,
          "both rendered objects must be acknowledged inside the UI throttle interval",
        );
        assert.equal(
          entry.value.stats()?.objectId,
          1,
          "UI statistics remain throttled",
        );
        statsHandlers[0]({ ...rendered, objectId: 3 });
        assert.equal(
          feedbacks.length,
          2,
          "retired generation must not send acknowledgements",
        );
      } finally {
        now.mock.restore();
      }

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
      rejectControl = true;
      await entry.value.acquire();
      assert.match(entry.value.message()!, /held by another viewer/);
      rejectControl = false;
      await entry.value.takeover();
      assert.equal(entry.value.message(), undefined);
    } finally {
      stop();
      store.dispose();
      globalThis.OffscreenCanvas = canvas;
    }
  });
}
