import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { decodeCbor, encodeCbor } from "../src/protocol/cbor.ts";
import {
  decodeAttachTerminalSessionReqValue,
  encodeAttachTerminalSessionReqValue,
  decodeTerminalEventValue,
  encodeTerminalEventValue,
} from "../src/protocol/generated/rpc.ts";
// @ts-expect-error Frozen legacy generated JavaScript intentionally has no new types.
import * as legacy from "./fixtures/terminal-legacy-codec.mjs";
const fixture = JSON.parse(
  readFileSync(
    new URL(
      "../../protocol/tests/fixtures/terminal-control-wire.json",
      import.meta.url,
    ),
    "utf8",
  ),
) as Record<string, string>;
const bytes = (name: string) =>
  Uint8Array.from(Buffer.from(fixture[name]!, "hex"));
const hex = (value: Parameters<typeof encodeCbor>[0]) =>
  Buffer.from(encodeCbor(value)).toString("hex");
const request = {
  terminalSessionId: "session",
  viewportCols: 80,
  viewportRows: 24,
  screenSnapshots: true,
};

test("TypeScript request bytes match goldens consumed by actual old/new Rust hosts", () => {
  assert.equal(
    hex(legacy.encodeAttachTerminalSessionReqValue(request)),
    fixture.requestLegacy,
  );
  assert.equal(
    hex(
      encodeAttachTerminalSessionReqValue({ ...request, requestControl: true }),
    ),
    fixture.requestControl,
  );
  assert.equal(
    decodeAttachTerminalSessionReqValue(decodeCbor(bytes("requestLegacy")))
      .requestControl,
    undefined,
  );
  assert.equal(
    decodeAttachTerminalSessionReqValue(decodeCbor(bytes("requestControl")))
      .requestControl,
    true,
  );
});

for (const name of [
  "attachedLegacy",
  "attachedNotAttempted",
  "attachedGranted",
  "attachedRejected",
] as const) {
  test(`actual Rust host ${name} bytes remain decodable by legacy and new TS clients`, () => {
    const value = decodeCbor(bytes(name));
    const old = legacy.decodeTerminalEventValue(value);
    const current = decodeTerminalEventValue(value);
    assert.equal(old.type, "attached");
    assert.equal("controlResult" in old, false);
    assert.equal(current.type, "attached");
    if (current.type !== "attached") throw Error("expected Attached");
    assert.equal(hex(encodeTerminalEventValue(current)), fixture[name]);
    const expected = {
      attachedLegacy: undefined,
      attachedNotAttempted: "notAttempted",
      attachedGranted: "granted",
      attachedRejected: "rejected",
    }[name];
    assert.equal(current.controlResult?.type, expected);
    if (name === "attachedLegacy")
      assert.equal(hex(legacy.encodeTerminalEventValue(old)), fixture[name]);
  });
}
