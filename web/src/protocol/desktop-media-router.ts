import { decodeCbor } from "./cbor.ts";
import { decodeDesktopMediaObjectValue } from "./generated/rpc.ts";
import { MAX_DESKTOP_OBJECT } from "./desktop-media.ts";

type MediaStream = ReadableStream<Uint8Array>;
type Port = {
  controller: ReadableStreamDefaultController<MediaStream>;
  streams: Set<() => void>;
  revision: number;
  queued: MediaStream[];
  waiting: boolean;
};
export type DesktopMediaAdmission = {
  revision(): number;
  advance(): number;
};
type Eligibility = Map<string, { port: Port; revision: number }>;
const streamRevisions = new WeakMap<MediaStream, number>();
/** Local intake revision, not a peer-provided wire or authorization field. */
export function desktopMediaRevision(stream: MediaStream): number | undefined {
  return streamRevisions.get(stream);
}
/** Preserve intake identity across a worker transfer of the same stream. */
export function tagDesktopMediaRevision(
  stream: MediaStream,
  revision: number,
): void {
  streamRevisions.set(stream, revision);
}
const routers = new WeakMap<WebTransport, MediaRouter>();
const scoped = new WeakMap<
  WebTransport,
  { attachId: string; admission: DesktopMediaAdmission }
>();
const MAX_STREAMS = 16;
const HEADER_TIMEOUT_MS = 1500;

/** A worker receives only streams already routed by its DOM owner. */
export function desktopMediaSource(
  incoming: ReadableStream<MediaStream>,
  attachId: string,
  admission?: DesktopMediaAdmission,
): WebTransport {
  let revision = 0;
  const transport = { incomingUnidirectionalStreams: incoming } as WebTransport;
  scoped.set(transport, {
    attachId,
    admission: admission ?? {
      revision: () => revision,
      advance: () => ++revision,
    },
  });
  return transport;
}

/** Scope a shared authenticated transport to one currently registered attachment. */
export function desktopMediaPort(transport: WebTransport, attachId: string) {
  const source = scoped.get(transport);
  if (source?.attachId === attachId)
    return {
      transport,
      close() {},
      revision: () => source.admission.revision(),
      advance: () => source.admission.advance(),
    };
  let router = routers.get(transport);
  if (!router) {
    router = new MediaRouter(transport, () => routers.delete(transport));
    routers.set(transport, router);
  }
  const port = router.subscribe(attachId);
  const mediaTransport = desktopMediaSource(port.incoming, attachId, port);
  return {
    transport: mediaTransport,
    close: port.close,
    revision: port.revision,
    advance: port.advance,
  };
}

class MediaRouter {
  private reader: ReadableStreamDefaultReader<MediaStream>;
  private ports = new Map<string, Port>();
  private pending = new Set<{ eligible: Eligibility; cancel: () => void }>();
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
        pull: () => {
          port.waiting = true;
          this.deliver(port);
        },
      },
      { highWaterMark: 0 },
    );
    const port: Port = {
      controller,
      streams: new Set(),
      revision: 0,
      queued: [],
      waiting: false,
    };
    this.ports.set(attachId, port);
    return {
      incoming,
      revision: () => port.revision,
      // Advance before sending selection. Configuration commits adopt this value.
      advance: () => {
        if (this.ports.get(attachId) !== port) return port.revision;
        port.revision++;
        this.invalidate(attachId, port);
        return port.revision;
      },
      close: () => {
        if (this.ports.get(attachId) !== port) return;
        this.ports.delete(attachId);
        controller.error(new Error("Screen media receiver closed"));
        this.invalidate(attachId, port);
        if (!this.ports.size) this.stop();
      },
    };
  }
  private deliver(port: Port) {
    if (!port.waiting || !port.queued.length) return;
    port.waiting = false;
    port.controller.enqueue(port.queued.shift()!);
  }
  private invalidate(attachId: string, port: Port) {
    port.queued = [];
    for (const route of this.pending) {
      if (route.eligible.get(attachId)?.port !== port) continue;
      route.eligible.delete(attachId);
      // Before parsing attachId, a stream may still belong to another port.
      if (!route.eligible.size) route.cancel();
    }
    for (const cancel of port.streams) cancel();
  }
  private stop(error?: unknown) {
    if (this.stopped) return;
    this.stopped = true;
    this.disposed();
    for (const route of this.pending) route.cancel();
    for (const port of this.ports.values()) {
      port.queued = [];
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
        const eligible: Eligibility = new Map(
          [...this.ports].map(([id, port]) => [
            id,
            { port, revision: port.revision },
          ]),
        );
        const task = this.route(next.value, eligible)
          .catch(() => {})
          .finally(() => this.classifiers.delete(task));
        this.classifiers.add(task);
      }
    } catch (error) {
      if (!this.stopped) this.stop(error);
    }
  }
  private async route(stream: MediaStream, eligible: Eligibility) {
    const reader = stream.getReader();
    let port: Port | undefined;
    let finished = false;
    let routedController:
      | ReadableStreamDefaultController<Uint8Array>
      | undefined;
    const pending = { eligible, cancel: () => cancel() };
    const finish = () => {
      if (finished) return;
      finished = true;
      this.pending.delete(pending);
      port?.streams.delete(cancel);
    };
    const cancel = () => {
      if (finished) return;
      finish();
      routedController?.error(new Error("Screen media admission superseded"));
      void reader
        .cancel("Screen media route abandoned")
        .catch(() => {})
        .finally(() => {
          try {
            reader.releaseLock();
          } catch {}
        });
    };
    this.pending.add(pending);
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
      const intake = eligible.get(first.attachId);
      port = intake?.port;
      if (
        finished ||
        this.stopped ||
        !port ||
        this.ports.get(first.attachId) !== port ||
        intake?.revision !== port.revision ||
        port.streams.size >= MAX_STREAMS
      )
        throw new Error("Unknown screen attachment");
      clearTimeout(timer);
      this.pending.delete(pending);
      port.streams.add(cancel);
      let prefix: Uint8Array[] = [header, body];
      const routed = new ReadableStream<Uint8Array>(
        {
          start(controller) {
            routedController = controller;
          },
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
      tagDesktopMediaRevision(routed, intake!.revision);
      port.queued.push(routed);
      this.deliver(port);
    } catch {
      cancel();
    } finally {
      clearTimeout(timer);
    }
  }
}
