import assert from "node:assert/strict";
import { test } from "node:test";
import { DesktopMediaGate } from "../src/protocol/desktop-video-gate.ts";
import { DesktopVideoReceiver } from "../src/protocol/desktop-video.ts";
import { encodeCbor } from "../src/protocol/cbor.ts";
import {
  encodeDesktopMediaObjectValue,
  type DesktopConfiguration,
} from "../src/protocol/generated/rpc.ts";
const tick = async () => {
  for (let i = 0; i < 60; i++) await Promise.resolve();
};
const config = (epoch = 1, viewportId = "first"): DesktopConfiguration => ({
  layoutEpoch: 1,
  totalBitrate: 1,
  tracks: [
    {
      trackId: 1,
      codecEpoch: epoch,
      codec: { codec: "fixture", hardware: false },
      viewport: {
        viewportId,
        displayId: viewportId,
        crop: { x: 0, y: 0, width: 2, height: 2 },
        width: 2,
        height: 2,
        fps: 60,
        bitrate: 1,
      },
    },
  ],
});
function group(epoch = 1, cancel = () => {}, close = true) {
  const body = encodeCbor(
    encodeDesktopMediaObjectValue({
      attachId: "attach",
      layoutEpoch: 1,
      trackId: 1,
      codecEpoch: epoch,
      groupId: epoch,
      objectId: 0,
      timestampMicros: epoch,
      keyframe: true,
      data: new Uint8Array([1]),
    }),
  );
  const bytes = new Uint8Array(body.length + 4);
  new DataView(bytes.buffer).setUint32(0, body.length);
  bytes.set(body, 4);
  return new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(bytes);
      if (close) controller.close();
    },
    cancel,
  });
}
function transport() {
  let incoming!: ReadableStreamDefaultController<ReadableStream<Uint8Array>>;
  const streams = new ReadableStream<ReadableStream<Uint8Array>>({
    start(controller) {
      incoming = controller;
    },
  });
  return {
    transport: { incomingUnidirectionalStreams: streams } as WebTransport,
    incoming,
    streams,
  };
}
let supportProbe:
  | ((value: VideoDecoderConfig) => Promise<VideoDecoderSupport>)
  | undefined;
