import assert from "node:assert/strict";
import test from "node:test";
import { WorkerVideoReceiver } from "../src/protocol/desktop-video-worker-client.ts";
import type { DesktopConfiguration } from "../src/protocol/generated/rpc.ts";
class FakeWorker {
  static last: FakeWorker;
  onmessage?: ({ data }: { data: any }) => void;
  onerror?: () => void;
  sent: any[] = [];
  terminated = false;
  constructor() {
    FakeWorker.last = this;
  }
  postMessage(data: any) {
    this.sent.push(data);
    if (data.type === "init")
      queueMicrotask(() => this.onmessage?.({ data: { type: "ready" } }));
  }
  terminate() {
    this.terminated = true;
  }
  receive(data: any) {
    this.onmessage?.({ data });
  }
}
const tick = () => new Promise((resolve) => setTimeout(resolve, 0));
test("worker acknowledgements follow actual render, stale frames close, and stream ownership is bounded", async () => {
  const old = Object.getOwnPropertyDescriptor(globalThis, "Worker");
  Object.defineProperty(globalThis, "Worker", {
    configurable: true,
    value: FakeWorker,
  });
  let controller!: ReadableStreamDefaultController<ReadableStream<Uint8Array>>;
  const transport = {
    incomingUnidirectionalStreams: new ReadableStream<
      ReadableStream<Uint8Array>
    >({
      start(c) {
        controller = c;
      },
    }),
  } as WebTransport;
  let rendered = 0,
    stats = 0,
    closed = 0,
    cancelled = 0;
  const receiver = new WorkerVideoReceiver(
    transport,
    "attach",
    () => {
      rendered++;
    },
    () => {
      assert.equal(rendered, 1);
      stats++;
    },
    (message) => assert.fail(message),
  );
  try {
    await receiver.ready;
    receiver.start();
    const configuration = {
      tracks: [],
      layoutEpoch: 1,
      totalBitrate: 1,
    } as DesktopConfiguration;
    const configuring = receiver.configure(configuration);
    await tick();
    const worker = FakeWorker.last;
    const id = worker.sent.find((m) => m.type === "configure").id;
    worker.receive({ type: "configured", id });
    await configuring;
    const frame = () =>
      ({
        close() {
          closed++;
        },
      }) as VideoFrame;
    worker.receive({
      type: "frame",
      generation: id,
      id: 1,
      viewportId: "screen",
      frame: frame(),
      stats: { renderMicros: 0 },
    });
    assert.equal(rendered, 1);
    assert.equal(stats, 1);
    assert.equal(closed, 1);
    assert.deepEqual(worker.sent.at(-1), { type: "consumed", id: 1 });
    worker.receive({
      type: "frame",
      generation: id - 1,
      id: 2,
      viewportId: "screen",
      frame: frame(),
      stats: { renderMicros: 0 },
    });
    assert.equal(rendered, 1);
    assert.equal(stats, 1);
    assert.equal(closed, 2);
    assert.deepEqual(worker.sent.at(-1), { type: "consumed", id: 2 });
    for (let n = 0; n < 17; n++)
      controller.enqueue(
        new ReadableStream<Uint8Array>({
          cancel() {
            cancelled++;
          },
        }),
      );
    await tick();
    assert.equal(worker.sent.filter((m) => m.type === "stream").length, 16);
    assert.equal(cancelled, 1);
    const stream = worker.sent.find((m) => m.type === "stream");
    worker.receive({ type: "streamDone", id: stream.id });
    controller.enqueue(new ReadableStream<Uint8Array>());
    await tick();
    assert.equal(worker.sent.filter((m) => m.type === "stream").length, 17);
    receiver.close();
    assert.equal(worker.terminated, false);
    worker.receive({ type: "closed" });
    assert.ok(worker.terminated);
    const shared = transport.incomingUnidirectionalStreams.getReader();
    shared.releaseLock();
    worker.receive({
      type: "frame",
      generation: id,
      id: 3,
      viewportId: "screen",
      frame: frame(),
      stats: { renderMicros: 0 },
    });
    assert.equal(closed, 3);
    assert.equal(rendered, 1);
  } finally {
    receiver.close();
    if (old) Object.defineProperty(globalThis, "Worker", old);
    else Reflect.deleteProperty(globalThis, "Worker");
  }
});
test("worker reconfiguration supersedes pending replies and close releases the latest waiter", async () => {
  const old = Object.getOwnPropertyDescriptor(globalThis, "Worker");
  Object.defineProperty(globalThis, "Worker", {
    configurable: true,
    value: FakeWorker,
  });
  const transport = {
    incomingUnidirectionalStreams: new ReadableStream(),
  } as WebTransport;
  const receiver = new WorkerVideoReceiver(
    transport,
    "attach",
    () => {},
    () => {},
    () => {},
  );
  try {
    await receiver.ready;
    const config = {
      tracks: [],
      layoutEpoch: 1,
      totalBitrate: 1,
    } as DesktopConfiguration;
    const first = receiver.configure(config);
    await tick();
    const second = receiver.configure({ ...config, layoutEpoch: 2 });
    await tick();
    await first;
    const messages = FakeWorker.last.sent.filter((m) => m.type === "configure");
    FakeWorker.last.receive({
      type: "configured",
      id: messages[0].id,
      error: "late old failure",
    });
    receiver.close();
    await second;
  } finally {
    receiver.close();
    if (old) Object.defineProperty(globalThis, "Worker", old);
    else Reflect.deleteProperty(globalThis, "Worker");
  }
});

