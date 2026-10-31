import { test } from "node:test";
import assert from "node:assert/strict";
import type { PointerEvent } from "react";
import { createBunjaStore, createReadScopeFn } from "bunja";
import { createStore } from "jotai/vanilla";
import { JotaiStoreScope } from "unsaturated/store";
import { layoutBunja } from "../src/view/state.tsx";

test("layout shares drag ownership and releases listeners and transition timer on final unmount", (t) => {
  const listeners = new Map<string, Set<unknown>>();
  const style = { cursor: "default", userSelect: "text" };
  const globals = {
    document: { body: { style } },
    innerWidth: 1280,
    addEventListener(name: string, callback: unknown) {
      const callbacks = listeners.get(name) ?? new Set();
      callbacks.add(callback);
      listeners.set(name, callbacks);
    },
    removeEventListener(name: string, callback: unknown) {
      listeners.get(name)?.delete(callback);
    },
  };
  for (const [name, value] of Object.entries(globals)) {
    const previous = Object.getOwnPropertyDescriptor(globalThis, name);
    Object.defineProperty(globalThis, name, { configurable: true, value });
    t.after(() => {
      if (previous) Object.defineProperty(globalThis, name, previous);
      else Reflect.deleteProperty(globalThis, name);
    });
  }
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const state = createStore();
  const store = createBunjaStore();
  t.after(() => store.dispose());
  const read = createReadScopeFn([[JotaiStoreScope, state]], () => {
    throw new Error("Unexpected scope");
  });
  const a = store.get(layoutBunja, read),
    b = store.get(layoutBunja, read);
  assert.equal(a.value, b.value);
  const stopA = a.mount(),
    stopB = b.mount();
  const event = {
    preventDefault() {},
    clientX: 10,
  } as PointerEvent<HTMLDivElement>;
  a.value.startMachinePanelResize(event);
  a.value.startMachinePanelResize(event);
  assert.equal(
    listeners.get("pointermove")?.size,
    1,
    "restarting a drag must release its predecessor",
  );
  a.value.toggleMachinePanel();
  assert.equal(state.get(a.value.machinePanelTransitioningAtom), true);
  stopA();
  assert.equal(listeners.get("pointermove")?.size, 1);
  assert.equal(style.cursor, "col-resize");
  stopB();
  for (const callbacks of listeners.values()) assert.equal(callbacks.size, 0);
  assert.deepEqual(style, { cursor: "default", userSelect: "text" });
  assert.equal(state.get(a.value.machinePanelTransitioningAtom), false);
  const writes = t.mock.method(state, "set");
  t.mock.timers.tick(1000);
  assert.equal(
    writes.mock.callCount(),
    0,
    "released timeout must not write to the old instance",
  );
});
