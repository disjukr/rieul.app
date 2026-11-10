import type {
  DesktopConfiguration,
  DesktopMediaObject,
  DesktopTrack,
} from "./generated/rpc.ts";
import { StripeDecoder, validStripeLayout } from "./desktop-stripe.ts";
import { readDesktopGroup } from "./desktop-media.ts";
interface TrackState {
  track: DesktopTrack;
  config: VideoDecoderConfig;
  decoder: VideoDecoder | StripeDecoder;
  group: number;
  stream?: ReadableStream<Uint8Array>;
  abort?: AbortController;
  makeDecoder: () => VideoDecoder | StripeDecoder;
  timings: Map<number, { started: number; groupId: number; objectId: number }>;
}
export interface DesktopVideoStats {
  objectId?: number;
  trackId: number;
  codecEpoch: number;
  groupId: number;
  decodeMicros: number;
  renderMicros: number;
  queueDepth: number;
  requestKeyframe: boolean;
}
/** One receiver per shared desktop attachment; canvases may live in several windows. */
export class DesktopVideoEngine {
  private reader: ReadableStreamDefaultReader<ReadableStream<Uint8Array>>;
  private tracks = new Map<number, TrackState>();
  private tasks = new Set<Promise<unknown>>();
  private streams = new Map<ReadableStream<Uint8Array>, AbortController>();
  private closed = false;
  private layoutEpoch = 0;
  private generation = 0;
  constructor(
    transport: WebTransport,
    private attachId: string,
    private render: (viewportId: string, frame: VideoFrame) => boolean | void,
    private stats: (stats: DesktopVideoStats) => void,
    private failed: (message: string) => void,
    private codecFailed?: (codec: string) => void,
    private streamDone?: (stream: ReadableStream<Uint8Array>) => void,
  ) {
    this.reader = transport.incomingUnidirectionalStreams.getReader();
    void this.receive();
  }
  async configure(configuration: DesktopConfiguration): Promise<void> {
    const generation = ++this.generation;
    if (configuration.tracks.length > 8)
      throw new Error("Too many screen tracks");
    if (
      configuration.tracks.reduce(
        (sum, t) =>
          sum + (t.stripes ? t.viewport.width * t.viewport.height : 0),
        0,
      ) >
      32 * 1024 * 1024
    )
      throw new Error("Screen stripe surface budget exceeded");
    const configs = await Promise.all(
      configuration.tracks.map(async (track) => {
        const config: VideoDecoderConfig = {
          codec: track.codec.codec,
          codedWidth: track.viewport.width,
          codedHeight: track.viewport.height,
          description: track.codec.description
            ? new Uint8Array(track.codec.description)
            : undefined,
          optimizeForLatency: true,
          hardwareAcceleration: /^(av01|hev1)\./.test(track.codec.codec)
            ? "prefer-hardware"
            : "no-preference",
        };
        if (
          track.stripes &&
          !validStripeLayout(track.viewport.height, track.stripes)
        )
          throw new Error("Invalid screen stripe layout");
        const regions = track.stripes ?? [
          { y: 0, height: track.viewport.height },
        ];
        if (
          !(
            await Promise.all(
              regions.map((s) =>
                VideoDecoder.isConfigSupported({
                  ...config,
                  codedHeight: s.height,
                }),
              ),
            )
          ).every((r) => r.supported)
        )
          throw new Error(`Browser cannot decode ${track.codec.codec}`);
        return { track, config };
      }),
    );
    if (this.closed || generation !== this.generation) return;
    this.resetTracks();
    this.layoutEpoch = configuration.layoutEpoch;
    for (const { track, config } of configs) {
      const state = {} as TrackState;
      const makeDecoder = () => {
        const callbacks: VideoDecoderInit = {
          output: (frame) => {
            const started = performance.now();
            const timing = state.timings.get(frame.timestamp);
            state.timings.delete(frame.timestamp);
            let rendered = false;
            try {
              if (
                !this.closed &&
                this.tracks.get(track.trackId) === state &&
                state.decoder === decoder &&
                timing?.groupId === state.group
              )
                rendered =
                  this.render(track.viewport.viewportId, frame) !== false;
            } finally {
              frame.close();
            }
            if (
              rendered &&
              !this.closed &&
              this.tracks.get(track.trackId) === state &&
              state.decoder === decoder &&
              timing?.groupId === state.group
            )
              this.stats({
                trackId: track.trackId,
                codecEpoch: track.codecEpoch,
                groupId: timing!.groupId,
                objectId: timing!.objectId,
                decodeMicros: Math.round((started - timing!.started) * 1000),
                renderMicros: Math.round((performance.now() - started) * 1000),
                queueDepth: decoder.decodeQueueSize,
                requestKeyframe: false,
              });
          },
          error: () => {
            if (
              !this.closed &&
              this.tracks.get(track.trackId) === state &&
              state.decoder === decoder
            )
              this.codecFailed?.(track.codec.codec);
          },
        };
        const decoder = track.stripes
          ? new StripeDecoder(
              track.viewport.width,
              track.viewport.height,
              track.stripes,
              callbacks,
            )
          : new VideoDecoder(callbacks);
        return decoder;
      };
      Object.assign(state, {
        track,
        config,
        makeDecoder,
        decoder: makeDecoder(),
        group: 0,
        timings: new Map(),
      });
      this.tracks.set(track.trackId, state);
    }
  }
  private async receive(): Promise<void> {
    try {
      for (;;) {
        const next = await this.reader.read();
        if (next.done) break;
        const stream = next.value;
        if (this.closed || this.streams.size >= 16) {
          void stream.cancel().catch(() => {});
          this.streamDone?.(stream);
          continue;
        }
        const controller = new AbortController();
        this.streams.set(stream, controller);
        const task = this.group(stream, controller).finally(() => {
          this.streams.delete(stream);
          this.streamDone?.(stream);
          this.tasks.delete(task);
        });
        this.tasks.add(task);
      }
      if (!this.closed) this.failed("Screen media connection ended");
    } catch (error) {
      if (!this.closed)
        this.failed(error instanceof Error ? error.message : String(error));
    } finally {
      try {
        this.reader.releaseLock();
      } catch {
        /* already released */
      }
    }
  }
  private async group(
    stream: ReadableStream<Uint8Array>,
    controller: AbortController,
  ): Promise<void> {
    let state: TrackState | undefined;
    let groupId = 0;
    try {
      for await (const object of readDesktopGroup(
        stream,
        (first: DesktopMediaObject) => {
          const current = this.tracks.get(first.trackId);
          if (
            this.closed ||
            first.attachId !== this.attachId ||
            !current ||
            first.codecEpoch !== current.track.codecEpoch ||
            first.layoutEpoch !== this.layoutEpoch ||
            first.groupId <= current.group
          )
            return;
          state = current;
          groupId = first.groupId;
          // The old group may still be flow-controlled; abandon it as one unit.
          if (current.stream && current.stream !== stream)
            current.abort?.abort();
          current.abort = controller;
          current.stream = stream;
          current.group = groupId;
          if (current.decoder.state === "closed")
            current.decoder = current.makeDecoder();
          current.timings.clear();
          current.decoder.reset();
          try {
            current.decoder.configure(current.config);
          } catch (error) {
            this.codecFailed?.(current.track.codec.codec);
            throw error;
          }
          return {
            attachId: this.attachId,
            trackId: first.trackId,
            layoutEpoch: this.layoutEpoch,
            codecEpoch: current.track.codecEpoch,
          };
        },
        controller.signal,
      )) {
        if (
          this.closed ||
          !state ||
          this.tracks.get(object.trackId) !== state ||
          state.group !== groupId
        )
          throw new Error("Screen group replaced");
        if (state.decoder.decodeQueueSize >= 3)
          throw new Error("Screen decoder backpressure");
        const started = performance.now();
        state.timings.set(object.timestampMicros, {
          started,
          groupId,
          objectId: object.objectId,
        });
        try {
          state.decoder.decode(
            new EncodedVideoChunk({
              type: object.keyframe ? "key" : "delta",
              timestamp: object.timestampMicros,
              data: new Uint8Array(object.data),
            }),
          );
        } catch (error) {
          this.codecFailed?.(state.track.codec.codec);
          throw error;
        }
      }
      if (state && state.group === groupId) {
        let timer: ReturnType<typeof setTimeout>;
        try {
          await Promise.race([
            state.decoder.flush(),
            new Promise<never>((_, reject) => {
              timer = setTimeout(
                () => reject(new Error("Screen decode timeout")),
                500,
              );
            }),
          ]);
        } finally {
          clearTimeout(timer!);
        }
      }
    } catch {
      if (
        state &&
        this.tracks.get(state.track.trackId) === state &&
        state.group === groupId &&
        !this.closed
      ) {
        state.timings.clear();
        if (state.decoder.state !== "closed") state.decoder.reset();
        this.stats({
          trackId: state.track.trackId,
          codecEpoch: state.track.codecEpoch,
          groupId,
          decodeMicros: 0,
          renderMicros: 0,
          queueDepth: 0,
          requestKeyframe: true,
        });
      }
    } finally {
      if (state?.stream === stream) state.stream = undefined;
    }
  }
  requestRefresh(viewportId: string): void {
    if (this.closed) return;
    for (const state of this.tracks.values())
      if (state.track.viewport.viewportId === viewportId) {
        this.stats({
          trackId: state.track.trackId,
          codecEpoch: state.track.codecEpoch,
          groupId: state.group,
          decodeMicros: 0,
          renderMicros: 0,
          queueDepth: 0,
          requestKeyframe: true,
        });
      }
  }
  private resetTracks(): void {
    for (const state of this.tracks.values()) {
      if (state.decoder.state !== "closed") state.decoder.close();
      state.abort?.abort();
    }
    this.tracks.clear();
  }
  async closedStreams(): Promise<void> {
    await Promise.allSettled([...this.tasks]);
  }
  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.generation++;
    this.resetTracks();
    // Release ownership without canceling the shared transport's incoming queue.
    try {
      this.reader.releaseLock();
    } catch {
      /* pending read is rejected */
    }
    for (const controller of this.streams.values()) controller.abort();
  }
}
