import { test } from "node:test";
import assert from "node:assert/strict";
import { procs, ProcId } from "../src/protocol/generated/rpc.ts";
import {
  rpcCategoryById,
  summarizeRpcSupport,
} from "../src/protocol/rpc-support.ts";

test("every current schema RPC belongs to exactly one stable category", () => {
  const result = summarizeRpcSupport([]);
  const ids = result.categories
    .flatMap((category) => category.entries.map((entry) => entry.id))
    .sort((a, b) => a - b);
  assert.deepEqual(
    ids,
    Object.values(procs)
      .map((proc) => proc.id)
      .sort((a, b) => a - b),
  );
  assert.equal(new Set(ids).size, ids.length);
  assert.deepEqual(
    result.categories.map((c) => [c.id, c.total]),
    [
      ["screen", 7],
      ["files", 10],
      ["terminal", 7],
      ["processes", 8],
      ["commands", 7],
      ["schedules", 5],
      ["agents", 19],
      ["updates", 3],
      ["daemon", 28],
    ],
  );
  assert.equal(rpcCategoryById[ProcId.GetDaemonEnvironment], "daemon");
  assert.equal(rpcCategoryById[ProcId.SubscribeTrashItems], "files");
  assert.equal(rpcCategoryById[ProcId.WriteDesktopInput], "screen");
});
test("counts, percentages and complete details share deduplicated advertised support", () => {
  const result = summarizeRpcSupport([
    66,
    66,
    67,
    68,
    7,
    7,
    64,
    64,
    999,
    999,
    NaN,
    -1,
  ]);
  const screen = result.categories.find((c) => c.id === "screen")!;
  assert.equal(screen.supported, 3);
  assert.equal(screen.unsupported, 4);
  assert.equal(screen.percent, 43);
  assert.equal(screen.entries.length, 7);
  for (const category of result.categories) {
    assert.equal(
      category.supported,
      category.entries.filter((e) => e.supported).length,
    );
    assert.equal(
      category.unsupported,
      category.entries.filter((e) => !e.supported).length,
    );
    assert.equal(category.total, category.supported! + category.unsupported!);
  }
  assert.deepEqual(result.unknownIds, [64, 999]);
  assert.equal(
    summarizeRpcSupport(Object.values(procs).map((p) => p.id)).categories.every(
      (c) => c.percent === 100,
    ),
    true,
  );
});
test("unavailable information is unknown while an explicit empty list is zero", () => {
  for (const category of summarizeRpcSupport().categories) {
    assert.equal(category.percent, undefined);
    assert.equal(category.supported, undefined);
    assert.ok(category.entries.every((entry) => entry.supported === undefined));
  }
  assert.ok(summarizeRpcSupport([]).categories.every((c) => c.percent === 0));
});
