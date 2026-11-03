import { test } from "node:test";
import assert from "node:assert/strict";
import { desktopModes } from "../src/protocol/desktop-support.ts";
import {
  ProcId,
  DesktopPhysicalDisplayPolicy,
  DesktopKeyboardMode,
  encodeAttachDesktopWithLayoutReqValue,
  decodeAttachDesktopWithLayoutReqValue,
} from "../src/protocol/generated/rpc.ts";
import { encodeCbor, decodeCbor } from "../src/protocol/cbor.ts";

test("legacy Screen daemon retains existing mode without implying custom layout", () => {
  assert.deepEqual(desktopModes([66, 67, 68, 69, 70, 71, 72]), {
    existing: true,
    custom: false,
  });
  assert.deepEqual(desktopModes([66, 104]), { existing: true, custom: false });
  assert.deepEqual(desktopModes([66]), { existing: false, custom: false });
  assert.deepEqual(desktopModes([]), { existing: false, custom: false });
});

test("custom discovery requires its own capability and attach procedures", () => {
  const ids = [
    ProcId.GetDesktopLayoutCapabilities,
    ProcId.AttachDesktopWithLayout,
  ];
  assert.deepEqual(desktopModes(ids), { existing: false, custom: true });
  for (const id of ids) assert.equal(desktopModes([id]).custom, false);
  assert.deepEqual(desktopModes([66, 67, ...ids]), {
    existing: true,
    custom: true,
  });
});

test("custom layout wire roundtrip preserves OS geometry separately from video configuration", () => {
  const request = {
    operationId: "operation-1",
    connection: {
      profile: 1,
      codecs: ["avc1.42001f"],
      mediaUniStreams: true,
      keyboardMode: DesktopKeyboardMode.Physical,
    },
    layout: {
      displays: [
        {
          key: "left",
          bounds: { x: -1920, y: 0, width: 1920, height: 1080 },
          scale: 1,
          refreshMilliHz: 60000,
        },
        {
          key: "main",
          bounds: { x: 0, y: 0, width: 1440, height: 900 },
          scale: 2,
          refreshMilliHz: 60000,
        },
      ],
      primaryDisplayKey: "main",
      physicalDisplays: DesktopPhysicalDisplayPolicy.Keep,
    },
  };
  assert.deepEqual(
    decodeAttachDesktopWithLayoutReqValue(
      decodeCbor(encodeCbor(encodeAttachDesktopWithLayoutReqValue(request))),
    ),
    request,
  );
});
