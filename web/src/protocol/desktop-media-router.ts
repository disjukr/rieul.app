import { decodeCbor } from "./cbor.ts";
import { decodeDesktopMediaObjectValue } from "./generated/rpc.ts";
import { MAX_DESKTOP_OBJECT } from "./desktop-media.ts";

type MediaStream = ReadableStream<Uint8Array>;
type Port = {
  controller: ReadableStreamDefaultController<MediaStream>;
  streams: Set<() => void>;
};
const routers = new WeakMap<WebTransport, MediaRouter>();
const scoped = new WeakMap<WebTransport, string>();
const MAX_STREAMS = 16;
const HEADER_TIMEOUT_MS = 1500;

/** A worker receives only streams already routed by its DOM owner. */
export function desktopMediaSource(
  incoming: ReadableStream<MediaStream>,
  attachId: string,
): WebTransport {
  const transport = { incomingUnidirectionalStreams: incoming } as WebTransport;
  scoped.set(transport, attachId);
  return transport;
}

/** Scope a shared authenticated transport to one currently registered attachment. */
export function desktopMediaPort(transport: WebTransport, attachId: string) {
  if (scoped.get(transport) === attachId) return { transport, close() {} };
  let router = routers.get(transport);
  if (!router) {
    router = new MediaRouter(transport, () => routers.delete(transport));
    routers.set(transport, router);
  }
  const port = router.subscribe(attachId);
  const mediaTransport = desktopMediaSource(port.incoming, attachId);
  return { transport: mediaTransport, close: port.close };
}

class MediaRouter {
  private reader: ReadableStreamDefaultReader<MediaStream>;
  private ports = new Map<string, Port>();
  private pending = new Set<() => void>();
  private stopped = false;
  private classifiers = new Set<Promise<void>>();
  constructor(
    transport: WebTransport,
    private disposed: () => void,
  ) {
    this.reader = transport.incomingUnidirectionalStreams.getReader();
    void this.receive();
  }
  subscribe(attachId: string) {
    if (this.ports.has(attachId))
      throw new Error("Screen attachment already has a media receiver");
    let controller!: Port["controller"];
    const incoming = new ReadableStream<MediaStream>(
      {
        start(c) {
          controller = c;
        },
      },
      { highWaterMark: 0 },
    );
    const port: Port = { controller, streams: new Set() };
    this.ports.set(attachId, port);
    return {
      incoming,
      close: () => {
        if (this.ports.get(attachId) !== port) return;
        this.ports.delete(attachId);
        controller.error(new Error("Screen media receiver closed"));
        for (const cancel of port.streams) cancel();
        if (!this.ports.size) this.stop();
      },
    };
  }
  private stop(error?: unknown) {
    if (this.stopped) return;
    this.stopped = true;
    this.disposed();
    for (const cancel of this.pending) cancel();
    for (const port of this.ports.values()) {
      for (const cancel of port.streams) cancel();
      if (error) port.controller.error(error);
      else port.controller.close();
    }
    this.ports.clear();
    this.reader.releaseLock();
  }
  private async receive() {
    try {
      while (!this.stopped) {
        if (this.classifiers.size >= MAX_STREAMS) {
          await Promise.race(this.classifiers);
          continue;
        }
        const next = await this.reader.read();
        if (next.done) {
          this.stop(new Error("Screen media connection ended"));
          return;
        }
        if (this.stopped) {
          void next.value.cancel().catch(() => {});
          continue;
        }
        const task = this.route(next.value, new Map(this.ports))
          .catch(() => {})
          .finally(() => this.classifiers.delete(task));
        this.classifiers.add(task);
      }
    } catch (error) {
      if (!this.stopped) this.stop(error);
    }
  }
  private async route(stream: MediaStream, eligible: Map<string, Port>) {
    const reader = stream.getReader();
    let port: Port | undefined;
    let finished = false;
    const finish = () => {
      if (finished) return;
      finished = true;
      this.pending.delete(cancel);
      port?.streams.delete(cancel);
    };
    const cancel = () => {
      if (finished) return;
      finish();
      void reader
        .cancel("Screen media route abandoned")
        .catch(() => {})
        .finally(() => {
          try {
            reader.releaseLock();
          } catch {}
        });
    };
    this.pending.add(cancel);
    const timer = setTimeout(cancel, HEADER_TIMEOUT_MS);
    // Allocate at most one 4 MiB prefix per classifier (16 concurrent). Retain
    // only one source-provided remainder by reference, as readDesktopGroup does.
    // Source chunk sizes are transport-owned and may coalesce several objects.
    // Forwarding is pull-driven, with at most 16 live streams per attachment.
    let chunk: Uint8Array = new Uint8Array();
    let offset = 0;
    const read = async (length: number) => {
      const bytes = new Uint8Array(length);
      let written = 0;
      while (written < length) {
        if (offset === chunk.length) {
          const next = await reader.read();
          if (next.done || finished) throw new Error("Truncated screen prefix");
          chunk = next.value;
          offset = 0;
        }
        const n = Math.min(length - written, chunk.length - offset);
        bytes.set(chunk.subarray(offset, offset + n), written);
        offset += n;
        written += n;
      }
      return bytes;
    };
    try {
      const header = await read(4);
      const length = new DataView(header.buffer).getUint32(0);
      if (!length || length > MAX_DESKTOP_OBJECT)
        throw new Error("Screen media prefix limit exceeded");
      const body = await read(length);
      const first = decodeDesktopMediaObjectValue(decodeCbor(body));
      port = eligible.get(first.attachId);
      if (
        finished ||
        this.stopped ||
        !port ||
        this.ports.get(first.attachId) !== port ||
        port.streams.size >= MAX_STREAMS
      )
        throw new Error("Unknown screen attachment");
      clearTimeout(timer);
      this.pending.delete(cancel);
      port.streams.add(cancel);
      let prefix: Uint8Array[] = [header, body];
      const routed = new ReadableStream<Uint8Array>(
        {
          async pull(controller) {
            try {
              if (finished) {
                controller.close();
                return;
              }
              const first = prefix.shift();
              if (first) {
                controller.enqueue(first);
                return;
              }
              if (offset < chunk.length) {
                controller.enqueue(chunk.subarray(offset));
                chunk = new Uint8Array();
                offset = 0;
                return;
              }
              const next = await reader.read();
              if (finished || next.done) {
                finish();
                reader.releaseLock();
                controller.close();
              } else controller.enqueue(next.value);
            } catch (error) {
              cancel();
              controller.error(error);
            }
          },
          cancel() {
            prefix = [];
            cancel();
          },
        },
        { highWaterMark: 0 },
      );
      port.controller.enqueue(routed);
    } catch {
      cancel();
    } finally {
      clearTimeout(timer);
    }
  }
}
