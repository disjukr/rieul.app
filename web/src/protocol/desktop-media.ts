import { decodeCbor } from "./cbor.ts";
import {
  decodeDesktopMediaObjectValue,
  type DesktopMediaObject,
} from "./generated/rpc.ts";

export const MAX_DESKTOP_OBJECT = 4 * 1024 * 1024;
export const MAX_DESKTOP_GROUP = 16 * 1024 * 1024;
export type DesktopTrackEpoch = {
  attachId: string;
  trackId: number;
  layoutEpoch: number;
  codecEpoch: number;
};

/** A negotiated v1 uni stream contains one independently decodable closed GOP. */
export async function* readDesktopGroup(
  readable: ReadableStream<Uint8Array>,
  expected: DesktopTrackEpoch,
): AsyncGenerator<DesktopMediaObject> {
  const reader = readable.getReader();
  let chunk: Uint8Array<ArrayBufferLike> = new Uint8Array();
  let offset = 0;
  let total = 0;
  let count = 0;
  let group: number | undefined;
  let timestamp = 0;
  let complete = false;
  async function read(
    length: number,
    allowEof = false,
  ): Promise<Uint8Array | undefined> {
    // Allocate only after the caller has validated the frame header.
    const result = new Uint8Array(length);
    let written = 0;
    while (written < length) {
      if (offset === chunk.length) {
        const next = await reader.read();
        if (next.done) {
          if (allowEof && written === 0) return undefined;
          throw new Error("Truncated desktop group");
        }
        chunk = next.value;
        offset = 0;
      }
      const n = Math.min(length - written, chunk.length - offset);
      result.set(chunk.subarray(offset, offset + n), written);
      offset += n;
      written += n;
    }
    return result;
  }
  try {
    for (;;) {
      const header = await read(4, true);
      if (!header) {
        if (!count) throw new Error("Empty desktop group");
        complete = true;
        return;
      }
      const length = new DataView(header.buffer).getUint32(0);
      total += length;
      if (
        !length ||
        length > MAX_DESKTOP_OBJECT ||
        total > MAX_DESKTOP_GROUP ||
        count >= 240
      ) {
        throw new Error("Desktop media limit exceeded");
      }
      const body = (await read(length))!;
      const object = decodeDesktopMediaObjectValue(decodeCbor(body));
      if (
        object.attachId !== expected.attachId ||
        object.trackId !== expected.trackId ||
        object.layoutEpoch !== expected.layoutEpoch ||
        object.codecEpoch !== expected.codecEpoch ||
        object.objectId !== count ||
        object.keyframe !== (count === 0) ||
        (group !== undefined && object.groupId !== group) ||
        object.timestampMicros < timestamp ||
        !object.data.length
      ) {
        throw new Error("Desktop group discontinuity");
      }
      group = object.groupId;
      timestamp = object.timestampMicros;
      count++;
      yield object;
    }
  } finally {
    // Reset/cancel abandons the entire GOP, including on downstream decode failure.
    if (!complete)
      await reader.cancel("desktop group abandoned").catch(() => {});
    reader.releaseLock();
  }
}

/** Decoder/render pressure must abandon a group, never accumulate latent frames. */
export class DesktopDecodeBudget {
  private queued = 0;
  private generation = 0;
  private recovering = true;
  constructor(
    private readonly cancelAndRequestKeyframe: () => void,
    readonly maximum = 3,
  ) {
    if (!Number.isInteger(maximum) || maximum < 1 || maximum > 8)
      throw new Error("Invalid decode budget");
  }
  offer(keyframe: boolean): (() => void) | undefined {
    if (this.recovering && !keyframe) return undefined;
    if (this.queued >= this.maximum) {
      this.reset();
      return undefined;
    }
    this.recovering = false;
    this.queued++;
    const generation = this.generation;
    let released = false;
    return () => {
      if (!released && generation === this.generation) this.queued--;
      released = true;
    };
  }
  reset(): void {
    this.generation++;
    this.queued = 0;
    this.recovering = true;
    this.cancelAndRequestKeyframe();
  }
  get queueDepth(): number {
    return this.queued;
  }
}
