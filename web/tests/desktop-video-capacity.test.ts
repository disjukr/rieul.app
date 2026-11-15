import { test } from "node:test";
import assert from "node:assert/strict";
import { DesktopVideoEngine } from "../src/protocol/desktop-video-engine.ts";
import { encodeCbor } from "../src/protocol/cbor.ts";
import {
  encodeDesktopMediaObjectValue,
  type DesktopConfiguration,
} from "../src/protocol/generated/rpc.ts";

const tick = async () => {
  for (let i = 0; i < 80; i++) await Promise.resolve();
};
const config: DesktopConfiguration = {
  layoutEpoch: 1,
  totalBitrate: 1,
  tracks: [
    {
      trackId: 1,
      codecEpoch: 1,
      codec: { codec: "avc1.42002a", hardware: false },
      viewport: {
        viewportId: "v",
        displayId: "d",
        crop: { x: 0, y: 0, width: 640, height: 480 },
        width: 640,
        height: 480,
        fps: 60,
        bitrate: 1,
      },
    },
  ],
};

async function fixture(
  run: (f: Awaited<ReturnType<typeof setup>>) => Promise<void>,
) {
  const original = {
    VideoDecoder: globalThis.VideoDecoder,
    EncodedVideoChunk: globalThis.EncodedVideoChunk,
  };
  const f = await setup();
  try {
    await run(f);
  } finally {
    f.engine.close();
    await f.engine.closedStreams();
    Object.assign(globalThis, original);
  }
}
async function setup() {
  const counts = {
    submits: 0,
    outputs: 0,
    flushes: 0,
    resets: 0,
    cancels: 0,
    keyframes: 0,
    codecErrors: 0,
    maxQueue: 0,
  };
  const rendered: number[] = [];
  const decoders: Decoder[] = [];
  let automatic = false;
  class Decoder {
    static async isConfigSupported(config: VideoDecoderConfig) {
      return { supported: true, config };
    }
    state: CodecState = "unconfigured";
    decodeQueueSize = 0;
    pending: EncodedVideoChunk[] = [];
    constructor(private callbacks: VideoDecoderInit) {
      decoders.push(this);
    }
    reset() {
      counts.resets++;
      this.decodeQueueSize = 0;
      this.pending = [];
      this.state = "unconfigured";
    }
    configure() {
      this.state = "configured";
    }
    decode(chunk: EncodedVideoChunk) {
      counts.submits++;
      this.decodeQueueSize++;
      this.pending.push(chunk);
      counts.maxQueue = Math.max(counts.maxQueue, this.decodeQueueSize);
      if (automatic) queueMicrotask(() => this.releaseOne());
    }
    releaseOne() {
      const c = this.pending.shift();
      if (!c) return;
      this.decodeQueueSize--;
      counts.outputs++;
      this.callbacks.output({
        timestamp: c.timestamp,
        close() {},
      } as VideoFrame);
    }
    async flush() {
      counts.flushes++;
      while (this.pending.length) this.releaseOne();
    }
    fail() {
      this.state = "closed";
      this.pending = [];
      this.decodeQueueSize = 0;
      this.callbacks.error(new DOMException("synthetic", "EncodingError"));
    }
    close() {
      this.state = "closed";
      this.pending = [];
      this.decodeQueueSize = 0;
    }
  }
  globalThis.VideoDecoder = Decoder as unknown as typeof VideoDecoder;
  globalThis.EncodedVideoChunk = class {
    timestamp: number;
    constructor(c: EncodedVideoChunkInit) {
      this.timestamp = c.timestamp;
    }
  } as typeof EncodedVideoChunk;
  let incoming!: ReadableStreamDefaultController<ReadableStream<Uint8Array>>;
  const streams = new ReadableStream<ReadableStream<Uint8Array>>({
    start(c) {
      incoming = c;
    },
  });
  const engine = new DesktopVideoEngine(
    { incomingUnidirectionalStreams: streams } as WebTransport,
    "a",
    (_id, frame) => {
      rendered.push(frame.timestamp);
      return true;
    },
    (s) => {
      if (s.requestKeyframe) counts.keyframes++;
    },
    () => assert.fail("unexpected receive failure"),
    () => {
      counts.codecErrors++;
    },
  );
  await engine.configure(config);
  function group(id: number) {
    let media!: ReadableStreamDefaultController<Uint8Array>;
    incoming.enqueue(
      new ReadableStream<Uint8Array>({
        start(c) {
          media = c;
        },
        cancel() {
          counts.cancels++;
        },
      }),
    );
    return {
      feed(i: number) {
        const body = encodeCbor(
          encodeDesktopMediaObjectValue({
            attachId: "a",
            trackId: 1,
            layoutEpoch: 1,
            codecEpoch: 1,
            groupId: id,
            objectId: i,
            timestampMicros: id * 1000000 + i * 16667,
            keyframe: i === 0,
            data: new Uint8Array([1]),
          }),
        );
        const bytes = new Uint8Array(body.length + 4);
        new DataView(bytes.buffer).setUint32(0, body.length);
        bytes.set(body, 4);
        media.enqueue(bytes);
      },
      close() {
        media.close();
      },
    };
  }
  async function saturated() {
    const g = group(1);
    for (let i = 0; i < 4; i++) g.feed(i);
    await tick();
    assert.equal(counts.submits, 3);
    assert.equal(decoders.at(-1)!.decodeQueueSize, 3);
    return g;
  }
  return {
    engine,
    counts,
    rendered,
    group,
    saturated,
    decoder: () => decoders.at(-1)!,
    automatic: () => {
      automatic = true;
    },
  };
}

