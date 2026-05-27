import {
  CborValue,
  decodeCbor,
  decodeCborSequence,
  decodeCborSequencePrefix,
  encodeCbor,
} from "./cbor.ts";

export const PAIRED_SECRET_AUTH_MECHANISM = "wgo.paired-secret.v1";

export enum ReqResMessageKind {
  RequestUnary = 0,
  RequestStreamStart = 1,
  RequestStreamChunk = 2,
  ResponseUnaryOk = 3,
  ResponseUnaryError = 4,
  ResponseStreamStart = 5,
  ResponseStreamChunk = 6,
  ResponseStreamErrorEnd = 7,
  SessionAuthenticate = 8,
  SessionAuthenticated = 9,
  SessionAuthError = 10,
}

export enum DatagramMessageKind {
  Ping = 1,
  Pong = 2,
}

export enum RpcErrorKind {
  System = 1,
  Method = 2,
}

export enum SessionAuthErrorCode {
  UnsupportedMechanism = 1,
  InvalidCredentials = 2,
  MalformedPayload = 3,
  AlreadyAuthenticated = 4,
}

export interface ReqResMessage {
  kind: ReqResMessageKind;
  procId?: number | undefined;
  payload?: Uint8Array | undefined;
  error?: Uint8Array | undefined;
  errorKind?: RpcErrorKind | undefined;
  mechanism?: string | undefined;
  authErrorCode?: SessionAuthErrorCode | undefined;
  message?: string | undefined;
}

export interface DatagramMessage {
  kind: DatagramMessageKind;
  pingId: number;
}

export interface PairedSecretCredential {
  credentialId: string;
  credentialSecret: string;
}

export function encodeReqResMessage(message: ReqResMessage): Uint8Array {
  const [kind, fields] = toCborParts(message);
  return concat([encodeCbor(kind), encodeCbor(fields)]);
}

export function encodeReqResMessageSequence(
  messages: ReqResMessage[],
): Uint8Array {
  return concat(messages.map(encodeReqResMessage));
}

export function decodeReqResMessage(bytes: Uint8Array): ReqResMessage {
  const values = decodeCborSequence(bytes);
  if (values.length !== 2) {
    throw new Error("expected ReqResMessage kind/map pair");
  }
  return fromCborParts(values[0]!, values[1]!);
}

export function decodeReqResMessageSequence(
  bytes: Uint8Array,
): ReqResMessage[] {
  const values = decodeCborSequence(bytes);
  if (values.length % 2 !== 0) {
    throw new Error("expected complete ReqResMessage kind/map pairs");
  }
  const messages: ReqResMessage[] = [];
  for (let i = 0; i < values.length; i += 2) {
    messages.push(fromCborParts(values[i]!, values[i + 1]!));
  }
  return messages;
}

export function decodeReqResMessageSequencePrefix(
  bytes: Uint8Array,
): { messages: ReqResMessage[]; readBytes: number } {
  const items = decodeCborSequencePrefix(bytes);
  const pairCount = Math.floor(items.length / 2);
  const messages: ReqResMessage[] = [];
  for (let i = 0; i < pairCount * 2; i += 2) {
    messages.push(fromCborParts(items[i]!.value, items[i + 1]!.value));
  }
  return {
    messages,
    readBytes: pairCount === 0 ? 0 : items[pairCount * 2 - 1]!.endOffset,
  };
}

export function encodeDatagramMessage(message: DatagramMessage): Uint8Array {
  return encodeCbor([
    message.kind,
    fields([[1, requiredU53(message.pingId)]]),
  ]);
}

export function decodeDatagramMessage(bytes: Uint8Array): DatagramMessage {
  const value = decodeCbor(bytes);
  if (!Array.isArray(value) || value.length !== 2) {
    throw new Error("expected DatagramMessage union tuple");
  }
  const kind = datagramMessageKind(value[0]);
  const fields = value[1];
  if (!(fields instanceof Map)) {
    throw new Error("expected DatagramMessage fields");
  }
  switch (kind) {
    case DatagramMessageKind.Ping:
    case DatagramMessageKind.Pong:
      return { kind, pingId: requiredU53(fields.get(1)) };
  }
}

export function encodePairedSecretCredential(
  credential: PairedSecretCredential,
): Uint8Array {
  return encodeCbor(
    new Map<number, CborValue>([
      [1, credential.credentialId],
      [2, credential.credentialSecret],
    ]),
  );
}

function toCborParts(message: ReqResMessage): [CborValue, CborValue] {
  switch (message.kind) {
    case ReqResMessageKind.RequestUnary:
    case ReqResMessageKind.RequestStreamStart:
      if (message.procId === undefined) throw new Error("missing proc id");
      return [
        message.kind,
        fields([
          [1, message.procId],
          [2, message.payload],
        ]),
      ];
    case ReqResMessageKind.RequestStreamChunk:
    case ReqResMessageKind.ResponseStreamChunk:
      if (message.payload === undefined) throw new Error("missing payload");
      return [message.kind, fields([[2, message.payload]])];
    case ReqResMessageKind.ResponseUnaryOk:
    case ReqResMessageKind.ResponseStreamStart:
      return [message.kind, fields([[2, message.payload]])];
    case ReqResMessageKind.ResponseUnaryError:
    case ReqResMessageKind.ResponseStreamErrorEnd:
      if (message.error === undefined) throw new Error("missing error");
      if (message.errorKind === undefined) {
        throw new Error("missing error kind");
      }
      return [
        message.kind,
        fields([
          [3, message.error],
          [4, message.errorKind],
        ]),
      ];
    case ReqResMessageKind.SessionAuthenticate:
      if (message.mechanism === undefined) throw new Error("missing mechanism");
      if (message.payload === undefined) throw new Error("missing payload");
      return [
        message.kind,
        fields([
          [1, message.mechanism],
          [2, message.payload],
        ]),
      ];
    case ReqResMessageKind.SessionAuthenticated:
      return [message.kind, new Map<number, CborValue>()];
    case ReqResMessageKind.SessionAuthError:
      if (message.authErrorCode === undefined) {
        throw new Error("missing session auth error code");
      }
      if (message.message === undefined) throw new Error("missing message");
      return [
        message.kind,
        fields([
          [1, message.authErrorCode],
          [2, message.message],
        ]),
      ];
  }
}

