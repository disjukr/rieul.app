import { test } from "node:test";
import assert from "node:assert/strict";
import { callServerStream } from "../src/protocol/client.ts";
import { subscribeUpdateStatusProc } from "../src/protocol/generated/rpc.ts";

test("aborting an idle status subscription cancels its pending read and releases locks", async () => {
  let cancelled = 0;
  const sent = Promise.withResolvers<void>();
  const readable = new ReadableStream<Uint8Array>({
    cancel() {
      cancelled++;
    },
  });
  const writable = new WritableStream<Uint8Array>({
    write() {
      sent.resolve();
    },
  });
  const transport = {
    createBidirectionalStream: async () => ({ readable, writable }),
  } as unknown as WebTransport;
  const controller = new AbortController();
  const subscription = callServerStream(
    transport,
    subscribeUpdateStatusProc,
    undefined,
    controller.signal,
  );
  const pending = subscription.next();
  await sent.promise;
  // Let request close finish so this exercises cancellation of an idle read.
  for (let n = 0; n < 10; n++) await Promise.resolve();
  controller.abort();
  assert.equal((await pending).done, true);
  assert.equal(cancelled, 1);
  assert.equal(readable.locked, false);
  assert.equal(writable.locked, false);
});

test("request write failure also disposes the response reader", async () => {
  let cancelled = 0;
  const readable = new ReadableStream<Uint8Array>({
    cancel() {
      cancelled++;
    },
  });
  const writable = new WritableStream<Uint8Array>({
    write() {
      throw new Error("closed");
    },
  });
  const transport = {
    createBidirectionalStream: async () => ({ readable, writable }),
  } as unknown as WebTransport;
  const subscription = callServerStream(
    transport,
    subscribeUpdateStatusProc,
    undefined,
  );
  await assert.rejects(subscription.next(), /closed/);
  assert.equal(cancelled, 1);
  assert.equal(readable.locked, false);
  assert.equal(writable.locked, false);
});

test("already aborted subscription never opens a transport stream", async () => {
  let opened = 0;
  const transport = {
    createBidirectionalStream: async () => {
      opened++;
      throw new Error("unexpected");
    },
  } as unknown as WebTransport;
  const subscription = callServerStream(
    transport,
    subscribeUpdateStatusProc,
    undefined,
    AbortSignal.abort(),
  );
  await assert.rejects(subscription.next());
  assert.equal(opened, 0);
});

test("updater profile rejects missing or invalid ordering instead of accepting generated defaults", async () => {
  const { decodeOrderedUpdateStatus } = await import(
    "../src/protocol/updates.ts"
  );
  const base = new Map<number, import("../src/protocol/cbor.ts").CborValue>([
    [1, 1],
    [5, false],
  ]);
  assert.throws(() => decodeOrderedUpdateStatus(base), /explicit/);
  for (const order of [new Map([[2, 0]]), new Map([[1, "epoch"]])]) {
    base.set(6, order);
    assert.throws(() => decodeOrderedUpdateStatus(base), /explicit/);
  }
  for (const [epoch, revision] of [
    ["", 0],
    ["epoch", -1],
    ["epoch", Number.MAX_SAFE_INTEGER + 1],
  ] as const) {
    base.set(
      6,
      new Map<number, import("../src/protocol/cbor.ts").CborValue>([
        [1, epoch],
        [2, revision],
      ]),
    );
    assert.throws(() => decodeOrderedUpdateStatus(base), /ordering|integer/);
  }
  base.set(
    6,
    new Map<number, import("../src/protocol/cbor.ts").CborValue>([
      [1, "new-epoch"],
      [2, 0],
    ]),
  );
  assert.deepEqual(decodeOrderedUpdateStatus(base).ordering, {
    epoch: "new-epoch",
    revision: 0,
  });
});
