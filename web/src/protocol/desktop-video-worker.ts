import { DesktopVideoEngine } from "./desktop-video-engine.ts";
import type { DesktopConfiguration } from "./generated/rpc.ts";
const scope = self as unknown as {
  postMessage: (data: unknown, transfer?: Transferable[]) => void;
  onmessage: ((event: MessageEvent) => void) | null;
};
let engine: DesktopVideoEngine | undefined;
let incoming: ReadableStreamDefaultController<ReadableStream<Uint8Array>>;
let generation = 0,
  configuring = false,
  closed = false,
  frameId = 0;
let configuration: DesktopConfiguration | undefined;
const liveStreams = new Set<ReadableStream<Uint8Array>>();
const ids = new WeakMap<ReadableStream<Uint8Array>, number>();
const frames = new Map<string, VideoFrame>();
const outstanding = new Set<number>();
function clearFrames() {
  for (const frame of frames.values()) frame.close();
  frames.clear();
}
scope.onmessage = async ({ data }) => {
  if (closed) {
    if (data.type === "stream") void data.stream.cancel();
    return;
  }
  if (data.type === "init") {
    if (engine) return;
    if (
      typeof VideoDecoder === "undefined" ||
      typeof OffscreenCanvas === "undefined"
    ) {
      scope.postMessage({ type: "unsupported" });
      return;
    }
    const streams = new ReadableStream<ReadableStream<Uint8Array>>({
      start(controller) {
        incoming = controller;
      },
    });
    engine = new DesktopVideoEngine(
      { incomingUnidirectionalStreams: streams } as WebTransport,
      data.attachId,
      (viewportId, frame) => {
        if (configuring) return;
        frames.get(viewportId)?.close();
        frames.set(viewportId, frame.clone());
      },
      (stats) => {
        if (configuring) return;
        const viewportId = configuration?.tracks.find(
          (t) => t.trackId === stats.trackId,
        )?.viewport.viewportId;
        const frame = viewportId ? frames.get(viewportId) : undefined;
        if (viewportId) frames.delete(viewportId);
        if (!frame) {
          scope.postMessage({ type: "stats", generation, stats });
          return;
        }
        if (outstanding.size >= 3) {
          frame.close();
          scope.postMessage({
            type: "stats",
            generation,
            stats: {
              ...stats,
              objectId: undefined,
              requestKeyframe: true,
              queueDepth: outstanding.size,
            },
          });
          return;
        }
        const id = ++frameId;
        outstanding.add(id);
        scope.postMessage(
          {
            type: "frame",
            id,
            generation,
            viewportId,
            frame,
            stats: {
              ...stats,
              queueDepth: Math.max(stats.queueDepth, outstanding.size - 1),
            },
          },
          [frame],
        );
      },
      (message) => scope.postMessage({ type: "failed", message }),
      (codec) => scope.postMessage({ type: "codecFailed", generation, codec }),
      (stream) => {
        liveStreams.delete(stream);
        scope.postMessage({ type: "streamDone", id: ids.get(stream) });
      },
    );
    scope.postMessage({ type: "ready" });
    return;
  }
  if (data.type === "consumed") {
    outstanding.delete(data.id);
    return;
  }
  if (data.type === "stream") {
    liveStreams.add(data.stream);
    ids.set(data.stream, data.id);
    incoming.enqueue(data.stream);
    return;
  }
  if (data.type === "configure") {
    generation = data.id;
    configuring = true;
    clearFrames();
    try {
      await engine!.configure(data.configuration);
      if (generation === data.id) {
        configuration = data.configuration;
        configuring = false;
      }
      scope.postMessage({ type: "configured", id: data.id });
    } catch (error) {
      if (generation === data.id) configuring = false;
      scope.postMessage({
        type: "configured",
        id: data.id,
        error: error instanceof Error ? error.message : String(error),
      });
    }
    return;
  }
  if (data.type === "close") {
    closed = true;
    clearFrames();
    engine?.close();
    incoming?.close();
    await Promise.allSettled([
      engine?.closedStreams(),
      ...[...liveStreams]
        .filter((s) => !s.locked)
        .map((s) => s.cancel().catch(() => {})),
    ]);
    liveStreams.clear();
    scope.postMessage({ type: "closed" });
  }
};
