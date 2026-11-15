import { test } from "node:test";
import assert from "node:assert/strict";
import {
  desktopCursorMaxWidth,
  desktopCursorPng,
} from "../src/protocol/desktop-cursor.ts";
test("cursor parser bounds PNG dimensions and rejects alternate formats", () => {
  const bytes = new Uint8Array(24);
  bytes.set([137, 80, 78, 71, 13, 10, 26, 10]);
  const view = new DataView(bytes.buffer);
  view.setUint32(8, 13);
  view.setUint32(12, 0x49484452);
  view.setUint32(16, 32);
  view.setUint32(20, 32);
  assert.deepEqual(desktopCursorPng(bytes), { width: 32, height: 32 });
  view.setUint32(16, 10000);
  assert.equal(desktopCursorPng(bytes), undefined);
  assert.equal(
    desktopCursorPng(new TextEncoder().encode('<svg onload="alert(1)"></svg>')),
    undefined,
  );
  assert.equal(desktopCursorPng(new Uint8Array(128 * 1024 + 1)), undefined);
});

test("cursor CSS bound preserves tall, wide, and square bitmap aspect ratios", () => {
  assert.equal(desktopCursorMaxWidth({ width: 8, height: 80 }), 3.2);
  assert.equal(desktopCursorMaxWidth({ width: 80, height: 8 }), 32);
  assert.equal(desktopCursorMaxWidth({ width: 64, height: 64 }), 32);
});
