import { test } from "node:test";
import assert from "node:assert/strict";
import {
  DesktopInputChannel,
  desktopKeyUsage,
  desktopPoint,
} from "../src/protocol/desktop-input.ts";
import { decodeCbor, encodeCbor } from "../src/protocol/cbor.ts";
import {
  decodeDesktopInputFrameValue,
  encodeDesktopInputReceiptValue,
  type DesktopInputFrame,
} from "../src/protocol/generated/rpc.ts";
import {
  decodeReqResMessageSequence,
  encodeReqResMessageSequence,
  ReqResMessageKind,
} from "../src/protocol/wire.ts";
function fixture(receiptOffset = 0) {
  const frames: DesktopInputFrame[] = [];
  let opens = 0,
    canceled = 0;
  const transport = {
    async createBidirectionalStream() {
      opens++;
      let output: ReadableStreamDefaultController<Uint8Array>;
      let lastSequence = 0;
      return {
        readable: new ReadableStream<Uint8Array>({
          start(c) {
            output = c;
          },
          cancel() {
            canceled++;
          },
        }),
        writable: new WritableStream<Uint8Array>({
          write(bytes) {
            const message = decodeReqResMessageSequence(bytes)[0];
            assert.equal(
              message.kind,
              lastSequence
                ? ReqResMessageKind.RequestStreamChunk
                : ReqResMessageKind.RequestStreamStart,
            );
            const frame = decodeDesktopInputFrameValue(
              decodeCbor(message.payload!),
            );
            frames.push(frame);
            lastSequence = frame.sequence;
          },
          close() {
            output.enqueue(
              encodeReqResMessageSequence([
                {
                  kind: ReqResMessageKind.ResponseUnaryOk,
                  payload: encodeCbor(
                    encodeDesktopInputReceiptValue({
                      lastSequence: lastSequence + receiptOffset,
                    }),
                  ),
                },
              ]),
            );
            output.close();
          },
        }),
      };
    },
  } as WebTransport;
  return { transport, frames, opens: () => opens, canceled: () => canceled };
}
test("desktop physical mapping preserves side/keypad and viewport-local scaled coordinates", () => {
  assert.deepEqual(
    [
      "ControlLeft",
      "ControlRight",
      "Enter",
      "NumpadEnter",
      "KeyZ",
      "Numpad0",
    ].map(desktopKeyUsage),
    [224, 228, 40, 88, 29, 98],
  );
  assert.equal(desktopKeyUsage("Unidentified"), undefined);
  assert.deepEqual(
    desktopPoint(
      { left: 10, top: 20, width: 100, height: 50 },
      200,
      100,
      60,
      45,
    ),
    { x: 100, y: 50 },
  );
  assert.equal(
    desktopPoint({ left: 0, top: 0, width: 0, height: 1 }, 1, 1, 0, 0),
    undefined,
  );
});
test("input streams preserve transitions, capture enqueue epochs, and resume sequence after clean close", async () => {
  const f = fixture();
  let epoch = 1;
  const failures: Error[] = [];
  const channel = new DesktopInputChannel(
    f.transport,
    "a",
    () => ({ inputEpoch: epoch, layoutEpoch: 2 }),
    (e) => failures.push(e),
  );
  channel.send({ type: "physicalKey", usage: 224, down: true, repeat: false });
  channel.send({ type: "absolutePointer", viewportId: "v", x: 10, y: 20 });
  channel.send({
    type: "button",
    viewportId: "v",
    x: 10,
    y: 20,
    button: 1,
    down: true,
  });
  epoch = 3;
  channel.send({ type: "absolutePointer", viewportId: "v", x: 30, y: 40 });
  channel.send({ type: "releaseAll" });
  await channel.flush();
  channel.send({ type: "releaseAll" });
  await channel.flush();
  channel.abort();
  assert.deepEqual(
    f.frames.map((f) => f.sequence),
    [1, 2, 3, 4, 5, 6],
  );
  assert.deepEqual(
    f.frames.map((f) => f.inputEpoch),
    [1, 1, 1, 3, 3, 3],
  );
  assert.equal(f.opens(), 2);
  assert.deepEqual(failures, []);
});
test("wrong receipt fails closed without replay", async () => {
  const f = fixture(1);
  const errors: Error[] = [];
  const c = new DesktopInputChannel(
    f.transport,
    "a",
    () => ({ inputEpoch: 1, layoutEpoch: 1 }),
    (e) => errors.push(e),
  );
  c.send({ type: "releaseAll" });
  await c.flush();
  assert.equal(errors.length, 1);
  assert.match(errors[0].message, /receipt/);
  assert.equal(c.send({ type: "releaseAll" }), false);
  assert.equal(f.opens(), 1);
});
test("queue overflow fails once and cancels late-created stream without input replay", async () => {
  const pending = Promise.withResolvers<WebTransportBidirectionalStream>();
  let canceled = 0;
  const errors: Error[] = [];
  const c = new DesktopInputChannel(
    { createBidirectionalStream: () => pending.promise } as WebTransport,
    "a",
    () => ({ inputEpoch: 1, layoutEpoch: 1 }),
    (e) => errors.push(e),
  );
  c.send({ type: "releaseAll" });
  await Promise.resolve();
  for (let i = 0; i < 128; i++) c.send({ type: "releaseAll" });
  pending.resolve({
    readable: new ReadableStream({
      cancel() {
        canceled++;
      },
    }),
    writable: new WritableStream({
      abort() {
        canceled++;
      },
    }),
  });
  await c.flush();
  assert.equal(errors.length, 1);
  assert.equal(canceled, 2);
});