test("capacity wait admits a burst after dequeue without exceeding three", () =>
  fixture(async (f) => {
    const g = await f.saturated();
    g.close();
    setTimeout(() => f.decoder().releaseOne(), 1);
    await f.engine.closedStreams();
    assert.equal(f.counts.submits, 4);
    assert.equal(f.counts.outputs, 4);
    assert.equal(f.counts.flushes, 1);
    assert.equal(f.counts.keyframes, 0);
    assert.equal(f.counts.maxQueue, 3);
  }));
test("capacity deadline cancels a truly saturated group and requests recovery", () =>
  fixture(async (f) => {
    await f.saturated();
    await f.engine.closedStreams();
    assert.equal(f.counts.submits, 3);
    assert.equal(f.counts.outputs, 0);
    assert.equal(f.counts.flushes, 0);
    assert.equal(f.counts.cancels, 1);
    assert.equal(f.counts.keyframes, 1);
    assert.equal(f.counts.maxQueue, 3);
  }));
test("capacity wait stops on closure without stale admission or recovery", () =>
  fixture(async (f) => {
    await f.saturated();
    f.engine.close();
    await f.engine.closedStreams();
    assert.equal(f.counts.submits, 3);
    assert.equal(f.counts.outputs, 0);
    assert.equal(f.counts.keyframes, 0);
  }));
test("replacement cancels old capacity wait and renders only the new group", () =>
  fixture(async (f) => {
    await f.saturated();
    const next = f.group(2);
    next.feed(0);
    next.close();
    await tick();
    await f.engine.closedStreams();
    assert.equal(f.counts.submits, 4);
    assert.deepEqual(f.rendered, [2000000]);
    assert.equal(f.counts.cancels, 1);
    assert.equal(f.counts.keyframes, 0);
  }));
test("reconfigure cancels capacity wait before admitting old epoch data", () =>
  fixture(async (f) => {
    await f.saturated();
    await f.engine.configure({ ...config, layoutEpoch: 2 });
    await f.engine.closedStreams();
    assert.equal(f.counts.submits, 3);
    assert.equal(f.counts.outputs, 0);
    assert.equal(f.counts.keyframes, 0);
  }));
test("decoder error aborts capacity wait and retains bounded recovery", () =>
  fixture(async (f) => {
    await f.saturated();
    f.decoder().fail();
    await f.engine.closedStreams();
    assert.equal(f.counts.submits, 3);
    assert.equal(f.counts.outputs, 0);
    assert.equal(f.counts.codecErrors, 1);
    assert.equal(f.counts.keyframes, 1);
  }));
test("decoder reset stops capacity wait without stale submission", () =>
  fixture(async (f) => {
    await f.saturated();
    f.decoder().reset();
    await f.engine.closedStreams();
    assert.equal(f.counts.submits, 3);
    assert.equal(f.counts.outputs, 0);
    assert.equal(f.counts.keyframes, 1);
  }));
test("dequeued input path remains unaffected", () =>
  fixture(async (f) => {
    f.automatic();
    const g = f.group(1);
    for (let i = 0; i < 4; i++) {
      g.feed(i);
      await tick();
    }
    g.close();
    await f.engine.closedStreams();
    assert.equal(f.counts.submits, 4);
    assert.equal(f.counts.outputs, 4);
    assert.equal(f.counts.keyframes, 0);
    assert.equal(f.counts.maxQueue, 1);
  }));

test("capacity wait budget is shared by repeated stalls in one group", () =>
  fixture(async (f) => {
    const g = f.group(1);
    for (let i = 0; i < 30; i++) g.feed(i);
    await tick();
    const timer = setInterval(() => f.decoder().releaseOne(), 5);
    try {
      await f.engine.closedStreams();
    } finally {
      clearInterval(timer);
    }
    assert.ok(f.counts.submits > 3);
    assert.ok(f.counts.submits < 30);
    assert.equal(f.counts.keyframes, 1);
    assert.equal(f.counts.cancels, 1);
    assert.equal(f.counts.maxQueue, 3);
  }));

test("pending reconfiguration rejects old output and capacity admission", () =>
  fixture(async (f) => {
    await f.saturated();
    const old = f.decoder();
    const support = VideoDecoder.isConfigSupported;
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    VideoDecoder.isConfigSupported = async (config) => {
      await gate;
      return support(config);
    };
    try {
      const configuring = f.engine.configure({ ...config, layoutEpoch: 2 });
      old.releaseOne();
      await f.engine.closedStreams();
      assert.equal(f.counts.submits, 3);
      assert.deepEqual(f.rendered, []);
      assert.equal(f.counts.keyframes, 0);
      release();
      await configuring;
    } finally {
      release();
      VideoDecoder.isConfigSupported = support;
    }
  }));
