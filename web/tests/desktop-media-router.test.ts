import assert from "node:assert/strict";
import test from "node:test";
import {
  desktopMediaPort,
  desktopMediaSource,
  desktopMediaRevision,
  tagDesktopMediaRevision,
} from "../src/protocol/desktop-media-router.ts";
import { encodeCbor } from "../src/protocol/cbor.ts";
import { encodeDesktopMediaObjectValue } from "../src/protocol/generated/rpc.ts";
import { readDesktopGroup } from "../src/protocol/desktop-media.ts";
const tick = () => new Promise((resolve) => setTimeout(resolve, 0));
function bytes(attachId: string, size = 1, objectId = 0) {
  const body = encodeCbor(
    encodeDesktopMediaObjectValue({
      attachId,
      trackId: 1,
      layoutEpoch: 1,
      codecEpoch: 1,
      groupId: 1,
      objectId,
      timestampMicros: objectId + 1,
      keyframe: objectId === 0,
      data: new Uint8Array(size).fill(42),
    }),
  );
  const result = new Uint8Array(body.length + 4);
  new DataView(result.buffer).setUint32(0, body.length);
  result.set(body, 4);
  return result;
}
function setup() {
  let incoming!: ReadableStreamDefaultController<ReadableStream<Uint8Array>>;
  const transport = {
    incomingUnidirectionalStreams: new ReadableStream<
      ReadableStream<Uint8Array>
    >({
      start(c) {
        incoming = c;
      },
    }),
  } as WebTransport;
  return { transport, incoming };
}
function media(id: string, cancel = () => {}) {
  return new ReadableStream<Uint8Array>({
    start(c) {
      c.enqueue(bytes(id));
    },
    cancel,
  });
}
test("two ports receive disjoint attachments; closing one preserves the other and releases final transport lock", async () => {
  const { transport, incoming } = setup();
  const a = desktopMediaPort(transport, "a"),
    b = desktopMediaPort(transport, "b");
  const ar = a.transport.incomingUnidirectionalStreams.getReader(),
    br = b.transport.incomingUnidirectionalStreams.getReader();
  let ac = 0,
    bc = 0,
    unknown = 0;
  incoming.enqueue(media("b", () => bc++));
  incoming.enqueue(media("unknown", () => unknown++));
  incoming.enqueue(media("a", () => ac++));
  const av = (await ar.read()).value!,
    bv = (await br.read()).value!;
  const ag = readDesktopGroup(av, (first) => first),
    bg = readDesktopGroup(bv, (first) => first);
  assert.equal((await ag.next()).value.attachId, "a");
  assert.equal((await bg.next()).value.attachId, "b");
  a.close();
  await tick();
  assert.equal(ac, 1);
  assert.equal(bc, 0);
  assert.equal(unknown, 1);
  incoming.enqueue(media("b", () => bc++));
  const next = (await br.read()).value!;
  assert.ok(next);
  await next.cancel();
  await ag.return(undefined);
  await bg.return(undefined);
  b.close();
  ar.releaseLock();
  br.releaseLock();
  assert.equal(transport.incomingUnidirectionalStreams.locked, false);
});
test("pending prefixes cannot cross replacement registration generations", async () => {
  const { transport, incoming } = setup();
  const keep = desktopMediaPort(transport, "keep");
  const old = desktopMediaPort(transport, "a");
  let source!: ReadableStreamDefaultController<Uint8Array>,
    canceled = 0;
  incoming.enqueue(
    new ReadableStream<Uint8Array>({
      start(c) {
        source = c;
      },
      cancel() {
        canceled++;
      },
    }),
  );
  await tick();
  old.close();
  const fresh = desktopMediaPort(transport, "a");
  source.enqueue(bytes("a"));
  await tick();
  assert.equal(canceled, 1);
  incoming.enqueue(media("a"));
  const reader = fresh.transport.incomingUnidirectionalStreams.getReader();
  await (await reader.read()).value!.cancel();
  fresh.close();
  keep.close();
  reader.releaseLock();
  assert.equal(transport.incomingUnidirectionalStreams.locked, false);
});
test("last unsubscribe cancels incomplete headers and a new single port can reacquire", async () => {
  const { transport, incoming } = setup();
  const old = desktopMediaPort(transport, "a");
  let canceled = 0;
  incoming.enqueue(
    new ReadableStream<Uint8Array>({
      cancel() {
        canceled++;
      },
    }),
  );
  await tick();
  old.close();
  await tick();
  assert.equal(canceled, 1);
  const fresh = desktopMediaPort(transport, "a");
  incoming.enqueue(media("a"));
  const reader = fresh.transport.incomingUnidirectionalStreams.getReader();
  await (await reader.read()).value!.cancel();
  fresh.close();
  reader.releaseLock();
  assert.equal(transport.incomingUnidirectionalStreams.locked, false);
});

