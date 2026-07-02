export type CborValue =
  | null
  | boolean
  | number
  | CborF64
  | string
  | Uint8Array
  | CborValue[]
  | Map<number, CborValue>;

export interface CborF64 {
  readonly type: "f64";
  readonly value: number;
}

const MAX_SAFE_CBOR_INTEGER = Number.MAX_SAFE_INTEGER;
const MAX_SAFE_NEGATIVE_ARGUMENT = Number.MAX_SAFE_INTEGER - 1;
const TWO_32 = 0x1_0000_0000;
const MAX_SAFE_U64_HIGH = 0x1f_ffff;

export function encodeCbor(value: CborValue): Uint8Array {
  const chunks: number[] = [];
  encode(value, chunks);
  return Uint8Array.from(chunks);
}

export function decodeCbor(bytes: Uint8Array): CborValue {
  const state = { offset: 0 };
  const value = decode(bytes, state);
  if (state.offset !== bytes.length) {
    throw new Error("trailing bytes after CBOR value");
  }
  return value;
}

export function decodeCborSequence(bytes: Uint8Array): CborValue[] {
  const state = { offset: 0 };
  const values: CborValue[] = [];
  while (state.offset !== bytes.length) values.push(decode(bytes, state));
  return values;
}

export interface CborSequencePrefixItem {
  value: CborValue;
  endOffset: number;
}

export function decodeCborSequencePrefix(
  bytes: Uint8Array,
): CborSequencePrefixItem[] {
  const state = { offset: 0 };
  const items: CborSequencePrefixItem[] = [];
  while (state.offset !== bytes.length) {
    const start = state.offset;
    try {
      const value = decode(bytes, state);
      items.push({ value, endOffset: state.offset });
    } catch (err) {
      state.offset = start;
      if (err instanceof Error && err.message === "unexpected end of CBOR") {
        break;
      }
      throw err;
    }
  }
  return items;
}

export function cborF64(value: number): CborF64 {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new Error("expected finite f64");
  }
  return { type: "f64", value };
}

function encode(value: CborValue, out: number[]) {
  if (value === null) out.push(0xf6);
  else if (typeof value === "boolean") out.push(value ? 0xf5 : 0xf4);
  else if (typeof value === "number") {
    if (Number.isSafeInteger(value)) {
      if (value >= 0) encodeTypeValue(0, value, out);
      else encodeTypeValue(1, -1 - value, out);
    } else if (Number.isInteger(value)) {
      throw new Error("CBOR integer is outside safe-integer range");
    } else if (Number.isFinite(value)) {
      encodeFloat64(value, out);
    } else {
      throw new Error("unsupported non-finite CBOR number");
    }
  } else if (typeof value === "string") {
    const bytes = new TextEncoder().encode(value);
    encodeTypeValue(3, bytes.length, out);
    out.push(...bytes);
  } else if (value instanceof Uint8Array) {
    encodeTypeValue(2, value.length, out);
    out.push(...value);
  } else if (Array.isArray(value)) {
    encodeTypeValue(4, value.length, out);
    for (const item of value) encode(item, out);
  } else if (value instanceof Map) {
    const entries = [...value.entries()].sort(([a], [b]) => a - b);
    encodeTypeValue(5, entries.length, out);
    for (const [key, item] of entries) {
      if (!Number.isSafeInteger(key) || key < 0) {
        throw new Error("expected unsigned safe-integer map key");
      }
      encodeTypeValue(0, key, out);
      encode(item, out);
    }
  } else if (isCborF64(value)) {
    encodeFloat64(value.value, out);
  } else {
    throw new Error("unsupported CBOR value");
  }
}

function isCborF64(value: object): value is CborF64 {
  return "type" in value && value.type === "f64" &&
    "value" in value && typeof value.value === "number";
}

function encodeFloat64(value: number, out: number[]) {
  out.push(0xfb);
  const view = new DataView(new ArrayBuffer(8));
  view.setFloat64(0, value, false);
  for (let i = 0; i < 8; i++) out.push(view.getUint8(i));
}

function encodeTypeValue(major: number, value: number, out: number[]) {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error("expected unsigned safe integer");
  }
  const prefix = major << 5;
  if (value < 24) out.push(prefix | value);
  else if (value <= 0xff) out.push(prefix | 24, value);
  else if (value <= 0xffff) {
    out.push(prefix | 25, value >> 8, value & 0xff);
  } else if (value <= 0xffffffff) out.push(prefix | 26, ...be(value, 4));
  else out.push(prefix | 27, ...be(value, 8));
}

