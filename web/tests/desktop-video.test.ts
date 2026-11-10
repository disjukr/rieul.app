import { test } from "node:test";
import assert from "node:assert/strict";
import {
  desktopCodecOrder,
  DesktopVideoReceiver,
  supportedDesktopCodecs,
  type DesktopVideoStats,
} from "../src/protocol/desktop-video.ts";
import { encodeCbor } from "../src/protocol/cbor.ts";
import {
  encodeDesktopMediaObjectValue,
  type DesktopConfiguration,
} from "../src/protocol/generated/rpc.ts";
async function tick() {
  for (let i = 0; i < 30; i++) await Promise.resolve();
}
test("video receiver negotiates codecs, cancels stale groups and closes every frame", async () => {
  const originalDecoder = globalThis.VideoDecoder,
    originalChunk = globalThis.EncodedVideoChunk;
  let framesClosed = 0,
    decodersClosed = 0,
    groupCanceled = 0;
  let lastOutput: (() => void) | undefined;
  class Decoder {
    static async isConfigSupported(c: VideoDecoderConfig) {
      return { supported: c.codec === "avc1.42e02a", config: c };
    }
    state = "unconfigured";
    decodeQueueSize = 0;
    constructor(private callbacks: VideoDecoderInit) {}
    reset() {
      this.state = "unconfigured";
    }
    configure() {
      this.state = "configured";
    }
    decode(chunk: EncodedVideoChunk) {
      lastOutput = () =>
        this.callbacks.output({
          timestamp: chunk.timestamp,
          close() {
            framesClosed++;
          },
        } as VideoFrame);
      lastOutput();
    }
    async flush() {}
    close() {
      this.state = "closed";
      decodersClosed++;
    }
  }
  globalThis.VideoDecoder = Decoder as unknown as typeof VideoDecoder;
  globalThis.EncodedVideoChunk = class {
    timestamp: number;
    constructor(c: EncodedVideoChunkInit) {
      this.timestamp = c.timestamp;
    }
  } as typeof EncodedVideoChunk;
  let incoming: ReadableStreamDefaultController<ReadableStream<Uint8Array>>;
  const stream = new ReadableStream<ReadableStream<Uint8Array>>({
    start(c) {
      incoming = c;
    },
  });
  let canRender = true;
  const rendered: string[] = [],
    stats: DesktopVideoStats[] = [],
    errors: string[] = [];
  const receiver = new DesktopVideoReceiver(
    { incomingUnidirectionalStreams: stream } as WebTransport,
    "a",
    (id) => {
      if (!canRender) return false;
      rendered.push(id);
      return true;
    },
    (s) => stats.push(s),
    (e) => errors.push(e),
  );
  const config: DesktopConfiguration = {
    totalBitrate: 1,
    layoutEpoch: 1,
    tracks: [
      {
        trackId: 1,
        codecEpoch: 1,
        codec: { codec: "avc1.42e02a", hardware: false },
        viewport: {
          viewportId: "v",
          displayId: "d",
          crop: { x: 0, y: 0, width: 100, height: 100 },
          width: 100,
          height: 100,
          fps: 60,
          bitrate: 1,
        },
      },
    ],
  };
  function group(id: number, closed: boolean, epoch = 1) {
    return new ReadableStream<Uint8Array>({
      start(c) {
        const data = encodeCbor(
          encodeDesktopMediaObjectValue({
            attachId: "a",
            trackId: 1,
            layoutEpoch: 1,
            codecEpoch: epoch,
            groupId: id,
            objectId: 0,
            timestampMicros: id,
            keyframe: true,
            data: new Uint8Array([1]),
          }),
        );
        const frame = new Uint8Array(data.length + 4);
        new DataView(frame.buffer).setUint32(0, data.length);
        frame.set(data, 4);
        c.enqueue(frame);
        if (closed) c.close();
      },
      cancel() {
        groupCanceled++;
      },
    });
  }
  try {
    assert.deepEqual(
      await supportedDesktopCodecs([
        { codec: "bad", hardware: false },
        { codec: "avc1.42e02a", hardware: false },
      ]),
      ["avc1.42e02a"],
    );
    await receiver.configure(config);
    incoming!.enqueue(group(1, false));
    await tick();
    const staleOutput = lastOutput!;
    incoming!.enqueue(group(2, true));
    await tick();
    staleOutput(); // A callback queued before reset must not render/ACK a newer group.
    incoming!.enqueue(group(3, true, 9));
    await tick();
    assert.deepEqual(rendered, ["v", "v"]);
    assert.equal(framesClosed, 3);
    assert.equal(groupCanceled, 1);
    assert.equal(stats.length, 2);
    assert.deepEqual(
      stats.map(({ groupId, objectId }) => [groupId, objectId]),
      [
        [1, 0],
        [2, 0],
      ],
    );
    assert.deepEqual(errors, []);
    canRender = false;
    incoming!.enqueue(group(4, true));
    await tick();
    assert.equal(stats.length, 2);
    assert.equal(framesClosed, 4);
    receiver.requestRefresh("v");
    assert.equal(stats.at(-1)?.requestKeyframe, true);
    assert.equal(stats.at(-1)?.objectId, undefined);
    canRender = true;
    incoming!.enqueue(group(5, true));
    await tick();
    assert.equal(stats.at(-1)?.groupId, 5);
    assert.equal(stats.at(-1)?.objectId, 0);
    receiver.close();
    await tick();
    assert.equal(decodersClosed, 1);
    assert.equal(stream.locked, false);
  } finally {
    receiver.close();
    globalThis.VideoDecoder = originalDecoder;
    globalThis.EncodedVideoChunk = originalChunk;
  }
});