test("malformed, oversized and excessive pending prefixes are canceled without delivery", async () => {
  const { transport, incoming } = setup();
  const port = desktopMediaPort(transport, "a");
  let canceled = 0;
  incoming.enqueue(
    new ReadableStream({
      start(c) {
        c.enqueue(new Uint8Array([255, 255, 255, 255]));
      },
      cancel() {
        canceled++;
      },
    }),
  );
  incoming.enqueue(
    new ReadableStream({
      start(c) {
        c.enqueue(new Uint8Array([0, 0, 0, 0]));
      },
      cancel() {
        canceled++;
      },
    }),
  );
  await tick();
  assert.equal(canceled, 2);
  for (let n = 0; n < 16; n++)
    incoming.enqueue(
      new ReadableStream({
        cancel() {
          canceled++;
        },
      }),
    );
  await tick();
  assert.equal(canceled, 2);
  port.close();
  await tick();
  assert.equal(canceled, 18);
  assert.equal(transport.incomingUnidirectionalStreams.locked, false);
});

test("two busy ports retain their independent 16-stream budgets", async () => {
  const { transport, incoming } = setup();
  const a = desktopMediaPort(transport, "a"),
    b = desktopMediaPort(transport, "b");
  let ac = 0,
    bc = 0;
  for (let n = 0; n < 16; n++) incoming.enqueue(media("a", () => ac++));
  for (let n = 0; n < 16; n++) incoming.enqueue(media("b", () => bc++));
  const ar = a.transport.incomingUnidirectionalStreams.getReader(),
    br = b.transport.incomingUnidirectionalStreams.getReader();
  for (let n = 0; n < 16; n++) {
    assert.ok((await ar.read()).value);
    assert.ok((await br.read()).value);
  }
  assert.equal(ac, 0);
  assert.equal(bc, 0);
  incoming.enqueue(media("a", () => ac++));
  await tick();
  assert.equal(ac, 1);
  a.close();
  await tick();
  assert.equal(ac, 17);
  assert.equal(bc, 0);
  b.close();
  ar.releaseLock();
  br.releaseLock();
  await tick();
  assert.equal(bc, 16);
});

test("a large coalesced source chunk is preserved without an object-size chunk restriction", async () => {
  const { transport, incoming } = setup();
  const port = desktopMediaPort(transport, "a");
  const prefix = bytes("a");
  const objects = Array.from({ length: 70 }, (_, i) =>
    bytes("a", 64 * 1024, i + 1),
  );
  const tail = new Uint8Array(
    objects.reduce((sum, object) => sum + object.length, 0),
  );
  let offset = 0;
  for (const object of objects) {
    tail.set(object, offset);
    offset += object.length;
  }
  const coalesced = new Uint8Array(prefix.length + tail.length);
  coalesced.set(prefix);
  coalesced.set(tail, prefix.length);
  incoming.enqueue(
    new ReadableStream({
      start(c) {
        c.enqueue(coalesced);
        c.close();
      },
    }),
  );
  const streams = port.transport.incomingUnidirectionalStreams.getReader();
  const reader = (await streams.read()).value!.getReader();
  assert.deepEqual((await reader.read()).value, prefix.subarray(0, 4));
  assert.deepEqual((await reader.read()).value, prefix.subarray(4));
  assert.deepEqual((await reader.read()).value, tail);
  assert.equal((await reader.read()).done, true);
  reader.releaseLock();
  port.close();
  streams.releaseLock();
});

