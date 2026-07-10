import {
  type CborValue,
  decodeCbor,
  decodeCborSequencePrefix,
  encodeCbor,
} from "./cbor.ts";

export const IPC_PROC_SHOW_PAIRING_CODE = 1;
export const IPC_PROC_CONFIRM_PAIRING = 2;
export const IPC_PROC_SHOW_DAEMON_INFO = 3;
export const IPC_PROC_ACTIVATE_GUI = 4;
export const IPC_PROC_PAIRING_COMPLETED = 6;

export interface SocketUnaryRequest {
  payload?: Uint8Array;
  procId: number;
  streamId: number;
}

export interface ShowPairingCodeReq {
  daemonUrl: string;
  expiresInSeconds: number;
  pairingCode: string;
}

export interface ConfirmPairingReq {
  clientLabel: string;
  confirmationCode: string;
  daemonUrl: string;
}

export interface ShowDaemonInfoReq {
  configPath: string;
  daemonUrl: string;
}

export interface ActivateGuiReq {
  reason: string;
}

interface SocketRequestUnaryMessage extends SocketUnaryRequest {
  kind: "requestUnary";
}

interface SocketRequestStreamEndMessage {
  kind: "requestStreamEnd";
  streamId: number;
}

type SocketRequestMessage =
  | SocketRequestUnaryMessage
  | SocketRequestStreamEndMessage;

const SOCKET_KIND_REQUEST_UNARY = 0;
const SOCKET_KIND_RESPONSE_UNARY_OK = 3;
const SOCKET_KIND_RESPONSE_UNARY_ERROR = 4;
const SOCKET_KIND_REQUEST_STREAM_END = 100;
const SOCKET_KIND_RESPONSE_STREAM_END = 101;
const SOCKET_RPC_ERROR_KIND_METHOD = 2;

export function decodeSocketUnaryRequestPrefix(
  bytes: Uint8Array,
): SocketUnaryRequest | undefined {
  const items = decodeCborSequencePrefix(bytes);
  const pairCount = Math.floor(items.length / 2);
  let request: SocketUnaryRequest | undefined;

  for (let index = 0; index < pairCount * 2; index += 2) {
    const message = decodeSocketRequestMessage(
      items[index]!.value,
      items[index + 1]!.value,
    );
    if (message.kind === "requestUnary") {
      if (request) {
        throw new Error("IPC stream sent more than one unary request");
      }
      request = message;
    } else if (message.kind === "requestStreamEnd") {
      if (!request) throw new Error("IPC stream ended before unary request");
      if (request.streamId !== message.streamId) {
        throw new Error("IPC request stream id mismatch");
      }
      return request;
    }
  }

  return undefined;
}

export function encodeSocketUnaryOkResponse(
  streamId: number,
  payload?: Uint8Array,
): Uint8Array {
  return concat([
    encodeSocketMessage(
      SOCKET_KIND_RESPONSE_UNARY_OK,
      fields([
        [2, payload],
        [100, streamId],
      ]),
    ),
    encodeSocketMessage(
      SOCKET_KIND_RESPONSE_STREAM_END,
      fields([[100, streamId]]),
    ),
  ]);
}

export function encodeSocketUnaryRequest(
  streamId: number,
  procId: number,
  payload?: Uint8Array,
): Uint8Array {
  return concat([
    encodeSocketMessage(
      SOCKET_KIND_REQUEST_UNARY,
      fields([
        [1, procId],
        [2, payload],
        [100, streamId],
      ]),
    ),
    encodeSocketMessage(
      SOCKET_KIND_REQUEST_STREAM_END,
      fields([[100, streamId]]),
    ),
  ]);
}

export function encodeSocketUnaryErrorResponse(
  streamId: number,
  message: string,
): Uint8Array {
  return concat([
    encodeSocketMessage(
      SOCKET_KIND_RESPONSE_UNARY_ERROR,
      fields([
        [3, encodeIpcProcError(message)],
        [4, SOCKET_RPC_ERROR_KIND_METHOD],
        [100, streamId],
      ]),
    ),
    encodeSocketMessage(
      SOCKET_KIND_RESPONSE_STREAM_END,
      fields([[100, streamId]]),
    ),
  ]);
}

