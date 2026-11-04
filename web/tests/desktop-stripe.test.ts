import { test } from "node:test";
import assert from "node:assert/strict";
import {
  decodeStripeBundle,
  validStripeLayout,
  StripeDecoder,
} from "../src/protocol/desktop-stripe.ts";
function bundle(indexes = [0, 1], key = true) {
  const bytes = new Uint8Array(4 + indexes.length * 12);
  bytes.set([82, 83, 2, indexes.length]);
  const view = new DataView(bytes.buffer);
  indexes.forEach((index, i) => {
    const at = 4 + i * 12;
    bytes.set([index, key ? 1 : 0], at);
    view.setUint32(at + 2, 6);
    bytes.set([0, 0, 0, 1, key ? 0x65 : 0x41, 1], at + 6);
  });
  return bytes;
}
test("stripe layouts and packet bounds reject incomplete initial state", () => {
  assert.ok(
    validStripeLayout(480, [
      { y: 0, height: 240 },
      { y: 240, height: 240 },
    ]),
  );
  assert.ok(
    !validStripeLayout(480, [
      { y: 0, height: 240 },
      { y: 238, height: 242 },
    ]),
  );
  const bytes = bundle();
  assert.equal(decodeStripeBundle(bytes, 2, true).length, 2);
  for (let i = 0; i < bytes.length; i++)
    assert.throws(() => decodeStripeBundle(bytes.subarray(0, i), 2, true));
  assert.throws(() => decodeStripeBundle(bundle([1], false), 2, true));
  assert.equal(decodeStripeBundle(bundle([1], false), 2, false)[0].index, 1);
  assert.throws(() => decodeStripeBundle(bundle([0, 0]), 2, true));
  assert.throws(() =>
    decodeStripeBundle(new Uint8Array([...bytes, 0]), 2, true),
  );
  const huge = bytes.slice();
  new DataView(huge.buffer).setUint32(6, 0xffffffff);
  assert.throws(() => decodeStripeBundle(huge, 2, true));
});
test("composition commits atomically, keeps unchanged stripes and ignores retired decoder callbacks", async () => {
  const original = {
    VideoDecoder: globalThis.VideoDecoder,
    VideoFrame: globalThis.VideoFrame,
    EncodedVideoChunk: globalThis.EncodedVideoChunk,
    OffscreenCanvas: globalThis.OffscreenCanvas,
  };
  const decoders: Decoder[] = [];
  let closed = 0;
  class Canvas {
    pixels = new Map<number, number>();
    constructor(
      public width: number,
      public height: number,
    ) {}
    getContext() {
      return {
        clearRect: () => this.pixels.clear(),
        drawImage: (
          image: Canvas | { color: number },
          _x: number,
          y: number,
        ) => {
          if (image instanceof Canvas) this.pixels = new Map(image.pixels);
          else this.pixels.set(y, image.color);
        },
      };
    }
  }
  class Chunk {
    timestamp: number;
    type: EncodedVideoChunkType;
    byteLength: number;
    data: Uint8Array;
    constructor(init: EncodedVideoChunkInit) {
      this.timestamp = init.timestamp;
      this.type = init.type;
      this.data = new Uint8Array(init.data as ArrayBuffer);
      this.byteLength = this.data.length;
    }
    copyTo(out: Uint8Array) {
      out.set(this.data);
    }
  }
  class Decoder {
    state: CodecState = "unconfigured";
    callbacks: VideoDecoderInit;
    chunks: Chunk[] = [];
    constructor(callbacks: VideoDecoderInit) {
      this.callbacks = callbacks;
      decoders.push(this);
    }
    configure() {
      this.state = "configured";
    }
    decode(c: Chunk) {
      this.chunks.push(c);
    }
    flush() {
      return Promise.resolve();
    }
    close() {
      this.state = "closed";
    }
    emit(timestamp: number, color: number) {
      this.callbacks.output({
        timestamp,
        displayWidth: 64,
        displayHeight: 16,
        color,
        close() {
          closed++;
        },
      } as unknown as VideoFrame);
    }
  }
  const outputs: { timestamp: number; pixels: Map<number, number> }[] = [];
  globalThis.OffscreenCanvas = Canvas as unknown as typeof OffscreenCanvas;
  globalThis.EncodedVideoChunk = Chunk as unknown as typeof EncodedVideoChunk;
  globalThis.VideoDecoder = Decoder as unknown as typeof VideoDecoder;
  globalThis.VideoFrame = class {
    pixels: Map<number, number>;
    timestamp: number;
    constructor(canvas: Canvas, init: { timestamp: number }) {
      this.pixels = new Map(canvas.pixels);
      this.timestamp = init.timestamp;
    }
    close() {}
  } as unknown as typeof VideoFrame;
  try {
    const decoder = new StripeDecoder(
      64,
      32,
      [
        { y: 0, height: 16 },
        { y: 16, height: 16 },
      ],
      {
        output: (frame) =>
          outputs.push(frame as unknown as (typeof outputs)[number]),
        error: (e) => {
          throw e;
        },
      },
    );
    decoder.configure({ codec: "avc1.42002a" });
    const send = (timestamp: number, indexes = [0, 1], key = true) =>
      decoder.decode(
        new EncodedVideoChunk({
          type: key ? "key" : "delta",
          timestamp,
          data: bundle(indexes, key),
        }),
      );
    send(1);
    decoders[1].emit(1, 20);
    assert.equal(outputs.length, 0);
    decoders[0].emit(1, 10);
    assert.deepEqual(
      [...outputs[0].pixels].sort((a, b) => a[0] - b[0]),
      [
        [0, 10],
        [16, 20],
      ],
    );
    send(2, [1], false);
    decoders[1].emit(2, 30);
    assert.deepEqual(
      [...outputs[1].pixels].sort((a, b) => a[0] - b[0]),
      [
        [0, 10],
        [16, 30],
      ],
    );
    send(3);
    decoders[0].emit(3, 40);
    assert.equal(outputs.length, 2);
    decoder.reset();
    decoders[1].emit(3, 50);
    assert.equal(outputs.length, 2);
    assert.equal(closed, 5);
    decoder.configure({ codec: "avc1.42002a" });
    send(4);
    decoders[2].emit(4, 60);
    decoders[3].emit(4, 70);
    assert.deepEqual(
      [...outputs[2].pixels].sort((a, b) => a[0] - b[0]),
      [
        [0, 60],
        [16, 70],
      ],
    );
    await decoder.flush();
    decoder.close();
    assert.ok(decoders.every((d) => d.state === "closed"));
  } finally {
    Object.assign(globalThis, original);
  }
});