test("admission revision starts at zero and preserves post-prepare media before configuration", async () => {
  const { transport, incoming } = setup();
  const port = desktopMediaPort(transport, "a");
  assert.equal(port.revision(), 0);
  const reader = port.transport.incomingUnidirectionalStreams.getReader();
  incoming.enqueue(media("a"));
  const first = (await reader.read()).value!;
  assert.equal(desktopMediaRevision(first), 0);
  await first.cancel();
  assert.equal(port.advance(), 1);
  incoming.enqueue(media("a"));
  const prepared = (await reader.read()).value!;
  assert.equal(desktopMediaRevision(prepared), 1);
  await prepared.cancel();
  port.close();
  reader.releaseLock();
  assert.equal(transport.incomingUnidirectionalStreams.locked, false);
});

test("advancing one port invalidates old raw intake without canceling an undecided peer", async () => {
  const { transport, incoming } = setup();
  const a = desktopMediaPort(transport, "a"),
    b = desktopMediaPort(transport, "b");
  let oldA!: ReadableStreamDefaultController<Uint8Array>,
    oldB!: ReadableStreamDefaultController<Uint8Array>;
  let ac = 0,
    bc = 0;
  incoming.enqueue(
    new ReadableStream({
      start(c) {
        oldA = c;
      },
      cancel() {
        ac++;
      },
    }),
  );
  incoming.enqueue(
    new ReadableStream({
      start(c) {
        oldB = c;
      },
      cancel() {
        bc++;
      },
    }),
  );
  await tick();
  a.advance();
  assert.equal(ac, 0);
  assert.equal(bc, 0);
  oldA.enqueue(bytes("a"));
  oldB.enqueue(bytes("b"));
  await tick();
  assert.equal(ac, 1);
  assert.equal(bc, 0);
  const br = b.transport.incomingUnidirectionalStreams.getReader();
  const bs = (await br.read()).value!;
  assert.equal(desktopMediaRevision(bs), 0);
  const bg = readDesktopGroup(bs, (first) => first);
  assert.equal((await bg.next()).value.attachId, "b");
  incoming.enqueue(media("a"));
  const ar = a.transport.incomingUnidirectionalStreams.getReader();
  const as = (await ar.read()).value!;
  assert.equal(desktopMediaRevision(as), 1);
  await as.cancel();
  await bg.return(undefined);
  a.close();
  b.close();
  ar.releaseLock();
  br.releaseLock();
  assert.equal(transport.incomingUnidirectionalStreams.locked, false);
});

test("advance cancels incomplete sole-port intake and supersedes queued and delivered handles", async () => {
  const { transport, incoming } = setup();
  const port = desktopMediaPort(transport, "a");
  let canceled = 0;
  incoming.enqueue(
    new ReadableStream<Uint8Array>({
      cancel() {
        canceled++;
      },
    }),
  );
  await tick();
  port.advance();
  await tick();
  assert.equal(canceled, 1);
  const reader = port.transport.incomingUnidirectionalStreams.getReader();
  incoming.enqueue(media("a", () => canceled++));
  const delivered = (await reader.read()).value!;
  assert.equal(desktopMediaRevision(delivered), 1);
  for (let n = 0; n < 20; n++) {
    incoming.enqueue(media("a", () => canceled++));
    await tick();
    port.advance();
  }
  await tick();
  assert.equal(canceled, 22);
  const deliveredReader = delivered.getReader();
  await assert.rejects(deliveredReader.read(), /admission superseded/);
  deliveredReader.releaseLock();
  incoming.enqueue(media("a"));
  const fresh = (await reader.read()).value!;
  assert.equal(desktopMediaRevision(fresh), 21);
  await fresh.cancel();
  port.close();
  reader.releaseLock();
});

test("scoped gate forwards admission controls and transferred stream metadata can be restored", async () => {
  const { transport } = setup();
  const owner = desktopMediaPort(transport, "a");
  const gate = desktopMediaSource(new ReadableStream(), "a", owner);
  const consumer = desktopMediaPort(gate, "a");
  assert.equal(consumer.advance(), 1);
  assert.equal(owner.revision(), 1);
  consumer.close();
  assert.equal(transport.incomingUnidirectionalStreams.locked, true);
  const transferred = new ReadableStream<Uint8Array>();
  assert.equal(desktopMediaRevision(transferred), undefined);
  tagDesktopMediaRevision(transferred, consumer.revision());
  assert.equal(desktopMediaRevision(transferred), 1);
  owner.close();
  assert.equal(transport.incomingUnidirectionalStreams.locked, false);
});
