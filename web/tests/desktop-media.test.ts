import { test } from "node:test";
import assert from "node:assert/strict";
import { encodeCbor } from "../src/protocol/cbor.ts";
import {
  encodeDesktopMediaObjectValue,
  type DesktopMediaObject,
} from "../src/protocol/generated/rpc.ts";
import {
  readDesktopGroup,
  DesktopDecodeBudget,
} from "../src/protocol/desktop-media.ts";
const first: DesktopMediaObject = {
  attachId: "a",
  trackId: 1,
  layoutEpoch: 1,
  codecEpoch: 1,
  groupId: 2,
  objectId: 0,
  timestampMicros: 100,
  keyframe: true,
  data: new Uint8Array([1, 2, 3]),
};
function encode(o: DesktopMediaObject): Uint8Array {
  const body = encodeCbor(encodeDesktopMediaObjectValue(o));
  const result = new Uint8Array(body.length + 4);
  new DataView(result.buffer).setUint32(0, body.length);
  result.set(body, 4);
  return result;
}
function stream(bytes: Uint8Array, size: number): ReadableStream<Uint8Array> {
  let offset = 0;
  return new ReadableStream({
    pull(c) {
      if (offset === bytes.length) c.close();
      else {
        c.enqueue(bytes.slice(offset, offset + size));
        offset = Math.min(bytes.length, offset + size);
      }
    },
  });
}
test("desktop fake codec traverses chunked transport and preserves group order", async () => {
  const second = {
    ...first,
    objectId: 1,
    keyframe: false,
    timestampMicros: 16_767,
  };
  const a = encode(first),
    b = encode(second),
    bytes = new Uint8Array(a.length + b.length);
  bytes.set(a);
  bytes.set(b, a.length);
  for (const size of [1, 2, 3, 7, 1000]) {
    const objects = [];
    for await (const o of readDesktopGroup(stream(bytes, size), first))
      objects.push(o);
    assert.deepEqual(objects, [first, second]);
  }
});
test("desktop rejects oversized, truncated, stale and delta-first media", async () => {
  for (const bytes of [
    new Uint8Array([255, 255, 255, 255]),
    encode(first).slice(0, -1),
    encode({ ...first, codecEpoch: 2 }),
    encode({ ...first, keyframe: false }),
    encode({ ...first, objectId: 2 }),
  ]) {
    await assert.rejects(async () => {
      for await (const _o of readDesktopGroup(stream(bytes, 3), first)) {
        /* drain */
      }
    });
  }
});
test("decode pressure cancels group and waits for keyframe; stale completions are harmless", () => {
  let canceled = 0;
  const budget = new DesktopDecodeBudget(() => canceled++, 2);
  assert.equal(budget.offer(false), undefined);
  const old = budget.offer(true)!;
  budget.offer(false);
  assert.equal(budget.offer(false), undefined);
  assert.equal(canceled, 1);
  assert.equal(budget.queueDepth, 0);
  assert.equal(budget.offer(false), undefined);
  const next = budget.offer(true)!;
  old();
  assert.equal(budget.queueDepth, 1);
  next();
  next();
  assert.equal(budget.queueDepth, 0);
});

test("desktop CBOR rejects declared allocation bombs and excessive nesting", async () => {
  const { decodeCbor } = await import("../src/protocol/cbor.ts");
  for (const major of [0x5b, 0x7b, 0x9b, 0xbb])
    assert.throws(() =>
      decodeCbor(new Uint8Array([major, ...Array(8).fill(255)])),
    );
  assert.throws(
    () => decodeCbor(new Uint8Array([...Array(1000).fill(0x81), 0xf6])),
    /nesting/,
  );
});

test("media codec matches Rust golden", () => {
  assert.equal(
    Buffer.from(encodeCbor(encodeDesktopMediaObjectValue(first))).toString(
      "hex",
    ),
    "a90161610201030104010502060007186408f50943010203",
  );
});
