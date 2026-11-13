import assert from "node:assert/strict";
import { test } from "node:test";

import { TerminalInputStream } from "../src/view/workbench/tool/terminal/input-stream.ts";

test("interactive terminal input wakes a waiting stream and keeps order", async () => {
  const stream = new TerminalInputStream();
  const reader = stream.read();
  const first = reader.next();
  assert.equal(stream.enqueue(Uint8Array.of(65)), true);
  assert.equal(stream.enqueue(Uint8Array.of(66)), true);
  assert.deepEqual((await first).value, Uint8Array.of(65));
  assert.deepEqual((await reader.next()).value, Uint8Array.of(66));
  const pending = reader.next();
  stream.close();
  assert.equal((await pending).done, true);
});

test("terminal input queue rejects oversized data and discards pending data at detach", async () => {
  const stream = new TerminalInputStream();
  assert.equal(stream.enqueue(new Uint8Array(256 * 1024 + 1)), false);
  const bytes = new Uint8Array(16 * 1024 + 1);
  bytes[16 * 1024] = 42;
  assert.equal(stream.enqueue(bytes), true);
  const reader = stream.read();
  assert.equal((await reader.next()).value?.length, 16 * 1024);
  assert.deepEqual((await reader.next()).value, Uint8Array.of(42));
  assert.equal(stream.enqueue(Uint8Array.of(67)), true);
  stream.close();
  assert.equal(stream.enqueue(Uint8Array.of(68)), false);
  assert.equal((await reader.next()).done, true);
});
