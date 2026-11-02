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