test("AV1 client policy requires evidence at both ends and retains H264 fallback", () => {
  const av1 = { codec: "av01.0.08M.08", hardware: true };
  const h264 = { codec: "avc1.42e02a", hardware: true };
  assert.deepEqual(
    desktopCodecOrder([av1, { codec: "vp09.00.10.08", hardware: true }, h264]),
    [h264],
  );
  assert.deepEqual(desktopCodecOrder([h264, av1], new Set([av1.codec])), [
    av1,
    h264,
  ]);
  assert.deepEqual(
    desktopCodecOrder(
      [{ ...av1, hardware: false }, h264],
      new Set([av1.codec]),
    ),
    [h264],
  );
  assert.deepEqual(desktopCodecOrder([av1], new Set(["av01.0.04M.08"])), []);
});

test("prefer-hardware acceptance alone does not advertise AV1", async () => {
  const original = globalThis.VideoDecoder;
  const queried: string[] = [];
  globalThis.VideoDecoder = {
    async isConfigSupported(config: VideoDecoderConfig) {
      queried.push(config.codec);
      return { supported: true, config };
    },
  } as typeof VideoDecoder;
  try {
    assert.deepEqual(
      await supportedDesktopCodecs([
        { codec: "av01.0.08M.08", hardware: true },
        { codec: "avc1.42e02a", hardware: true },
      ]),
      ["avc1.42e02a"],
    );
    assert.deepEqual(queried, ["avc1.42e02a"]);
  } finally {
    globalThis.VideoDecoder = original;
  }
});

test("HEVC prefers verified host hardware without weakening AV1 policy", () => {
  const hevc = { codec: "hev1.1.6.L120.B0", hardware: true };
  const h264 = { codec: "avc1.42e02a", hardware: true };
  const av1 = { codec: "av01.0.08M.08", hardware: true };
  assert.deepEqual(desktopCodecOrder([h264, av1, hevc]), [hevc, h264]);
  assert.deepEqual(desktopCodecOrder([h264, av1, hevc], new Set([av1.codec])), [
    hevc,
    av1,
    h264,
  ]);
  assert.deepEqual(
    desktopCodecOrder([
      { ...hevc, hardware: false },
      { ...hevc, description: new Uint8Array([1]) },
      { ...hevc, codec: "hvc1.1.6.L120.B0" },
      h264,
    ]),
    [h264],
  );
});

for (const support of ["supported", "unsupported", "throws"] as const) {
  test(`HEVC browser probe ${support} retains H264 fallback`, async () => {
    const original = globalThis.VideoDecoder;
    const configs: VideoDecoderConfig[] = [];
    const hevc = "hev1.1.6.L120.B0",
      h264 = "avc1.42e02a";
    globalThis.VideoDecoder = {
      async isConfigSupported(config: VideoDecoderConfig) {
        configs.push(config);
        if (config.codec === hevc && support === "throws")
          throw new Error("Unsupported codec");
        return {
          supported: config.codec !== hevc || support === "supported",
          config,
        };
      },
    } as typeof VideoDecoder;
    try {
      assert.deepEqual(
        await supportedDesktopCodecs([
          { codec: h264, hardware: true },
          { codec: hevc, hardware: true },
        ]),
        support === "supported" ? [hevc, h264] : [h264],
      );
      assert.deepEqual(
        configs.map((c) => [c.codec, c.hardwareAcceleration]),
        [
          [hevc, "prefer-hardware"],
          [h264, "no-preference"],
        ],
      );
      assert.equal(configs[0].description, undefined);
    } finally {
      globalThis.VideoDecoder = original;
    }
  });
}
