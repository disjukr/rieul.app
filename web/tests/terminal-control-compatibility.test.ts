import { test } from "node:test";
import assert from "node:assert/strict";
import { encodeCbor, decodeCbor } from "../src/protocol/cbor.ts";
import {
  encodeAttachTerminalSessionReqValue,
  decodeAttachTerminalSessionReqValue,
  encodeTerminalEventValue,
  decodeTerminalEventValue,
  type TerminalEvent,
} from "../src/protocol/generated/rpc.ts";
// @ts-expect-error Frozen generated JavaScript deliberately has no new schema types.
import * as legacy from "./fixtures/terminal-legacy-codec.mjs";

const request = {
  terminalSessionId: "session",
  viewportCols: 80,
  viewportRows: 24,
  screenSnapshots: true,
};
const event: Extract<TerminalEvent, { type: "attached" }> = {
  type: "attached",
  attachId: "attach",
  primaryAttachId: "attach",
  session: {
    terminalSessionId: "session",
    creatorClientId: "client",
    createdAtMs: 0,
    cols: 80,
    rows: 24,
    latestOutputSeq: 0,
    launch: { command: "shell", args: [] },
  },
};
const wire = (value: Parameters<typeof encodeCbor>[0]) =>
  decodeCbor(encodeCbor(value));

test("new request preserves the frozen legacy TypeScript request codec fields", () => {
  const decoded = legacy.decodeAttachTerminalSessionReqValue(
    wire(
      encodeAttachTerminalSessionReqValue({ ...request, requestControl: true }),
    ),
  );
  assert.deepEqual(decoded, { ...request, afterSeq: undefined });
  assert.equal("requestControl" in decoded, false);
});

test("old request and Attached CBOR remain readable by new peers without negotiation", () => {
  assert.deepEqual(
    decodeAttachTerminalSessionReqValue(
      wire(legacy.encodeAttachTerminalSessionReqValue(request)),
    ),
    { ...request, afterSeq: undefined, requestControl: undefined },
  );
  const decoded = decodeTerminalEventValue(
    wire(legacy.encodeTerminalEventValue(event)),
  );
  assert.equal(decoded.type, "attached");
  if (decoded.type !== "attached") throw Error("expected Attached");
  assert.equal(decoded.controlResult, undefined);
  assert.equal(decoded.attachId, "attach");
});

for (const controlResult of [
  { type: "notAttempted" },
  { type: "granted", primaryAttachId: "attach" },
  { type: "rejected", error: { type: "failed", message: "resize rejected" } },
] as const) {
  test(`old clients ignore optional ${controlResult.type} Attached outcome over real CBOR`, () => {
    const bytes = encodeCbor(
      encodeTerminalEventValue({ ...event, controlResult }),
    );
    const old = legacy.decodeTerminalEventValue(decodeCbor(bytes));
    assert.equal(old.type, "attached");
    assert.equal(old.attachId, "attach");
    assert.equal("controlResult" in old, false);
    const current = decodeTerminalEventValue(decodeCbor(bytes));
    assert.equal(current.type, "attached");
    if (current.type !== "attached") throw Error("expected Attached");
    assert.deepEqual(current.controlResult, controlResult);
  });
}