function decoder() {
  const oldDecoder = globalThis.VideoDecoder,
    oldChunk = globalThis.EncodedVideoChunk;
  class Decoder {
    static async isConfigSupported(value: VideoDecoderConfig) {
      if (supportProbe) return supportProbe(value);
      return { supported: value.codec !== "bad", config: value };
    }
    state = "unconfigured";
    decodeQueueSize = 0;
    constructor(private callbacks: VideoDecoderInit) {}
    configure() {
      this.state = "configured";
    }
    reset() {}
    close() {
      this.state = "closed";
    }
    async flush() {}
    decode(chunk: EncodedVideoChunk) {
      this.callbacks.output({
        timestamp: chunk.timestamp,
        close() {},
      } as VideoFrame);
    }
  }
  globalThis.VideoDecoder = Decoder as unknown as typeof VideoDecoder;
  globalThis.EncodedVideoChunk = class {
    timestamp: number;
    constructor(value: EncodedVideoChunkInit) {
      this.timestamp = value.timestamp;
    }
  } as typeof EncodedVideoChunk;
  return () => {
    globalThis.VideoDecoder = oldDecoder;
    globalThis.EncodedVideoChunk = oldChunk;
  };
}
test("complete first key waits for fallback configuration and reselected media waits for its new tracks", async () => {
  const restore = decoder(),
    previousWorker = Object.getOwnPropertyDescriptor(globalThis, "Worker");
  Object.defineProperty(globalThis, "Worker", {
    configurable: true,
    value: undefined,
  });
  const source = transport(),
    drawn: string[] = [],
    failures: string[] = [];
  const receiver = new DesktopVideoReceiver(
    source.transport,
    "attach",
    (id) => {
      drawn.push(id);
    },
    () => {},
    (error) => failures.push(error),
  );
  try {
    source.incoming.enqueue(group());
    await tick();
    assert.deepEqual(drawn, []);
    await receiver.configure(config());
    await tick();
    assert.deepEqual(drawn, ["first"]);
    receiver.prepareConfiguration();
    source.incoming.enqueue(group(1));
    source.incoming.enqueue(group(2));
    await tick();
    assert.deepEqual(drawn, ["first"]);
    await receiver.configure(config(2, "second"));
    await tick();
    assert.deepEqual(drawn, ["first", "second"]);
    assert.deepEqual(failures, []);
  } finally {
    receiver.close();
    restore();
    if (previousWorker)
      Object.defineProperty(globalThis, "Worker", previousWorker);
    else Reflect.deleteProperty(globalThis, "Worker");
  }
});
for (const failure of [false, true]) {
  test(`${failure ? "failed configuration" : "close before configuration"} cancels queued stream handles and releases transport`, async () => {
    const restore = decoder(),
      source = transport();
    let cancelled = 0;
    const receiver = new DesktopVideoReceiver(
      source.transport,
      "attach",
      () => assert.fail("must not draw"),
      () => {},
      () => {},
    );
    try {
      source.incoming.enqueue(
        group(
          1,
          () => {
            cancelled++;
          },
          false,
        ),
      );
      await tick();
      if (failure) {
        const bad = config();
        bad.tracks[0]!.codec.codec = "bad";
        await assert.rejects(receiver.configure(bad), /cannot decode/);
      } else receiver.close();
      await tick();
      assert.equal(cancelled, 1);
      assert.equal(source.streams.locked, false);
    } finally {
      receiver.close();
      restore();
    }
  });
}
class WorkerFixture {
  static last: WorkerFixture;
  onmessage?: (event: { data: Record<string, unknown> }) => void;
  sent: { type: string; id?: number; stream?: ReadableStream<Uint8Array> }[] =
    [];
  constructor() {
    WorkerFixture.last = this;
  }
  postMessage(message: {
    type: string;
    id?: number;
    stream?: ReadableStream<Uint8Array>;
  }) {
    this.sent.push(message);
    if (message.type === "init")
      queueMicrotask(() => this.onmessage?.({ data: { type: "ready" } }));
    if (message.type === "close")
      queueMicrotask(() => this.onmessage?.({ data: { type: "closed" } }));
  }
  terminate() {}
}
test("worker receives complete queued key only after configuration acknowledgement", async () => {
  const previous = Object.getOwnPropertyDescriptor(globalThis, "Worker");
  Object.defineProperty(globalThis, "Worker", {
    configurable: true,
    value: WorkerFixture,
  });
  const source = transport();
  let drawn = 0,
    closed = 0;
  const receiver = new DesktopVideoReceiver(
    source.transport,
    "attach",
    () => {
      drawn++;
    },
    () => {},
    (error) => assert.fail(error),
  );
  try {
    source.incoming.enqueue(group());
    const configuring = receiver.configure(config());
    for (
      let i = 0;
      i < 100 &&
      !WorkerFixture.last?.sent.some((message) => message.type === "configure");
      i++
    )
      await new Promise((resolve) => setTimeout(resolve, 0));
    const worker = WorkerFixture.last,
      configure = worker.sent.find((message) => message.type === "configure")!;
    assert.ok(configure);
    assert.equal(
      worker.sent.some((message) => message.type === "stream"),
      false,
    );
    worker.onmessage?.({ data: { type: "configured", id: configure.id } });
    await configuring;
    await tick();
    const streams = worker.sent.filter((message) => message.type === "stream");
    assert.equal(streams.length, 1);
    const reader = streams[0]!.stream!.getReader();
    let bytes = 0;
    for (;;) {
      const next = await reader.read();
      if (next.done) break;
      bytes += next.value.length;
    }
    assert.equal(bytes > 4, true);
    await reader.cancel();
    reader.releaseLock();
    worker.onmessage?.({
      data: {
        type: "frame",
        generation: configure.id,
        id: 1,
        viewportId: "first",
        frame: {
          close() {
            closed++;
          },
        },
        stats: { renderMicros: 0 },
      },
    });
    assert.equal(drawn, 1);
    assert.equal(closed, 1);
  } finally {
    receiver.close();
    if (previous) Object.defineProperty(globalThis, "Worker", previous);
    else Reflect.deleteProperty(globalThis, "Worker");
  }
});

