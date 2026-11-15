import type { DesktopCodec, DesktopConfiguration } from "./generated/rpc.ts";
import { DesktopVideoEngine } from "./desktop-video-engine.ts";
import { DesktopMediaGate } from "./desktop-video-gate.ts";
import {
  desktopMediaPort,
  desktopMediaSource,
} from "./desktop-media-router.ts";
export type { DesktopVideoStats } from "./desktop-video-engine.ts";
/** Client policy only; never infer hardware use from WebCodecs preference hints.
 * The browser currently has no authoritative per-decoder hardware attestation.
 * HEVC uses host hardware evidence plus an actual WebCodecs support probe;
 * prefer-hardware remains only a hint, with runtime H.264 recovery.
 * A future trusted native client may supply device/configuration-specific evidence.
 */
export function desktopCodecOrder(
  codecs: DesktopCodec[],
  hardwareDecoded: ReadonlySet<string> = new Set(),
): DesktopCodec[] {
  const av1 = codecs.filter(
    (c) =>
      c.codec.startsWith("av01.") && c.hardware && hardwareDecoded.has(c.codec),
  );
  const hevc = codecs.filter(
    (c) => /^hev1\./.test(c.codec) && c.hardware && !c.description,
  );
  const h264 = codecs.filter((c) => /^avc[13]\./.test(c.codec));
  return [...hevc, ...av1, ...h264];
}

export async function supportedDesktopCodecs(
  codecs: DesktopCodec[],
  hardwareDecoded: ReadonlySet<string> = new Set(),
): Promise<string[]> {
  if (typeof VideoDecoder === "undefined") return [];
  const supported: string[] = [];
  for (const codec of desktopCodecOrder(codecs.slice(0, 16), hardwareDecoded)) {
    try {
      if (
        (
          await VideoDecoder.isConfigSupported({
            codec: codec.codec,
            description: codec.description
              ? new Uint8Array(codec.description)
              : undefined,
            optimizeForLatency: true,
            hardwareAcceleration: /^(av01|hev1)\./.test(codec.codec)
              ? "prefer-hardware"
              : "no-preference",
          })
        ).supported
      )
        supported.push(codec.codec);
    } catch {
      /* unsupported browser codec */
    }
  }
  return supported;
}
/** Worker owns parsing/decoding/stripe composition; final multi-window canvas
 * drawing stays with its DOM owner. Unsupported worker APIs retain the engine. */
export class DesktopVideoReceiver {
  private mediaPort: ReturnType<typeof desktopMediaPort>;
  private mediaGate: DesktopMediaGate;
  private inner?:
    | DesktopVideoEngine
    | import("./desktop-video-worker-client.ts").WorkerVideoReceiver;
  private closed = false;
  private initializing?: import("./desktop-video-worker-client.ts").WorkerVideoReceiver;
  private ready: Promise<void>;
  private configurationKey = "";
  private activeConfigurations = 0;
  private pendingMediaRevision?: number;
  private configurationMediaRevision = -1;
  private latestConfigurationKey = "";
  workerFailure?: string;
  get execution(): "starting" | "worker" | "main" | "closed" {
    return this.closed
      ? "closed"
      : !this.inner
        ? "starting"
        : this.inner instanceof DesktopVideoEngine
          ? "main"
          : "worker";
  }
  constructor(...args: ConstructorParameters<typeof DesktopVideoEngine>) {
    this.mediaPort = desktopMediaPort(args[0], args[1]);
    this.mediaGate = new DesktopMediaGate(
      this.mediaPort.transport.incomingUnidirectionalStreams,
    );
    args[0] = desktopMediaSource(
      this.mediaGate.streams,
      args[1],
      this.mediaPort,
    );
    this.ready = (async () => {
      let worker:
        | import("./desktop-video-worker-client.ts").WorkerVideoReceiver
        | undefined;
      if (
        typeof Worker !== "undefined" &&
        typeof MessageChannel !== "undefined"
      ) {
        try {
          const { WorkerVideoReceiver } = await import(
            "./desktop-video-worker-client.ts"
          );
          if (this.closed) return;
          worker = new WorkerVideoReceiver(
            ...(args.slice(0, 6) as ConstructorParameters<
              typeof WorkerVideoReceiver
            >),
          );
          this.initializing = worker;
          await worker.ready;
        } catch (error) {
          this.workerFailure =
            error instanceof Error ? error.message : String(error);
          worker?.close();
          worker = undefined;
        }
      }
      if (this.closed) {
        worker?.close();
        return;
      }
      this.initializing = undefined;
      this.inner = worker ?? new DesktopVideoEngine(...args);
      worker?.start();
    })();
  }
  prepareConfiguration(): void {
    if (this.closed) return;
    this.mediaGate.prepare();
    this.pendingMediaRevision = this.mediaPort.advance();
  }
  async configure(configuration: DesktopConfiguration): Promise<void> {
    if (this.closed) return;
    const revision = this.mediaGate.prepare();
    const key = JSON.stringify(configuration);
    const hadPendingConfiguration = this.activeConfigurations++ > 0;
    const mediaRevision =
      this.pendingMediaRevision ??
      (hadPendingConfiguration && key !== this.latestConfigurationKey
        ? this.mediaPort.advance()
        : this.mediaPort.revision());
    this.pendingMediaRevision = undefined;
    this.latestConfigurationKey = key;
    try {
      await this.ready;
      if (this.closed) return;
      if (
        key !== this.configurationKey ||
        hadPendingConfiguration ||
        mediaRevision !== this.configurationMediaRevision
      )
        await this.inner!.configure(configuration, mediaRevision);
      if (this.mediaGate.current(revision)) {
        this.configurationKey = key;
        this.configurationMediaRevision = mediaRevision;
        this.mediaGate.release(revision);
      }
    } catch (error) {
      if (this.mediaGate.current(revision)) {
        this.close();
        throw error;
      }
    } finally {
      this.activeConfigurations--;
    }
  }
  requestRefresh(viewportId: string): void {
    if (!this.closed) this.inner?.requestRefresh(viewportId);
  }
  close(): void {
    this.closed = true;
    this.mediaGate.close();
    this.mediaPort.close();
    this.initializing?.close();
    this.inner?.close();
  }
}