test("missing render surface suppresses receipt but releases frame; restoration requests refresh", async () => {
  const old = Object.getOwnPropertyDescriptor(globalThis, "Worker");
  Object.defineProperty(globalThis, "Worker", {
    configurable: true,
    value: FakeWorker,
  });
  let drawn = false,
    receipts = 0,
    closed = 0;
  const receiver = new WorkerVideoReceiver(
    { incomingUnidirectionalStreams: new ReadableStream() } as WebTransport,
    "attach",
    () => drawn,
    () => receipts++,
    assert.fail,
  );
  try {
    await receiver.ready;
    const worker = FakeWorker.last;
    const configure = receiver.configure({
      tracks: [],
      layoutEpoch: 1,
      totalBitrate: 1,
    });
    await tick();
    const id = worker.sent.find((m) => m.type === "configure").id;
    worker.receive({ type: "configured", id });
    await configure;
    const message = {
      type: "frame",
      generation: id,
      id: 1,
      viewportId: "screen",
      frame: {
        close() {
          closed++;
        },
      },
      stats: { renderMicros: 0 },
    };
    worker.receive(message);
    assert.equal(receipts, 0);
    assert.equal(closed, 1);
    assert.deepEqual(worker.sent.at(-1), { type: "consumed", id: 1 });
    drawn = true;
    receiver.requestRefresh("screen");
    assert.deepEqual(worker.sent.at(-1), {
      type: "refresh",
      generation: id,
      viewportId: "screen",
    });
    worker.receive({ ...message, id: 2 });
    assert.equal(receipts, 1);
    assert.equal(closed, 2);
    receiver.close();
    worker.receive({ type: "closed" });
  } finally {
    receiver.close();
    if (old) Object.defineProperty(globalThis, "Worker", old);
    else Reflect.deleteProperty(globalThis, "Worker");
  }
});

test("worker forwards HEVC configuration and only current codec failures", async () => {
  const old = Object.getOwnPropertyDescriptor(globalThis, "Worker");
  Object.defineProperty(globalThis, "Worker", {
    configurable: true,
    value: FakeWorker,
  });
  const failures: string[] = [];
  const receiver = new WorkerVideoReceiver(
    { incomingUnidirectionalStreams: new ReadableStream() } as WebTransport,
    "attach",
    () => {},
    () => {},
    assert.fail,
    (codec) => failures.push(codec),
  );
  const codec = "hev1.1.6.L120.B0";
  try {
    await receiver.ready;
    const configuration: DesktopConfiguration = {
      layoutEpoch: 1,
      totalBitrate: 1000,
      tracks: [
        {
          trackId: 1,
          codecEpoch: 1,
          codec: { codec, hardware: true },
          stripes: [
            { y: 0, height: 32 },
            { y: 32, height: 32 },
          ],
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
    const configuring = receiver.configure(configuration);
    await tick();
    const worker = FakeWorker.last;
    const message = worker.sent.find((m) => m.type === "configure");
    assert.deepEqual(message.configuration, configuration);
    worker.receive({ type: "configured", id: message.id });
    await configuring;
    worker.receive({ type: "codecFailed", generation: message.id - 1, codec });
    assert.deepEqual(failures, []);
    worker.receive({ type: "codecFailed", generation: message.id, codec });
    assert.deepEqual(failures, [codec]);
    receiver.close();
    worker.receive({ type: "closed" });
  } finally {
    receiver.close();
    if (old) Object.defineProperty(globalThis, "Worker", old);
    else Reflect.deleteProperty(globalThis, "Worker");
  }
});
