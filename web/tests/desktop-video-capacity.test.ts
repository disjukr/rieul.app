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
  initialConfiguration = true,
) {
  const original = {
    VideoDecoder: globalThis.VideoDecoder,
    EncodedVideoChunk: globalThis.EncodedVideoChunk,
  };
  const f = await setup(initialConfiguration);
  try {
    await run(f);
  } finally {
    f.engine.close();
    await f.engine.closedStreams();
    Object.assign(globalThis, original);
  }
}
async function setup(initialConfiguration = true) {
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
  let flushGate: Promise<void> | undefined;
  let releaseFlush: (() => void) | undefined;
  class Decoder extends EventTarget {
    static async isConfigSupported(config: VideoDecoderConfig) {
      return { supported: true, config };
    }
    state: CodecState = "unconfigured";
    decodeQueueSize = 0;
    pending: EncodedVideoChunk[] = [];
    ready: EncodedVideoChunk[] = [];
    constructor(private callbacks: VideoDecoderInit) {
      super();
      decoders.push(this);
    }
    reset() {
      const queued = this.decodeQueueSize;
      counts.resets++;
      this.decodeQueueSize = 0;
      this.pending = [];
      this.ready = [];
      this.state = "unconfigured";
      if (queued) this.dispatchEvent(new Event("dequeue"));
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
    dequeueOne(notify = true) {
      const c = this.pending.shift();
      if (!c) return;
      this.decodeQueueSize--;
      this.ready.push(c);
      if (notify) this.dispatchEvent(new Event("dequeue"));
    }
    outputOne() {
      const c = this.ready.shift();
      if (!c) return;
      counts.outputs++;
      this.callbacks.output({
        timestamp: c.timestamp,
        close() {},
      } as VideoFrame);
    }
    releaseOne(notify = true) {
      this.dequeueOne(notify);
      this.outputOne();
    }
    async flush() {
      counts.flushes++;
      if (flushGate) await flushGate;
      while (this.pending.length) this.dequeueOne();
      while (this.ready.length) this.outputOne();
    }
    fail() {
      this.state = "closed";
      this.pending = [];
      this.ready = [];
      this.decodeQueueSize = 0;
      this.callbacks.error(new DOMException("synthetic", "EncodingError"));
    }
    close() {
      this.state = "closed";
      this.pending = [];
      this.ready = [];
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
  if (initialConfiguration) await engine.configure(config);
  function group(id: number) {
    let media!: ReadableStreamDefaultController<Uint8Array>;
    let canceled = false;
    incoming.enqueue(
      new ReadableStream<Uint8Array>({
        start(c) {
          media = c;
        },
        cancel() {
          counts.cancels++;
          canceled = true;
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
        if (canceled) return false;
        media.enqueue(bytes);
        return true;
      },
      close() {
        if (!canceled) media.close();
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
    blockFlush: () => {
      flushGate = new Promise<void>((resolve) => {
        releaseFlush = resolve;
      });
      return () => releaseFlush?.();
    },
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

test("capacity wait budget is shared by repeated stalls in one group", (t) =>
  fixture(async (f) => {
    let now = 0;
    t.mock.method(performance, "now", () => now);
    t.mock.timers.enable({ apis: ["setTimeout"] });
    const events = capacityTrace(f.engine);
    const g = f.group(1);
    for (let i = 0; i < 5; i++) g.feed(i);
    g.close();
    await tick();
    assert.equal(f.counts.submits, 3);
    now = 300;
    f.decoder().dequeueOne();
    await tick();
    assert.equal(f.counts.submits, 4);
    now = 501;
    t.mock.timers.tick(201);
    await f.engine.closedStreams();
    assert.deepEqual(events, [
      { budget: 500, elapsed: 300, outcome: "capacity" },
      { budget: 200, outcome: "Screen decoder capacity deadline" },
    ]);
    assert.equal(f.counts.submits, 4);
    assert.equal(f.counts.keyframes, 1);
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

function afterCapacity(engine: DesktopVideoEngine, action: () => void) {
  const target = engine as unknown as {
    waitForCapacity: (...args: unknown[]) => Promise<number>;
  };
  const original = target.waitForCapacity.bind(engine);
  target.waitForCapacity = async (...args) => {
    const elapsed = await original(...args);
    queueMicrotask(action);
    return elapsed;
  };
}
test("closure after capacity resolves still blocks stale submission", () =>
  fixture(async (f) => {
    afterCapacity(f.engine, () => f.engine.close());
    await f.saturated();
    f.decoder().releaseOne();
    await f.engine.closedStreams();
    assert.equal(f.counts.submits, 3);
    assert.equal(f.counts.keyframes, 0);
  }));
test("queue cap is rechecked after capacity resolves", () =>
  fixture(async (f) => {
    afterCapacity(f.engine, () => {
      f.decoder().decodeQueueSize = 3;
    });
    const g = await f.saturated();
    g.close();
    f.decoder().releaseOne();
    await f.engine.closedStreams();
    assert.equal(f.counts.submits, 3);
    assert.equal(f.counts.maxQueue, 3);
    assert.equal(f.counts.keyframes, 1);
  }));

test("stream opened before initial configuration accepts its first matching object", () =>
  fixture(async (f) => {
    const g = f.group(1);
    await tick();
    await f.engine.configure(config);
    g.feed(0);
    g.close();
    await tick();
    await f.engine.closedStreams();
    assert.equal(f.counts.submits, 1);
    assert.deepEqual(f.rendered, [1000000]);
    assert.equal(f.counts.keyframes, 0);
  }, false));

test("old track generation cannot admit first object during pending reconfiguration", () =>
  fixture(async (f) => {
    const g = f.group(1);
    await tick();
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
      const configuring = f.engine.configure(config);
      assert.equal(g.feed(0), false);
      await tick();
      await f.engine.closedStreams();
      assert.equal(f.counts.submits, 0);
      assert.deepEqual(f.rendered, []);
      release();
      await configuring;
      const next = f.group(2);
      next.feed(0);
      next.close();
      await tick();
      await f.engine.closedStreams();
      assert.equal(f.counts.submits, 1);
      assert.deepEqual(f.rendered, [2000000]);
    } finally {
      release();
      VideoDecoder.isConfigSupported = support;
    }
  }));

test("completed same-epoch reconfiguration rejects an old unbound stream", () =>
  fixture(async (f) => {
    const old = f.group(1);
    await tick();
    await f.engine.configure(config);
    assert.equal(old.feed(0), false);
    old.close();
    await tick();
    await f.engine.closedStreams();
    assert.equal(f.counts.submits, 0);
    assert.deepEqual(f.rendered, []);
    const fresh = f.group(2);
    fresh.feed(0);
    fresh.close();
    await tick();
    await f.engine.closedStreams();
    assert.equal(f.counts.submits, 1);
    assert.deepEqual(f.rendered, [2000000]);
  }));

test("startup exception does not span a second applied configuration", () =>
  fixture(async (f) => {
    const old = f.group(1);
    await tick();
    await f.engine.configure(config);
    await f.engine.configure(config);
    assert.equal(old.feed(0), false);
    old.close();
    await tick();
    await f.engine.closedStreams();
    assert.equal(f.counts.submits, 0);
    const fresh = f.group(2);
    fresh.feed(0);
    fresh.close();
    await tick();
    await f.engine.closedStreams();
    assert.equal(f.counts.submits, 1);
    assert.deepEqual(f.rendered, [2000000]);
  }, false));

test("empty tracks after initialization do not reopen the startup exception", () =>
  fixture(async (f) => {
    await f.engine.configure({ ...config, tracks: [] });
    const old = f.group(1);
    await tick();
    await f.engine.configure(config);
    assert.equal(old.feed(0), false);
    old.close();
    await tick();
    await f.engine.closedStreams();
    assert.equal(f.counts.submits, 0);
    const fresh = f.group(2);
    fresh.feed(0);
    fresh.close();
    await tick();
    await f.engine.closedStreams();
    assert.equal(f.counts.submits, 1);
    assert.deepEqual(f.rendered, [2000000]);
  }));

function capacityTrace(engine: DesktopVideoEngine) {
  const events: { budget: number; outcome?: string; elapsed?: number }[] = [];
  const target = engine as unknown as {
    waitForCapacity: (...args: unknown[]) => Promise<number>;
  };
  const original = target.waitForCapacity.bind(engine);
  target.waitForCapacity = async (...args) => {
    const event = { budget: args[4] as number } as (typeof events)[number];
    events.push(event);
    try {
      event.elapsed = await original(...args);
      event.outcome = "capacity";
      return event.elapsed;
    } catch (error) {
      event.outcome = (error as Error).message;
      throw error;
    }
  };
  return events;
}

test("native coalesced dequeue admits only available capacity", () =>
  fixture(async (f) => {
    const events = capacityTrace(f.engine);
    const g = await f.saturated();
    g.close();
    f.decoder().dequeueOne(false);
    f.decoder().dequeueOne(false);
    f.decoder().dispatchEvent(new Event("dequeue"));
    await f.engine.closedStreams();
    assert.equal(f.counts.submits, 4);
    assert.equal(f.counts.outputs, 4);
    assert.equal(f.counts.maxQueue, 3);
    assert.equal(f.counts.keyframes, 0);
    assert.equal(events[0].outcome, "capacity");
    assert.equal(events[0].budget, 500);
  }));

test("native queue drained before listener registration does not lose wakeup", () =>
  fixture(async (f) => {
    const decoder = f.decoder();
    const add = decoder.addEventListener.bind(decoder);
    decoder.addEventListener = (type, listener, options) => {
      if (type === "dequeue" && decoder.decodeQueueSize === 3)
        decoder.dequeueOne(false);
      add(type, listener, options);
    };
    const g = f.group(1);
    for (let i = 0; i < 4; i++) g.feed(i);
    g.close();
    await tick();
    await f.engine.closedStreams();
    assert.equal(f.counts.submits, 4);
    assert.equal(f.counts.outputs, 4);
    assert.equal(f.counts.keyframes, 0);
    assert.equal(f.counts.maxQueue, 3);
  }));

test("native startup without dequeue expires its decoder-service budget", (t) =>
  fixture(async (f) => {
    let now = 0;
    t.mock.method(performance, "now", () => now);
    t.mock.timers.enable({ apis: ["setTimeout"] });
    const events = capacityTrace(f.engine);
    await f.saturated();
    now = 501;
    t.mock.timers.tick(501);
    await f.engine.closedStreams();
    assert.equal(f.counts.submits, 3);
    assert.equal(f.counts.outputs, 0);
    assert.equal(f.counts.keyframes, 1);
    assert.deepEqual(events, [
      { budget: 500, outcome: "Screen decoder capacity deadline" },
    ]);
  }));

test("native late dequeue cannot admit work beyond deadline", (t) =>
  fixture(async (f) => {
    let now = 0;
    t.mock.method(performance, "now", () => now);
    t.mock.timers.enable({ apis: ["setTimeout"] });
    const events = capacityTrace(f.engine);
    await f.saturated();
    now = 501;
    f.decoder().dequeueOne();
    await f.engine.closedStreams();
    assert.equal(f.counts.submits, 3);
    assert.equal(f.counts.outputs, 0);
    assert.equal(f.counts.keyframes, 1);
    assert.equal(events[0].outcome, "Screen decoder capacity deadline");
  }));

test("native missing dequeue event still ends at finite deadline", (t) =>
  fixture(async (f) => {
    let now = 0;
    t.mock.method(performance, "now", () => now);
    t.mock.timers.enable({ apis: ["setTimeout"] });
    const events = capacityTrace(f.engine);
    await f.saturated();
    f.decoder().dequeueOne(false);
    now = 501;
    t.mock.timers.tick(501);
    await f.engine.closedStreams();
    assert.equal(f.counts.submits, 3);
    assert.equal(f.counts.outputs, 0);
    assert.equal(f.counts.keyframes, 1);
    assert.equal(events[0].outcome, "Screen decoder capacity deadline");
  }));

test("startup capacity waits and flush share one decoder-service budget", (t) =>
  fixture(async (f) => {
    let now = 0;
    t.mock.method(performance, "now", () => now);
    t.mock.timers.enable({ apis: ["setTimeout"] });
    const release = f.blockFlush();
    const events = capacityTrace(f.engine);
    try {
      const g = await f.saturated();
      g.close();
      now = 300;
      f.decoder().dequeueOne();
      await tick();
      assert.equal(events[0].elapsed, 300);
      assert.equal(f.counts.flushes, 1);
      now = 501;
      t.mock.timers.tick(201);
      await f.engine.closedStreams();
      assert.equal(f.counts.submits, 4);
      assert.equal(f.counts.outputs, 0);
      assert.equal(f.counts.keyframes, 1);
    } finally {
      release();
    }
  }));

test("later groups retain the short native pressure budget", (t) =>
  fixture(async (f) => {
    let now = 0;
    t.mock.method(performance, "now", () => now);
    t.mock.timers.enable({ apis: ["setTimeout"] });
    const first = f.group(1);
    first.feed(0);
    first.close();
    await tick();
    await f.engine.closedStreams();
    const events = capacityTrace(f.engine);
    const next = f.group(2);
    for (let i = 0; i < 4; i++) next.feed(i);
    await tick();
    assert.equal(f.counts.submits, 4);
    now = 34;
    t.mock.timers.tick(34);
    await f.engine.closedStreams();
    assert.deepEqual(events, [
      { budget: 33, outcome: "Screen decoder capacity deadline" },
    ]);
    assert.equal(f.counts.outputs, 1);
    assert.equal(f.counts.keyframes, 1);
  }));
