import { test } from "node:test";
import assert from "node:assert/strict";
import { createBunjaStore, createReadScopeFn } from "bunja";
import { createStore } from "jotai/vanilla";
import { nowBunja } from "../src/state/now.ts";
import { JotaiStoreScope } from "../src/state/jotai-store.ts";

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
  const store = createBunjaStore();
  try {
    const a = createStore(),
      b = createStore();
    const aRead = createReadScopeFn([[JotaiStoreScope, a]], () => {
      throw new Error("missing scope");
    });
    const bRead = createReadScopeFn([[JotaiStoreScope, b]], () => {
      throw new Error("missing scope");
    });
    const first = store.get(nowBunja, aRead),
      second = store.get(nowBunja, aRead),
      other = store.get(nowBunja, bRead);
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
    assert.equal(a.get(first.value.nowEverySecondAtom), 2000);
    assert.equal(b.get(other.value.nowEverySecondAtom), 1000);
    releaseSecond();
    const remaining = frames.size;
    time = 3456;
    tick(0);
    assert.equal(a.get(first.value.nowAtom), 2345);
    assert.equal(frames.size, remaining);
    releaseOther();
    assert.equal(frames.size, 0);
  } finally {
    store.dispose();
    globalThis.requestAnimationFrame = originalRequest;
    globalThis.cancelAnimationFrame = originalCancel;
    Date.now = originalNow;
  }
});
