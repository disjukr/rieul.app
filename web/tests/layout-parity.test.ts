import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import {
  createLayout,
  layoutReducer,
  type LayoutAction,
  type LayoutState,
} from "../src/state/layout.ts";

// Golden sequence recorded from the unchanged published panecake@0.0.1 runtime.
const golden = JSON.parse(
  readFileSync(
    new URL("./fixtures/layout-panecake-0.0.1.json", import.meta.url),
    "utf8",
  ),
) as {
  initial: LayoutState;
  steps: { action: LayoutAction; result: LayoutState }[];
};
test("Solid renderer retains panecake persisted layouts across split, resize, move and close", (context) => {
  let counter = 1;
  context.mock.method(Math, "random", () => counter++ / 1000);
  let layout = createLayout((b) =>
    b.horizontal(
      [b.leaf("A"), b.vertical([b.leaf("B"), b.leaf("C")], [0.3, 0.7])],
      [0.4, 0.6],
    ),
  );
  assert.deepEqual(layout, golden.initial);
  for (const { action, result } of golden.steps) {
    const persisted = JSON.stringify(layout);
    const reloaded = JSON.parse(persisted) as LayoutState;
    layout = layoutReducer(reloaded, action);
    assert.deepEqual(layout, result);
    assert.equal(
      JSON.stringify(reloaded),
      persisted,
      "reducer must not mutate loaded state",
    );
  }
});
