import { test } from "node:test";
import assert from "node:assert/strict";
import {
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
  class Decoder {
    static async isConfigSupported(c: VideoDecoderConfig) {
      return { supported: c.codec === "fixture", config: c };
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
      this.callbacks.output({
        timestamp: chunk.timestamp,
        close() {
          framesClosed++;
        },
      } as VideoFrame);
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
  const rendered: string[] = [],
    stats: DesktopVideoStats[] = [],
    errors: string[] = [];
  const receiver = new DesktopVideoReceiver(
    { incomingUnidirectionalStreams: stream } as WebTransport,
    "a",
    (id) => rendered.push(id),
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
        codec: { codec: "fixture", hardware: false },
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
        { codec: "fixture", hardware: false },
      ]),
      ["fixture"],
    );
    await receiver.configure(config);
    incoming!.enqueue(group(1, false));
    await tick();
    incoming!.enqueue(group(2, true));
    await tick();
    incoming!.enqueue(group(3, true, 9));
    await tick();
    assert.deepEqual(rendered, ["v", "v"]);
    assert.equal(framesClosed, 2);
    assert.equal(groupCanceled, 1);
    assert.equal(stats.length, 2);
    assert.deepEqual(errors, []);
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
