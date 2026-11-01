import { createRoot, flush as flushSolid } from "solid-js";
import { test } from "node:test";
import assert from "node:assert/strict";
import { createBunjaStore } from "bunja";
import { nowBunja } from "../src/state/now.ts";

test("clock shares a frame loop, isolates stores and ignores callbacks after final release", () => {
  const originalRequest = globalThis.requestAnimationFrame;
  const originalCancel = globalThis.cancelAnimationFrame;
  const originalNow = Date.now;
  let time = 1123,
    nextId = 0;
  const frames = new Map<number, FrameRequestCallback>();
  globalThis.requestAnimationFrame = (callback) => {
    const id = ++nextId;
    frames.set(id, callback);
    return id;
  };
  globalThis.cancelAnimationFrame = (id) => {
    frames.delete(id);
  };
  Date.now = () => time;
  const store = createBunjaStore({ wrapInstance: (init) => createRoot(init) });
  try {
    const otherStore = createBunjaStore({
      wrapInstance: (init) => createRoot(init),
    });
    const first = store.get(nowBunja, () => undefined as never),
      second = store.get(nowBunja, () => undefined as never),
      other = otherStore.get(nowBunja, () => undefined as never);
    assert.equal(first.value, second.value);
    assert.notEqual(first.value, other.value);
    const releaseFirst = first.mount(),
      releaseSecond = second.mount(),
      releaseOther = other.mount();
    assert.equal(frames.size, 2);
    releaseFirst();
    assert.equal(frames.size, 2);
    const [id, tick] = [...frames.entries()][0];
    frames.delete(id);
    time = 2345;
    tick(0);
    assert.equal((flushSolid(), first.value.nowEverySecond()), 2000);
    assert.equal((flushSolid(), other.value.nowEverySecond()), 1000);
    releaseSecond();
    const remaining = frames.size;
    time = 3456;
    tick(0);
    assert.equal((flushSolid(), first.value.now()), 2345);
    assert.equal(frames.size, remaining);
    releaseOther();
    assert.equal(frames.size, 0);
    otherStore.dispose();
  } finally {
    store.dispose();
    globalThis.requestAnimationFrame = originalRequest;
    globalThis.cancelAnimationFrame = originalCancel;
    Date.now = originalNow;
  }
});
