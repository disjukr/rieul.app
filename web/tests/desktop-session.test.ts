import { RpcError } from "../src/protocol/client.ts";
import {
  RpcErrorKind,
  RpcErrorCode,
  encodeRpcErrorPayloadValue,
} from "../src/protocol/generated/wire.ts";
import { encodeDesktopErrorValue } from "../src/protocol/generated/rpc.ts";
import { test } from "node:test";
import assert from "node:assert/strict";
import { desktopEvents } from "../src/protocol/desktop-session.ts";
import { encodeCbor } from "../src/protocol/cbor.ts";
import {
  DesktopKeyboardMode,
  ProcId,
  encodeDesktopEventValue,
  type DesktopEvent,
} from "../src/protocol/generated/rpc.ts";
import {
  encodeReqResMessageSequence,
  decodeReqResMessageSequence,
  ReqResMessageKind,
} from "../src/protocol/wire.ts";
const request = {
  profile: 1,
  codecs: ["fixture"],
  mediaUniStreams: true,
  keyboardMode: DesktopKeyboardMode.Physical,
};
const event: DesktopEvent = {
  type: "control",
  control: { inputEpoch: 2, holderAttachId: "a" },
};
function fixture(bytes?: Uint8Array) {
  let canceled = 0;
  const writes: Uint8Array[] = [];
  const transport = {
    async createBidirectionalStream() {
      return {
        writable: new WritableStream<Uint8Array>({
          write(bytes) {
            writes.push(bytes);
          },
        }),
        readable: new ReadableStream<Uint8Array>({
          start(c) {
            if (bytes) {
              c.enqueue(bytes);
              c.close();
            }
          },
          cancel() {
            canceled++;
          },
        }),
      };
    },
  } as WebTransport;
  return { transport, writes, canceled: () => canceled };
}
test("bounded desktop events decode ordered messages and cancellation touches only attachment", async () => {
  const bytes = encodeReqResMessageSequence([
    {
      kind: ReqResMessageKind.ResponseStreamStart,
      payload: encodeCbor(encodeDesktopEventValue(event)),
    },
    {
      kind: ReqResMessageKind.ResponseStreamChunk,
      payload: encodeCbor(encodeDesktopEventValue(event)),
    },
  ]);
  const f = fixture(bytes),
    events = [];
  for await (const value of desktopEvents(
    f.transport,
    request,
    new AbortController().signal,
  ))
    events.push(value);
  assert.deepEqual(events, [event, event]);
  const pending = fixture(),
    abort = new AbortController();
  const iterator = desktopEvents(pending.transport, request, abort.signal);
  const next = iterator.next();
  await new Promise((resolve) => setImmediate(resolve));
  abort.abort();
  assert.equal((await next).done, true);
  assert.equal(pending.canceled(), 1);
});
test("events reject truncated, invalid ordering and oversized incomplete envelopes", async () => {
  const bytes = encodeReqResMessageSequence([
    {
      kind: ReqResMessageKind.ResponseStreamChunk,
      payload: encodeCbor(encodeDesktopEventValue(event)),
    },
  ]);
  for (const input of [
    bytes,
    bytes.slice(0, -1),
    new Uint8Array([2, 0x5a, 0, 16, 0, 0, ...new Uint8Array(256 * 1024)]),
  ]) {
    await assert.rejects(async () => {
      for await (const _ of desktopEvents(
        fixture(input).transport,
        request,
        new AbortController().signal,
      )) {
      }
    });
  }
});

test("automatic attach uses its own procedure without a viewport request or fallback", async () => {
  for (const procedure of [
    ProcId.AttachDesktop,
    ProcId.AttachExistingDesktop,
  ] as const) {
    const f = fixture(
      encodeReqResMessageSequence([
        {
          kind: ReqResMessageKind.ResponseStreamStart,
          payload: encodeCbor(encodeDesktopEventValue(event)),
        },
      ]),
    );
    for await (const _ of desktopEvents(
      f.transport,
      request,
      new AbortController().signal,
      procedure,
    )) {
    }
    assert.equal(f.writes.length, 1);
    assert.equal(decodeReqResMessageSequence(f.writes[0])[0].procId, procedure);
  }
});

test("attach stream preserves method permission denial and system authentication rejection", async () => {
  for (const [kind, error, code] of [
    [
      RpcErrorKind.Method,
      encodeDesktopErrorValue({ type: "permissionDenied", message: "denied" }),
      "permissionDenied",
    ],
    [
      RpcErrorKind.System,
      encodeRpcErrorPayloadValue({
        code: RpcErrorCode.Unauthorized,
        message: "expired",
      }),
      "unauthorized",
    ],
  ] as const) {
    const f = fixture(
      encodeReqResMessageSequence([
        {
          kind: ReqResMessageKind.ResponseStreamErrorEnd,
          errorKind: kind,
          error: encodeCbor(error),
        },
      ]),
    );
    const iterator = desktopEvents(
      f.transport,
      request,
      new AbortController().signal,
    );
    await assert.rejects(
      iterator.next(),
      (e: unknown) => e instanceof RpcError && e.code === code,
    );
  }
});
