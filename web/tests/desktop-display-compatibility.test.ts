import { test } from "node:test";
import assert from "node:assert/strict";
import {
  decodeCbor,
  encodeCbor,
  type CborValue,
} from "../src/protocol/cbor.ts";
import {
  decodeDesktopDisplayValue,
  encodeDesktopDisplayValue,
} from "../src/protocol/generated/rpc.ts";

const legacyDisplay = {
  displayId: "1",
  bounds: { x: -1000, y: -25, width: 2000, height: 1600 },
  scale: 2,
  dpi: 200,
};
// Frozen wire layout of DesktopDisplay before arrangement metadata.
const legacyValue = new Map<number, CborValue>([
  [1, "1"],
  [2, new Map([[1, -1000], [2, -25], [3, 2000], [4, 1600]])],
  [3, { type: "f64", value: 2 }],
  [4, { type: "f64", value: 200 }],
]);

test("display metadata without arrangement bounds keeps the legacy wire format", () => {
  const bytes = encodeCbor(legacyValue);
  assert.deepEqual(encodeCbor(encodeDesktopDisplayValue(legacyDisplay)), bytes);
  assert.deepEqual(decodeDesktopDisplayValue(decodeCbor(bytes)), {
    ...legacyDisplay,
    arrangementBounds: undefined,
  });
});

test("display layout preserves fractional and negative coordinates without changing capture bounds", () => {
  const display = {
    ...legacyDisplay,
    arrangementBounds: { x: -1000.5, y: -25.25, width: 1000.5, height: 800.25 },
  };
  const value = decodeCbor(encodeCbor(encodeDesktopDisplayValue(display)));
  assert.deepEqual(decodeDesktopDisplayValue(value), display);
  assert.ok(value instanceof Map);
  assert.ok(value.delete(5));
  assert.deepEqual(value, legacyValue);
});
