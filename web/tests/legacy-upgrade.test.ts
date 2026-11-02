import { test } from "node:test";
import assert from "node:assert/strict";
import {
  decodeLegacyUpdateStatus,
  offersLegacyUpgrade,
  legacyUpgradeProc,
  legacyUpgrade,
} from "../src/protocol/legacy-upgrade.ts";
import { type DaemonInfo, UpdatePhase } from "../src/protocol/generated/rpc.ts";
import {
  type CborValue,
  decodeCbor,
  encodeCbor,
} from "../src/protocol/cbor.ts";
import {
  decodeReqResMessageSequence,
  encodeReqResMessageSequence,
  ReqResMessageKind,
} from "../src/protocol/wire.ts";
const info: DaemonInfo = {
  instanceId: "old",
  os: "macOS Tahoe 26.6.2 64bit",
  version: "0.1.0",
  startedAtMs: 0,
  serverTimeMs: 0,
  supportedProcIds: [64, 65],
};
const value = new Map([
  [1, 5],
  [2, "0.6.16"],
  [3, "0.6.20"],
  [5, true],
] as [number, number | string | boolean][]);
test("legacy capability gate is explicit; new/unknown/partial protocols do not fall back", () => {
  assert.ok(offersLegacyUpgrade(info));
  for (const os of [
    "macos",
    "macOS 64bit",
    "macOS 26.6.2 64bit",
    "macOS Tahoe 26.6.2 64bit",
  ])
    assert.ok(offersLegacyUpgrade({ ...info, os }));
  for (const version of ["0.6.16", "0.6.17", "0.6.18"])
    assert.ok(offersLegacyUpgrade({ ...info, version }));
  for (const change of [
    { version: "0.6.20" },
    { os: "windows" },
    { os: "Windows 11 Pro 64bit" },
    { os: "not macOS" },
    { os: "macOS-malformed" },
    { supportedProcIds: [64] },
    { supportedProcIds: [64, 65, 73] },
    { supportedProcIds: [64, 65, 74] },
    { supportedProcIds: [64, 65, 75] },
    { version: "unknown" },
  ])
    assert.equal(offersLegacyUpgrade({ ...info, ...change }), false);
});
test("exact 0.6.16 status/error schema rejects missing, invalid and ordered responses", () => {
  assert.deepEqual(decodeLegacyUpdateStatus(value), {
    phase: UpdatePhase.Ready,
    currentVersion: "0.6.16",
    targetVersion: "0.6.20",
    reason: undefined,
    canInstall: true,
  });
  for (const bad of [
    null,
    new Map(),
    new Map<number, CborValue>([...value, [6, new Map()]]),
    new Map([...value, [1, 10]]),
    new Map([...value, [5, 1]]),
    new Map([...value, [2, 12]]),
  ])
    assert.throws(() => decodeLegacyUpdateStatus(bad));
  assert.deepEqual(
    legacyUpgradeProc("install").decodeError([
      2,
      new Map([[1, "confirmation"]]),
    ]),
    { type: "confirmationRequired", message: "confirmation" },
  );
});
test("actual unary wire carries only fixed IDs and legacy action/confirmation fields", async () => {
  for (const action of ["status", "check", "install"] as const) {
    let bytes: Uint8Array | undefined;
    const transport = {
      createBidirectionalStream: async () => ({
        writable: new WritableStream<Uint8Array>({
          write(chunk) {
            bytes = chunk;
          },
        }),
        readable: new ReadableStream<Uint8Array>({
          start(c) {
            c.enqueue(
              encodeReqResMessageSequence([
                {
                  kind: ReqResMessageKind.ResponseUnaryOk,
                  payload: encodeCbor(value),
                },
              ]),
            );
            c.close();
          },
        }),
      }),
    } as unknown as WebTransport;
    await legacyUpgrade(transport, action);
    const [request] = decodeReqResMessageSequence(bytes!);
    assert.equal(request.kind, ReqResMessageKind.RequestUnary);
    if (request.kind !== ReqResMessageKind.RequestUnary)
      throw Error("wrong request");
    assert.equal(request.procId, action === "status" ? 64 : 65);
    if (action === "status") assert.equal(request.payload, undefined);
    else
      assert.deepEqual(
        decodeCbor(request.payload!),
        new Map([
          [1, action === "check" ? 1 : 2],
          [2, action === "install"],
        ] as [number, number | boolean][]),
      );
  }
});