function decode(bytes: Uint8Array, state: { offset: number }): CborValue {
  const initial = read(bytes, state);
  const major = initial >> 5;
  const additional = initial & 0x1f;
  if (major === 0) return readArg(bytes, state, additional);
  if (major === 1) return -1 - readNegativeArg(bytes, state, additional);
  if (major === 2) {
    const len = readArg(bytes, state, additional);
    return readBytes(bytes, state, len);
  }
  if (major === 3) {
    const len = readArg(bytes, state, additional);
    return new TextDecoder("utf-8", { fatal: true }).decode(
      readBytes(bytes, state, len),
    );
  }
  if (major === 4) {
    const len = readArg(bytes, state, additional);
    return Array.from({ length: len }, () => decode(bytes, state));
  }
  if (major === 5) {
    const len = readArg(bytes, state, additional);
    const map = new Map<number, CborValue>();
    for (let i = 0; i < len; i++) {
      const key = decode(bytes, state);
      if (typeof key !== "number" || !Number.isSafeInteger(key) || key < 0) {
        throw new Error("expected unsigned safe-integer map key");
      }
      if (map.has(key)) {
        throw new Error("duplicate CBOR map key");
      }
      map.set(key, decode(bytes, state));
    }
    return map;
  }
  if (major === 7) {
    if (additional === 20) return false;
    if (additional === 21) return true;
    if (additional === 22) return null;
    if (additional === 27) {
      if (state.offset + 8 > bytes.length) {
        throw new Error("unexpected end of CBOR");
      }
      const view = new DataView(
        bytes.buffer,
        bytes.byteOffset + state.offset,
        8,
      );
      state.offset += 8;
      return cborF64(view.getFloat64(0, false));
    }
  }
  throw new Error("unsupported CBOR value");
}

function readArg(
  bytes: Uint8Array,
  state: { offset: number },
  additional: number,
): number {
  if (additional < 24) return additional;
  if (additional === 24) return read(bytes, state);
  if (additional === 25) return readFixedUint(bytes, state, 2);
  if (additional === 26) return readFixedUint(bytes, state, 4);
  if (additional === 27) return readU64AsU53(bytes, state);
  throw new Error("unsupported CBOR length");
}

function readNegativeArg(
  bytes: Uint8Array,
  state: { offset: number },
  additional: number,
): number {
  const value = readArg(bytes, state, additional);
  if (value > MAX_SAFE_NEGATIVE_ARGUMENT) {
    throw new Error("CBOR integer is outside safe-integer range");
  }
  return value;
}

function readFixedUint(
  bytes: Uint8Array,
  state: { offset: number },
  len: number,
): number {
  let value = 0;
  for (let i = 0; i < len; i++) {
    value = value * 256 + read(bytes, state);
  }
  return value;
}

function readU64AsU53(bytes: Uint8Array, state: { offset: number }): number {
  const high = readFixedUint(bytes, state, 4);
  const low = readFixedUint(bytes, state, 4);
  if (high > MAX_SAFE_U64_HIGH) {
    throw new Error("CBOR integer is outside safe-integer range");
  }
  return safeUnsigned(high * TWO_32 + low);
}

function safeUnsigned(value: number): number {
  if (value > MAX_SAFE_CBOR_INTEGER) {
    throw new Error("CBOR integer is outside safe-integer range");
  }
  return value;
}

function readBytes(
  bytes: Uint8Array,
  state: { offset: number },
  len: number,
): Uint8Array {
  if (state.offset + len > bytes.length) {
    throw new Error("unexpected end of CBOR");
  }
  const start = state.offset;
  state.offset += len;
  return bytes.slice(start, state.offset);
}

function read(bytes: Uint8Array, state: { offset: number }): number {
  if (state.offset >= bytes.length) throw new Error("unexpected end of CBOR");
  return bytes[state.offset++]!;
}

function be(value: number, len: number): number[] {
  let remaining = value;
  const out = Array<number>(len);
  for (let i = len - 1; i >= 0; i--) {
    out[i] = remaining % 256;
    remaining = Math.floor(remaining / 256);
  }
  return out;
}
