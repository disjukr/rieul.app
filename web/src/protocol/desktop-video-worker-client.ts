import type { DesktopConfiguration } from "./generated/rpc.ts";
import type { DesktopVideoStats } from "./desktop-video-engine.ts";

export class WorkerVideoReceiver {
  readonly ready: Promise<void>;
  private worker: Worker;
  private closed = false;
  private reader?: ReadableStreamDefaultReader<ReadableStream<Uint8Array>>;
  private generation = 0;
  private sequence = 0;
  private streams = new Set<number>();
  private pending?: {
    id: number;
    resolve: () => void;
    reject: (error: Error) => void;
  };
  private readyReject?: (error: Error) => void;
  private closeTimer?: ReturnType<typeof setTimeout>;
  private timer!: ReturnType<typeof setTimeout>;
  constructor(
    private transport: WebTransport,
    attachId: string,
    private render: (id: string, frame: VideoFrame) => boolean | void,
    private stats: (stats: DesktopVideoStats) => void,
    private failed: (message: string) => void,
    private codecFailed?: (codec: string) => void,
  ) {
    // Probe transfer support before acquiring any authenticated media stream.
    const channel = new MessageChannel();
    try {
      const stream = new ReadableStream({
        start(c) {
          c.close();
        },
      });
      channel.port1.postMessage(stream, [stream]);
    } finally {
      channel.port1.close();
      channel.port2.close();
    }
    this.worker = new Worker(
      new URL("./desktop-video-worker.ts", import.meta.url),
      { type: "module" },
    );
    this.ready = new Promise<void>((resolve, reject) => {
      this.readyReject = reject;
      this.timer = setTimeout(
        () => reject(new Error("Screen worker initialization timed out")),
        1500,
      );
      this.worker.onmessage = ({ data }) => {
        if (data.type === "closed") {
          clearTimeout(this.closeTimer);
          this.worker.terminate();
          return;
        }
        if (data.type === "ready") {
          clearTimeout(this.timer);
          this.readyReject = undefined;
          resolve();
          return;
        }
        if (data.type === "unsupported") {
          reject(new Error("Screen worker APIs unavailable"));
          return;
        }
        if (data.type === "frame") {
          const frame = data.frame as VideoFrame;
          try {
            if (!this.closed && data.generation === this.generation) {
              const start = performance.now();
              if (this.render(data.viewportId, frame) !== false)
                this.stats({
                  ...data.stats,
                  renderMicros:
                    data.stats.renderMicros +
                    Math.round((performance.now() - start) * 1000),
                });
            }
          } catch (error) {
            this.failed(error instanceof Error ? error.message : String(error));
          } finally {
            frame.close();
            if (!this.closed)
              this.worker.postMessage({ type: "consumed", id: data.id });
          }
          return;
        }
        if (this.closed) return;
        if (data.type === "configured" && this.pending?.id === data.id) {
          const pending = this.pending!;
          this.pending = undefined;
          data.error
            ? pending.reject(new Error(data.error))
            : pending.resolve();
        }
        if (data.type === "streamDone") this.streams.delete(data.id);
        if (data.type === "stats" && data.generation === this.generation)
          this.stats(data.stats);
        if (data.type === "codecFailed" && data.generation === this.generation)
          this.codecFailed?.(data.codec);
        if (data.type === "failed") this.failed(data.message);
      };
      this.worker.onerror = (event) => {
        const error = new Error(
          `${event.message || "Screen worker failed"} (${event.filename}:${event.lineno})`,
        );
        this.readyReject?.(error);
        if (!this.readyReject && !this.closed) this.failed(error.message);
        this.pending?.reject(error);
        this.pending = undefined;
      };
    });
    this.worker.postMessage({ type: "init", attachId });
  }
  start(): void {
    if (this.closed) return;
    this.reader = this.transport.incomingUnidirectionalStreams.getReader();
    void this.receive();
  }
  private async receive(): Promise<void> {
    try {
      while (!this.closed) {
        const next = await this.reader!.read();
        if (next.done) {
          if (!this.closed) this.failed("Screen media connection ended");
          break;
        }
        if (this.closed || this.streams.size >= 16) {
          void next.value.cancel().catch(() => {});
          continue;
        }
        const id = ++this.sequence;
        try {
          this.worker.postMessage({ type: "stream", id, stream: next.value }, [
            next.value,
          ]);
          this.streams.add(id);
        } catch (error) {
          void next.value.cancel().catch(() => {});
          throw error;
        }
      }
    } catch (error) {
      if (!this.closed)
        this.failed(error instanceof Error ? error.message : String(error));
    } finally {
      try {
        this.reader?.releaseLock();
      } catch {}
    }
  }
  async configure(configuration: DesktopConfiguration): Promise<void> {
    await this.ready;
    if (this.closed) return;
    this.pending?.resolve();
    const id = ++this.generation;
    return new Promise((resolve, reject) => {
      this.pending = { id, resolve, reject };
      this.worker.postMessage({ type: "configure", id, configuration });
    });
  }
  requestRefresh(viewportId: string): void {
    if (!this.closed)
      this.worker.postMessage({
        type: "refresh",
        generation: this.generation,
        viewportId,
      });
  }
  close(): void {
    if (this.closed) return;
    this.closed = true;
    clearTimeout(this.timer);
    this.readyReject?.(new Error("Screen worker closed"));
    this.readyReject = undefined;
    this.pending?.resolve();
    this.pending = undefined;
    try {
      this.reader?.releaseLock();
    } catch {}
    this.closeTimer = setTimeout(() => this.worker.terminate(), 1000);
    this.worker.postMessage({ type: "close" });
    this.streams.clear();
  }
}
