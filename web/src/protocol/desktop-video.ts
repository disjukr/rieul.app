import type { DesktopCodec, DesktopConfiguration } from "./generated/rpc.ts";
import { DesktopVideoEngine } from "./desktop-video-engine.ts";
export type { DesktopVideoStats } from "./desktop-video-engine.ts";
/** Client policy only; never infer hardware use from WebCodecs preference hints.
 * The browser currently has no authoritative per-decoder hardware attestation.
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
  const h264 = codecs.filter((c) => /^avc[13]\./.test(c.codec));
  return [...av1, ...h264];
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
            hardwareAcceleration: codec.codec.startsWith("av01.")
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
  private inner?:
    | DesktopVideoEngine
    | import("./desktop-video-worker-client.ts").WorkerVideoReceiver;
  private closed = false;
  private initializing?: import("./desktop-video-worker-client.ts").WorkerVideoReceiver;
  private ready: Promise<void>;
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
  async configure(configuration: DesktopConfiguration): Promise<void> {
    await this.ready;
    if (!this.closed) await this.inner!.configure(configuration);
  }
  close(): void {
    this.closed = true;
    this.initializing?.close();
    this.inner?.close();
  }
}
