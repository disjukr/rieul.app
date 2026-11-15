import assert from "node:assert/strict";
import { test } from "node:test";
import { encodeCbor } from "../src/protocol/cbor.ts";
import {
  encodeDesktopMediaObjectValue,
  type DesktopConfiguration,
} from "../src/protocol/generated/rpc.ts";
const tick = async () => {
  for (let i = 0; i < 100; i++) await Promise.resolve();
};
const configuration: DesktopConfiguration = {
  layoutEpoch: 1,
  totalBitrate: 1,
  tracks: [
    {
      trackId: 1,
      codecEpoch: 1,
      codec: { codec: "fixture", hardware: false },
      viewport: {
        viewportId: "v",
        displayId: "d",
        crop: { x: 0, y: 0, width: 2, height: 2 },
        width: 2,
        height: 2,
        fps: 60,
        bitrate: 1,
      },
    },
  ],
};
function group(groupId: number, cancel: () => void, closed: boolean) {
  const body = encodeCbor(
    encodeDesktopMediaObjectValue({
      attachId: "a",
      trackId: 1,
      codecEpoch: 1,
      layoutEpoch: 1,
      groupId,
      objectId: 0,
      timestampMicros: groupId,
      keyframe: true,
      data: new Uint8Array([1]),
    }),
  );
  const bytes = new Uint8Array(body.length + 4);
  new DataView(bytes.buffer).setUint32(0, body.length);
  bytes.set(body, 4);
  return new ReadableStream<Uint8Array>({
    start(c) {
      c.enqueue(bytes);
      if (closed) c.close();
    },
    cancel,
  });
}
test("worker preserves old intake revision when buffered prefix is consumed after same-wire configure", async () => {
  const original = {
    self: Object.getOwnPropertyDescriptor(globalThis, "self"),
    canvas: Object.getOwnPropertyDescriptor(globalThis, "OffscreenCanvas"),
    decoder: globalThis.VideoDecoder,
  };
  type Message = { type: string; [key: string]: unknown };
  const sent: Message[] = [];
  const scope: {
    onmessage?: (event: { data: Message }) => Promise<void>;
    postMessage: (data: Message) => void;
  } = { postMessage: (data) => sent.push(data) };
  const frame = (timestamp: number): VideoFrame =>
    ({
      timestamp,
      displayWidth: 2,
      displayHeight: 2,
      clone: () => frame(timestamp),
      close() {},
    }) as VideoFrame;
  class Decoder extends EventTarget {
    static async isConfigSupported(config: VideoDecoderConfig) {
      return { supported: true, config };
    }
    state: CodecState = "unconfigured";
    decodeQueueSize = 0;
    constructor(private callbacks: VideoDecoderInit) {
      super();
    }
    reset() {
      this.state = "unconfigured";
    }
    configure() {
      this.state = "configured";
    }
    decode(chunk: EncodedVideoChunk) {
      this.callbacks.output(frame(chunk.timestamp));
    }
    async flush() {}
    close() {
      this.state = "closed";
    }
  }
  const oldChunk = globalThis.EncodedVideoChunk;
  globalThis.EncodedVideoChunk = class {
    timestamp: number;
    constructor(chunk: EncodedVideoChunkInit) {
      this.timestamp = chunk.timestamp;
    }
  } as typeof EncodedVideoChunk;
  globalThis.VideoDecoder = Decoder as unknown as typeof VideoDecoder;
  Object.defineProperty(globalThis, "self", {
    configurable: true,
    value: scope,
  });
  Object.defineProperty(globalThis, "OffscreenCanvas", {
    configurable: true,
    value: class {},
  });
  let canceled = 0;
  try {
    await import(
      new URL(
        "../src/protocol/desktop-video-worker.ts?admission",
        import.meta.url,
      ).href
    );
    await scope.onmessage!({ data: { type: "init", attachId: "a" } });
    await scope.onmessage!({
      data: { type: "configure", id: 1, configuration, mediaRevision: 0 },
    });
    const old = scope.onmessage!({
      data: {
        type: "stream",
        id: 1,
        stream: group(
          1,
          () => {
            canceled++;
          },
          false,
        ),
        mediaRevision: 0,
      },
    });
    const replacing = scope.onmessage!({
      data: { type: "configure", id: 2, configuration, mediaRevision: 1 },
    });
    await old;
    await replacing;
    await tick();
    assert.equal(sent.filter((m) => m.type === "frame").length, 0);
    assert.equal(canceled, 1);
    await scope.onmessage!({
      data: {
        type: "stream",
        id: 2,
        stream: group(2, () => {}, true),
        mediaRevision: 1,
      },
    });
    await tick();
    const frames = sent.filter((m) => m.type === "frame");
    assert.equal(frames.length, 1);
    assert.equal(frames[0]!.mediaRevision, 1);
    assert.equal(frames[0]!.generation, 2);
    (frames[0]!.frame as VideoFrame).close();
    await scope.onmessage!({ data: { type: "consumed", id: frames[0]!.id } });
  } finally {
    await scope.onmessage?.({ data: { type: "close" } });
    globalThis.VideoDecoder = original.decoder;
    globalThis.EncodedVideoChunk = oldChunk;
    if (original.self) Object.defineProperty(globalThis, "self", original.self);
    else Reflect.deleteProperty(globalThis, "self");
    if (original.canvas)
      Object.defineProperty(globalThis, "OffscreenCanvas", original.canvas);
    else Reflect.deleteProperty(globalThis, "OffscreenCanvas");
  }
});