function fromCborParts(
  kindValue: CborValue,
  fieldsValue: CborValue,
): ReqResMessage {
  const kind = reqResMessageKind(kindValue);
  const fields = fieldsValue;
  if (!(fields instanceof Map)) {
    throw new Error("expected ReqResMessage fields");
  }
  switch (kind) {
    case ReqResMessageKind.RequestUnary:
    case ReqResMessageKind.RequestStreamStart:
      return {
        kind,
        procId: requiredProcId(fields.get(1)),
        payload: optionalBytes(fields.get(2)),
      };
    case ReqResMessageKind.RequestStreamChunk:
    case ReqResMessageKind.ResponseStreamChunk:
      return {
        kind,
        payload: requiredBytes(fields.get(2)),
      };
    case ReqResMessageKind.ResponseUnaryOk:
    case ReqResMessageKind.ResponseStreamStart:
      return {
        kind,
        payload: optionalBytes(fields.get(2)),
      };
    case ReqResMessageKind.ResponseUnaryError:
    case ReqResMessageKind.ResponseStreamErrorEnd:
      return {
        kind,
        error: requiredBytes(fields.get(3)),
        errorKind: requiredRpcErrorKind(fields.get(4)),
      };
    case ReqResMessageKind.SessionAuthenticate:
      return {
        kind,
        mechanism: requiredText(fields.get(1)),
        payload: requiredBytes(fields.get(2)),
      };
    case ReqResMessageKind.SessionAuthenticated:
      return { kind };
    case ReqResMessageKind.SessionAuthError:
      return {
        kind,
        authErrorCode: requiredSessionAuthErrorCode(fields.get(1)),
        message: requiredText(fields.get(2)),
      };
  }
}

function fields(
  entries: [number, CborValue | undefined][],
): Map<number, CborValue> {
  const map = new Map<number, CborValue>();
  for (const [field, value] of entries) {
    if (value !== undefined) map.set(field, value);
  }
  return map;
}

function requiredProcId(value: unknown): number {
  if (!isU53(value)) {
    throw new Error("expected proc id");
  }
  return value;
}

function requiredU53(value: unknown): number {
  if (!isU53(value)) throw new Error("expected u53");
  return value;
}

function isU53(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function requiredRpcErrorKind(value: unknown): RpcErrorKind {
  if (typeof value !== "number" || !Number.isSafeInteger(value)) {
    throw new Error("expected error kind");
  }
  switch (value) {
    case RpcErrorKind.System:
    case RpcErrorKind.Method:
      return value;
    default:
      throw new Error(`unknown error kind ${value}`);
  }
}

function requiredSessionAuthErrorCode(value: unknown): SessionAuthErrorCode {
  if (typeof value !== "number" || !Number.isSafeInteger(value)) {
    throw new Error("expected session auth error code");
  }
  switch (value) {
    case SessionAuthErrorCode.UnsupportedMechanism:
    case SessionAuthErrorCode.InvalidCredentials:
    case SessionAuthErrorCode.MalformedPayload:
    case SessionAuthErrorCode.AlreadyAuthenticated:
      return value;
    default:
      throw new Error(`unknown session auth error code ${value}`);
  }
}

function requiredBytes(value: unknown): Uint8Array {
  if (!(value instanceof Uint8Array)) throw new Error("expected bytes");
  return value;
}

function optionalBytes(value: unknown): Uint8Array | undefined {
  if (value == null) return undefined;
  return requiredBytes(value);
}

function requiredText(value: unknown): string {
  if (typeof value !== "string") throw new Error("expected string");
  return value;
}

function reqResMessageKind(value: unknown): ReqResMessageKind {
  if (typeof value !== "number" || !Number.isSafeInteger(value)) {
    throw new Error("expected ReqResMessage kind");
  }
  switch (value) {
    case ReqResMessageKind.RequestUnary:
    case ReqResMessageKind.RequestStreamStart:
    case ReqResMessageKind.RequestStreamChunk:
    case ReqResMessageKind.ResponseUnaryOk:
    case ReqResMessageKind.ResponseUnaryError:
    case ReqResMessageKind.ResponseStreamStart:
    case ReqResMessageKind.ResponseStreamChunk:
    case ReqResMessageKind.ResponseStreamErrorEnd:
    case ReqResMessageKind.SessionAuthenticate:
    case ReqResMessageKind.SessionAuthenticated:
    case ReqResMessageKind.SessionAuthError:
      return value;
    default:
      throw new Error(`unknown ReqResMessage kind ${value}`);
  }
}

function datagramMessageKind(value: unknown): DatagramMessageKind {
  if (!isU53(value)) {
    throw new Error("expected DatagramMessage kind");
  }
  switch (value) {
    case DatagramMessageKind.Ping:
    case DatagramMessageKind.Pong:
      return value;
    default:
      throw new Error(`unknown DatagramMessage kind ${value}`);
  }
}

function concat(chunks: Uint8Array[]): Uint8Array {
  const len = chunks.reduce((sum, chunk) => sum + chunk.length, 0);
  const out = new Uint8Array(len);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.length;
  }
  return out;
}
