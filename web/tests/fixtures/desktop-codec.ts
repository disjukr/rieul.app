import {
  DesktopVideoReceiver,
  supportedDesktopCodecs,
} from "../../src/protocol/desktop-video.ts";
import { encodeCbor } from "../../src/protocol/cbor.ts";
import { encodeDesktopMediaObjectValue } from "../../src/protocol/generated/rpc.ts";
const result = document.querySelector("output")!;
const canvas = document.querySelector("canvas")!;
let receiver: DesktopVideoReceiver | undefined;
(async () => {
  const bytes = new Uint8Array(
    await (await fetch("./desktop-black.h264")).arrayBuffer(),
  );
  const codec = `avc1.${[...bytes.slice(5, 8)].map((n) => n.toString(16).padStart(2, "0")).join("")}`;
  if (!(await supportedDesktopCodecs([{ codec, hardware: true }])).length) {
    result.textContent = "unsupported";
    return;
  }
  let incoming: ReadableStreamDefaultController<ReadableStream<Uint8Array>>;
  const streams = new ReadableStream<ReadableStream<Uint8Array>>({
    start(c) {
      incoming = c;
    },
  });
  let count = 0;
  receiver = new DesktopVideoReceiver(
    { incomingUnidirectionalStreams: streams } as WebTransport,
    "fixture",
    (_id, frame) => {
      const context = canvas.getContext("2d")!;
      context.drawImage(frame, 0, 0);
      count++;
      result.textContent = JSON.stringify({
        count,
        width: frame.displayWidth,
        height: frame.displayHeight,
        pixel: [...context.getImageData(100, 100, 1, 1).data],
      });
    },
    () => {},
    (error) => {
      result.textContent = error;
    },
  );
  await receiver.configure({
    layoutEpoch: 1,
    totalBitrate: 2_000_000,
    tracks: [
      {
        trackId: 1,
        codecEpoch: 1,
        codec: { codec, hardware: true },
        viewport: {
          viewportId: "v",
          displayId: "synthetic",
          crop: { x: 0, y: 0, width: 640, height: 480 },
          width: 640,
          height: 480,
          fps: 60,
          bitrate: 2_000_000,
        },
      },
    ],
  });
  function group(id: number) {
    const data = encodeCbor(
      encodeDesktopMediaObjectValue({
        attachId: "fixture",
        trackId: 1,
        layoutEpoch: 1,
        codecEpoch: 1,
        groupId: id,
        objectId: 0,
        timestampMicros: id * 16667,
        keyframe: true,
        data: bytes,
      }),
    );
    const packet = new Uint8Array(data.length + 4);
    new DataView(packet.buffer).setUint32(0, data.length);
    packet.set(data, 4);
    incoming.enqueue(
      new ReadableStream({
        start(c) {
          c.enqueue(packet);
          c.close();
        },
      }),
    );
  }
  group(1);
  setTimeout(() => group(2), 100);
})().catch((error) => (result.textContent = String(error)));
window.addEventListener("pagehide", () => receiver?.close());
