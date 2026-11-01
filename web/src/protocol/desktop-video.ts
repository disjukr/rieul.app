import type {
  DesktopCodec,
  DesktopConfiguration,
  DesktopMediaObject,
  DesktopTrack,
} from "./generated/rpc.ts";
import { readDesktopGroup } from "./desktop-media.ts";

export async function supportedDesktopCodecs(
  codecs: DesktopCodec[],
): Promise<string[]> {
  if (typeof VideoDecoder === "undefined") return [];
  const supported: string[] = [];
  for (const codec of codecs.slice(0, 16)) {
    try {
      if (
        (
          await VideoDecoder.isConfigSupported({
            codec: codec.codec,
            description: codec.description
              ? new Uint8Array(codec.description)
              : undefined,
            optimizeForLatency: true,
            hardwareAcceleration: "prefer-hardware",
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
interface TrackState {
  track: DesktopTrack;
  config: VideoDecoderConfig;
  decoder: VideoDecoder;
  group: number;
  stream?: ReadableStream<Uint8Array>;
  abort?: AbortController;
  makeDecoder: () => VideoDecoder;
  timings: Map<number, number>;
}
export interface DesktopVideoStats {
  trackId: number;
  codecEpoch: number;
  groupId: number;
  decodeMicros: number;
  renderMicros: number;
  queueDepth: number;
  requestKeyframe: boolean;
}
/** One receiver per shared desktop attachment; canvases may live in several windows. */
export class DesktopVideoReceiver {
  private reader: ReadableStreamDefaultReader<ReadableStream<Uint8Array>>;
  private tracks = new Map<number, TrackState>();
  private streams = new Map<ReadableStream<Uint8Array>, AbortController>();
  private closed = false;
  private layoutEpoch = 0;
  private generation = 0;
  constructor(
    transport: WebTransport,
    private attachId: string,
    private render: (viewportId: string, frame: VideoFrame) => void,
    private stats: (stats: DesktopVideoStats) => void,
    private failed: (message: string) => void,
  ) {
    this.reader = transport.incomingUnidirectionalStreams.getReader();
    void this.receive();
  }
  async configure(configuration: DesktopConfiguration): Promise<void> {
    const generation = ++this.generation;
    if (configuration.tracks.length > 8)
      throw new Error("Too many desktop tracks");
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
          hardwareAcceleration: "prefer-hardware",
        };
        if (!(await VideoDecoder.isConfigSupported(config)).supported)
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
        const decoder = new VideoDecoder({
          output: (frame) => {
            const started = performance.now();
            const timestamp = frame.timestamp;
            try {
              if (
                !this.closed &&
                this.tracks.get(track.trackId) === state &&
                state.decoder === decoder
              )
                this.render(track.viewport.viewportId, frame);
            } finally {
              frame.close();
            }
            if (
              !this.closed &&
              this.tracks.get(track.trackId) === state &&
              state.decoder === decoder
            )
              this.stats({
                trackId: track.trackId,
                codecEpoch: track.codecEpoch,
                groupId: state.group,
                decodeMicros: Math.round(
                  (started - (state.timings.get(timestamp) ?? started)) * 1000,
                ),
                renderMicros: Math.round((performance.now() - started) * 1000),
                queueDepth: decoder.decodeQueueSize,
                requestKeyframe: false,
              });
          },
          error: () => {
            /* The next independent group recreates this decoder. */
          },
        });
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
          continue;
        }
        const controller = new AbortController();
        this.streams.set(stream, controller);
        void this.group(stream, controller).finally(() =>
          this.streams.delete(stream),
        );
      }
      if (!this.closed) this.failed("Desktop media connection ended");
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
          current.decoder.configure(current.config);
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
          throw new Error("Desktop group replaced");
        if (state.decoder.decodeQueueSize >= 3)
          throw new Error("Desktop decoder backpressure");
        const started = performance.now();
        state.timings.set(object.timestampMicros, started);
        state.decoder.decode(
          new EncodedVideoChunk({
            type: object.keyframe ? "key" : "delta",
            timestamp: object.timestampMicros,
            data: new Uint8Array(object.data),
          }),
        );
      }
      if (state && state.group === groupId) {
        let timer: ReturnType<typeof setTimeout>;
        try {
          await Promise.race([
            state.decoder.flush(),
            new Promise<never>((_, reject) => {
              timer = setTimeout(
                () => reject(new Error("Desktop decode timeout")),
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
  private resetTracks(): void {
    for (const state of this.tracks.values()) {
      if (state.decoder.state !== "closed") state.decoder.close();
      state.abort?.abort();
    }
    this.tracks.clear();
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
