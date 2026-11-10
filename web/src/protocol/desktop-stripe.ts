import type { DesktopStripe } from "./generated/rpc.ts";

export function validStripeLayout(
  height: number,
  stripes: DesktopStripe[],
): boolean {
  if (
    !Number.isSafeInteger(height) ||
    height < 2 ||
    height > 2160 ||
    stripes.length < 1 ||
    stripes.length > 2
  )
    return false;
  let end = 0;
  for (const stripe of stripes) {
    if (
      !Number.isSafeInteger(stripe.y) ||
      !Number.isSafeInteger(stripe.height) ||
      stripe.y !== end ||
      stripe.y % 2 ||
      stripe.height < 2 ||
      stripe.height % 2
    )
      return false;
    end += stripe.height;
    if (end > height) return false;
  }
  return end === height;
}
export interface StripePacket {
  index: number;
  keyframe: boolean;
  data: Uint8Array;
}
export function decodeStripeBundle(
  bytes: Uint8Array,
  count: number,
  first: boolean,
): StripePacket[] {
  const bad = () => {
    throw new Error("Invalid screen stripe bundle");
  };
  if (
    count < 1 ||
    count > 2 ||
    bytes.length < 4 ||
    bytes.length > 4 * 1024 * 1024 ||
    bytes[0] !== 82 ||
    bytes[1] !== 83 ||
    bytes[2] !== 2
  )
    return bad();
  const n = bytes[3];
  if (!n || n > count || (first && n !== count)) return bad();
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const packets: StripePacket[] = [];
  let offset = 4,
    previous = -1;
  for (let i = 0; i < n; i++) {
    if (offset + 6 > bytes.length) return bad();
    const index = bytes[offset],
      flags = bytes[offset + 1],
      length = view.getUint32(offset + 2);
    offset += 6;
    if (
      index <= previous ||
      index >= count ||
      flags > 1 ||
      (first && flags !== 1) ||
      !length ||
      offset + length > bytes.length
    )
      return bad();
    const data = bytes.subarray(offset, offset + length);
    if (
      !(
        data[0] === 0 &&
        data[1] === 0 &&
        (data[2] === 1 || (data[2] === 0 && data[3] === 1))
      )
    )
      return bad();
    packets.push({ index, keyframe: flags === 1, data });
    offset += length;
    previous = index;
  }
  if (offset !== bytes.length) return bad();
  return packets;
}
interface Pending {
  timestamp: number;
  wanted: Set<number>;
  frames: Map<number, VideoFrame>;
}
/** One logical frame/ACK, with no visible partial stripe updates. */
export class StripeDecoder {
  private decoders: VideoDecoder[] = [];
  private pending = new Map<number, Pending>();
  private generation = 0;
  private first = true;
  private lastTimestamp = -1;
  private front: OffscreenCanvas;
  private staging: OffscreenCanvas;
  private initialized = false;
  state: CodecState = "unconfigured";
  constructor(
    private width: number,
    private height: number,
    private stripes: DesktopStripe[],
    private callbacks: VideoDecoderInit,
  ) {
    if (
      !validStripeLayout(height, stripes) ||
      width < 2 ||
      width > 3840 ||
      width % 2 ||
      !Number.isSafeInteger(width)
    )
      throw new Error("Invalid screen stripe geometry");
    this.front = new OffscreenCanvas(width, height);
    this.staging = new OffscreenCanvas(width, height);
  }
  get decodeQueueSize() {
    return this.pending.size;
  }
  configure(config: VideoDecoderConfig) {
    if (
      this.state === "closed" ||
      !/^(avc1|hev1)\./.test(config.codec) ||
      config.description
    )
      throw new Error("Unsupported stripe codec configuration");
    this.reset();
    const generation = this.generation;
    try {
      for (const [index, stripe] of this.stripes.entries()) {
        const decoder = new VideoDecoder({
          output: (frame) => this.decoded(generation, index, frame),
          error: (error) => {
            if (generation === this.generation && this.state !== "closed") {
              this.reset();
              this.callbacks.error(error);
            }
          },
        });
        this.decoders.push(decoder);
        decoder.configure({
          ...config,
          codedWidth: this.width,
          codedHeight: stripe.height,
          description: undefined,
        });
      }
      this.state = "configured";
    } catch (error) {
      this.reset();
      throw error;
    }
  }
  decode(chunk: EncodedVideoChunk) {
    if (
      this.state !== "configured" ||
      this.pending.size >= 3 ||
      chunk.timestamp <= this.lastTimestamp
    )
      throw new Error("Screen stripe decoder backpressure or stale frame");
    const bytes = new Uint8Array(chunk.byteLength);
    chunk.copyTo(bytes);
    if (this.first && chunk.type !== "key")
      throw new Error("Screen stripes require an independent group");
    const packets = decodeStripeBundle(bytes, this.stripes.length, this.first);
    const pending: Pending = {
      timestamp: chunk.timestamp,
      wanted: new Set(packets.map((p) => p.index)),
      frames: new Map(),
    };
    this.pending.set(chunk.timestamp, pending);
    this.lastTimestamp = chunk.timestamp;
    this.first = false;
    try {
      for (const p of packets)
        this.decoders[p.index].decode(
          new EncodedVideoChunk({
            type: p.keyframe ? "key" : "delta",
            timestamp: chunk.timestamp,
            data: new Uint8Array(p.data),
          }),
        );
    } catch (error) {
      this.reset();
      throw error;
    }
  }
  private decoded(generation: number, index: number, frame: VideoFrame) {
    const pending = this.pending.get(frame.timestamp);
    if (
      generation !== this.generation ||
      this.state !== "configured" ||
      !pending ||
      !pending.wanted.has(index) ||
      pending.frames.has(index)
    ) {
      frame.close();
      return;
    }
    const stripe = this.stripes[index];
    if (
      frame.displayWidth !== this.width ||
      frame.displayHeight !== stripe.height
    ) {
      frame.close();
      this.reset();
      this.callbacks.error(
        new DOMException("Unexpected stripe dimensions", "DataError"),
      );
      return;
    }
    pending.frames.set(index, frame);
    while (this.pending.size) {
      const first = this.pending.values().next().value!;
      if (first.frames.size !== first.wanted.size) break;
      const context = this.staging.getContext("2d");
      if (!context) {
        this.reset();
        this.callbacks.error(
          new DOMException(
            "Screen composition unavailable",
            "NotSupportedError",
          ),
        );
        return;
      }
      try {
        if (this.initialized) context.drawImage(this.front, 0, 0);
        else context.clearRect(0, 0, this.width, this.height);
        for (const [i, f] of first.frames)
          context.drawImage(f, 0, this.stripes[i].y);
        [this.front, this.staging] = [this.staging, this.front];
        this.initialized = true;
        const composed = new VideoFrame(this.front, {
          timestamp: first.timestamp,
        });
        this.pending.delete(first.timestamp);
        this.callbacks.output(composed);
      } catch (error) {
        this.reset();
        this.callbacks.error(
          error instanceof DOMException
            ? error
            : new DOMException(String(error), "EncodingError"),
        );
        return;
      } finally {
        for (const f of first.frames.values()) f.close();
        first.frames.clear();
      }
    }
  }
  async flush() {
    const generation = this.generation;
    await Promise.all(this.decoders.map((d) => d.flush()));
    if (generation !== this.generation || this.pending.size)
      throw new Error("Incomplete screen stripe group");
  }
  reset() {
    if (this.state === "closed")
      throw new Error("Screen stripe decoder is closed");
    this.generation++;
    for (const d of this.decoders) if (d.state !== "closed") d.close();
    this.decoders = [];
    for (const p of this.pending.values())
      for (const f of p.frames.values()) f.close();
    this.pending.clear();
    this.first = true;
    this.lastTimestamp = -1;
    this.initialized = false;
    this.state = "unconfigured";
  }
  close() {
    if (this.state !== "closed") {
      this.reset();
      this.state = "closed";
      this.front.width =
        this.front.height =
        this.staging.width =
        this.staging.height =
          0;
    }
  }
}