export function decodeShowPairingCodeReq(
  payload: Uint8Array,
): ShowPairingCodeReq {
  const value = expectMap(decodeCbor(payload));
  return {
    daemonUrl: fieldText(value, 1),
    pairingCode: fieldText(value, 2),
    expiresInSeconds: fieldNumber(value, 3),
  };
}

export function decodeConfirmPairingReq(
  payload: Uint8Array,
): ConfirmPairingReq {
  const value = expectMap(decodeCbor(payload));
  return {
    daemonUrl: fieldText(value, 1),
    confirmationCode: fieldText(value, 2),
    clientLabel: fieldText(value, 3),
  };
}

export function decodeShowDaemonInfoReq(
  payload: Uint8Array,
): ShowDaemonInfoReq {
  const value = expectMap(decodeCbor(payload));
  return {
    configPath: fieldText(value, 1),
    daemonUrl: fieldText(value, 2),
  };
}

export function decodeActivateGuiReq(payload: Uint8Array): ActivateGuiReq {
  const value = expectMap(decodeCbor(payload));
  return {
    reason: fieldText(value, 1),
  };
}

export function encodeConfirmPairingRes(accepted: boolean): Uint8Array {
  return encodeCbor(fields([[1, accepted]]));
}

export function encodeActivateGuiReq(reason: string): Uint8Array {
  return encodeCbor(fields([[1, reason]]));
}

function decodeSocketRequestMessage(
  kindValue: CborValue,
  fieldsValue: CborValue,
): SocketRequestMessage {
  const kind = expectNumber(kindValue);
  const fieldMap = expectMap(fieldsValue);
  if (kind === SOCKET_KIND_REQUEST_UNARY) {
    return {
      kind: "requestUnary",
      procId: fieldNumber(fieldMap, 1),
      payload: optionalFieldBytes(fieldMap, 2),
      streamId: fieldNumber(fieldMap, 100),
    };
  }
  if (kind === SOCKET_KIND_REQUEST_STREAM_END) {
    return {
      kind: "requestStreamEnd",
      streamId: fieldNumber(fieldMap, 100),
    };
  }
  throw new Error(`unexpected IPC request message ${kind}`);
}

function encodeSocketMessage(
  kind: number,
  fieldMap: Map<number, CborValue>,
): Uint8Array {
  return concat([encodeCbor(kind), encodeCbor(fieldMap)]);
}

function encodeIpcProcError(message: string): Uint8Array {
  return encodeCbor([0, fields([[1, message]])]);
}

function fields(
  entries: Array<[number, CborValue | undefined]>,
): Map<number, CborValue> {
  const map = new Map<number, CborValue>();
  for (const [key, value] of entries) {
    if (value !== undefined) map.set(key, value);
  }
  return map;
}

function fieldText(fields: Map<number, CborValue>, key: number): string {
  const value = fields.get(key);
  if (value === undefined) return "";
  if (typeof value !== "string") throw new Error(`field ${key} is not text`);
  return value;
}

function fieldNumber(fields: Map<number, CborValue>, key: number): number {
  const value = fields.get(key);
  if (value === undefined) return 0;
  return expectNumber(value);
}

function optionalFieldBytes(
  fields: Map<number, CborValue>,
  key: number,
): Uint8Array | undefined {
  const value = fields.get(key);
  if (value === undefined) return undefined;
  if (!(value instanceof Uint8Array)) {
    throw new Error(`field ${key} is not bytes`);
  }
  return value;
}

function expectMap(value: CborValue): Map<number, CborValue> {
  if (!(value instanceof Map)) throw new Error("expected CBOR map");
  return value;
}

function expectNumber(value: CborValue): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    throw new Error("expected unsigned safe integer");
  }
  return value;
}

function concat(chunks: Uint8Array[]): Uint8Array {
  const total = chunks.reduce((sum, chunk) => sum + chunk.byteLength, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return out;
}