test("stale configuration acknowledgements cannot open a newer prepared gate", async () => {
  const source = transport(),
    gate = new DesktopMediaGate(source.streams);
  const reader = gate.streams.getReader();
  let delivered = false;
  const waiting = reader.read().then((result) => {
    delivered = true;
    return result;
  });
  const old = gate.prepare(),
    newer = gate.prepare();
  source.incoming.enqueue(group());
  gate.release(old);
  await tick();
  assert.equal(delivered, false);
  gate.release(newer);
  const result = await waiting;
  assert.equal(result.done, false);
  await result.value!.cancel();
  gate.close();
  await tick();
  reader.releaseLock();
});

test("restoring installed configuration supersedes an in-flight different engine configuration", async () => {
  const restore = decoder(),
    previousWorker = Object.getOwnPropertyDescriptor(globalThis, "Worker");
  Object.defineProperty(globalThis, "Worker", {
    configurable: true,
    value: undefined,
  });
  const source = transport(),
    drawn: string[] = [];
  const receiver = new DesktopVideoReceiver(
    source.transport,
    "attach",
    (id) => {
      drawn.push(id);
    },
    () => {},
    (error) => assert.fail(error),
  );
  let release!: (value: VideoDecoderSupport) => void;
  const delayed = new Promise<VideoDecoderSupport>((resolve) => {
    release = resolve;
  });
  try {
    const installed = config();
    await receiver.configure(installed);
    supportProbe = async (value) =>
      value.codedWidth === 4 ? delayed : { supported: true, config: value };
    const pending = config(2, "other");
    pending.tracks[0]!.viewport.width = 4;
    const changing = receiver.configure(pending);
    await tick();
    await receiver.configure(installed);
    release({ supported: true, config: { codec: "fixture", codedWidth: 4 } });
    await changing;
    source.incoming.enqueue(group());
    await tick();
    assert.deepEqual(drawn, ["first"]);
  } finally {
    supportProbe = undefined;
    receiver.close();
    restore();
    if (previousWorker)
      Object.defineProperty(globalThis, "Worker", previousWorker);
    else Reflect.deleteProperty(globalThis, "Worker");
  }
});

test("worker restore sends a superseding configure instead of trusting the last committed key", async () => {
  const previous = Object.getOwnPropertyDescriptor(globalThis, "Worker"),
    priorFixture = WorkerFixture.last;
  Object.defineProperty(globalThis, "Worker", {
    configurable: true,
    value: WorkerFixture,
  });
  const source = transport();
  let drawn = 0;
  const receiver = new DesktopVideoReceiver(
    source.transport,
    "attach",
    () => {
      drawn++;
    },
    () => {},
    (error) => assert.fail(error),
  );
  try {
    const installed = receiver.configure(config());
    for (
      let i = 0;
      i < 100 &&
      (WorkerFixture.last === priorFixture ||
        !WorkerFixture.last?.sent.some(
          (message) => message.type === "configure",
        ));
      i++
    )
      await new Promise((resolve) => setTimeout(resolve, 0));
    const worker = WorkerFixture.last;
    const first = worker.sent.find((message) => message.type === "configure")!;
    worker.onmessage?.({ data: { type: "configured", id: first.id } });
    await installed;
    const changing = receiver.configure(config(2, "other"));
    await tick();
    const pending = worker.sent
      .filter((message) => message.type === "configure")
      .at(-1)!;
    const restoring = receiver.configure(config());
    await tick();
    const all = worker.sent.filter((message) => message.type === "configure");
    assert.equal(all.length, 3);
    const latest = all.at(-1)!;
    worker.onmessage?.({ data: { type: "configured", id: latest.id } });
    await restoring;
    worker.onmessage?.({ data: { type: "configured", id: pending.id } });
    await changing;
    const frame = () => ({ close() {} });
    worker.onmessage?.({
      data: {
        type: "frame",
        generation: pending.id,
        id: 1,
        viewportId: "other",
        frame: frame(),
        stats: { renderMicros: 0 },
      },
    });
    assert.equal(drawn, 0);
    worker.onmessage?.({
      data: {
        type: "frame",
        generation: latest.id,
        id: 2,
        viewportId: "first",
        frame: frame(),
        stats: { renderMicros: 0 },
      },
    });
    assert.equal(drawn, 1);
  } finally {
    receiver.close();
    if (previous) Object.defineProperty(globalThis, "Worker", previous);
    else Reflect.deleteProperty(globalThis, "Worker");
  }
});
