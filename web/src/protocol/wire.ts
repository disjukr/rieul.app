import {
  type CborValue,
  decodeCbor,
  decodeCborSequence,
  decodeCborSequencePrefix,
  encodeCbor,
} from "./cbor.ts";
import {
  type DatagramMessage as GeneratedDatagramMessage,
  decodeDatagramMessageValue,
  decodePairedSecretCredentialValue,
  decodeReqResMessageValue,
  encodeDatagramMessageValue,
  encodePairedSecretCredentialValue,
  encodeReqResMessageValue,
  type PairedSecretCredential,
  type ReqResMessage as GeneratedReqResMessage,
  RpcErrorKind,
  SessionAuthErrorCode,
} from "./generated.ts";

export { RpcErrorKind, SessionAuthErrorCode };
export type { PairedSecretCredential };

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

export function encodeReqResMessage(message: ReqResMessage): Uint8Array {
  const value = encodeReqResMessageValue(toGeneratedReqResMessage(message));
  if (!Array.isArray(value) || value.length !== 2) {
    throw new Error("generated ReqResMessage must encode to union tuple");
  }
  return concat([encodeCbor(value[0]!), encodeCbor(value[1]!)]);
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
  return fromGeneratedReqResMessage(decodeGeneratedReqResMessage(values));
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
    messages.push(
      fromGeneratedReqResMessage(
        decodeGeneratedReqResMessage([values[i]!, values[i + 1]!]),
      ),
    );
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
    messages.push(
      fromGeneratedReqResMessage(
        decodeGeneratedReqResMessage([items[i]!.value, items[i + 1]!.value]),
      ),
    );
  }
  return {
    messages,
    readBytes: pairCount === 0 ? 0 : items[pairCount * 2 - 1]!.endOffset,
  };
}

export function encodeDatagramMessage(message: DatagramMessage): Uint8Array {
  return encodeCbor(encodeDatagramMessageValue(toGeneratedDatagram(message)));
}

export function decodeDatagramMessage(bytes: Uint8Array): DatagramMessage {
  return fromGeneratedDatagram(decodeDatagramMessageValue(decodeCbor(bytes)));
}

export function encodePairedSecretCredential(
  credential: PairedSecretCredential,
): Uint8Array {
  return encodeCbor(encodePairedSecretCredentialValue(credential));
}

export function decodePairedSecretCredential(
  bytes: Uint8Array,
): PairedSecretCredential {
  return decodePairedSecretCredentialValue(decodeCbor(bytes));
}

function decodeGeneratedReqResMessage(
  values: CborValue[],
): GeneratedReqResMessage {
  return decodeReqResMessageValue(values);
}

function toGeneratedReqResMessage(
  message: ReqResMessage,
): GeneratedReqResMessage {
  switch (message.kind) {
    case ReqResMessageKind.RequestUnary:
      return {
        type: "requestUnary",
        procId: required(message.procId, "missing proc id"),
        payload: message.payload,
      };
    case ReqResMessageKind.RequestStreamStart:
      return {
        type: "requestStreamStart",
        procId: required(message.procId, "missing proc id"),
        payload: message.payload,
      };
    case ReqResMessageKind.RequestStreamChunk:
      return {
        type: "requestStreamChunk",
        payload: required(message.payload, "missing payload"),
      };
    case ReqResMessageKind.ResponseUnaryOk:
      return { type: "responseUnaryOk", payload: message.payload };
    case ReqResMessageKind.ResponseUnaryError:
      return {
        type: "responseUnaryError",
        error: required(message.error, "missing error"),
        errorKind: required(message.errorKind, "missing error kind"),
      };
    case ReqResMessageKind.ResponseStreamStart:
      return { type: "responseStreamStart", payload: message.payload };
    case ReqResMessageKind.ResponseStreamChunk:
      return {
        type: "responseStreamChunk",
        payload: required(message.payload, "missing payload"),
      };
    case ReqResMessageKind.ResponseStreamErrorEnd:
      return {
        type: "responseStreamErrorEnd",
        error: required(message.error, "missing error"),
        errorKind: required(message.errorKind, "missing error kind"),
      };
    case ReqResMessageKind.SessionAuthenticate:
      return {
        type: "sessionAuthenticate",
        mechanism: required(message.mechanism, "missing mechanism"),
        payload: required(message.payload, "missing payload"),
      };
    case ReqResMessageKind.SessionAuthenticated:
      return { type: "sessionAuthenticated" };
    case ReqResMessageKind.SessionAuthError:
      return {
        type: "sessionAuthError",
        code: required(
          message.authErrorCode,
          "missing session auth error code",
        ),
        message: required(message.message, "missing message"),
      };
  }
}

function fromGeneratedReqResMessage(
  message: GeneratedReqResMessage,
): ReqResMessage {
  switch (message.type) {
    case "requestUnary":
      return {
        kind: ReqResMessageKind.RequestUnary,
        procId: message.procId,
        payload: message.payload,
      };
    case "requestStreamStart":
      return {
        kind: ReqResMessageKind.RequestStreamStart,
        procId: message.procId,
        payload: message.payload,
      };
    case "requestStreamChunk":
      return {
        kind: ReqResMessageKind.RequestStreamChunk,
        payload: message.payload,
      };
    case "responseUnaryOk":
      return {
        kind: ReqResMessageKind.ResponseUnaryOk,
        payload: message.payload,
      };
    case "responseUnaryError":
      return {
        kind: ReqResMessageKind.ResponseUnaryError,
        error: message.error,
        errorKind: message.errorKind,
      };
    case "responseStreamStart":
      return {
        kind: ReqResMessageKind.ResponseStreamStart,
        payload: message.payload,
      };
    case "responseStreamChunk":
      return {
        kind: ReqResMessageKind.ResponseStreamChunk,
        payload: message.payload,
      };
    case "responseStreamErrorEnd":
      return {
        kind: ReqResMessageKind.ResponseStreamErrorEnd,
        error: message.error,
        errorKind: message.errorKind,
      };
    case "sessionAuthenticate":
      return {
        kind: ReqResMessageKind.SessionAuthenticate,
        mechanism: message.mechanism,
        payload: message.payload,
      };
    case "sessionAuthenticated":
      return { kind: ReqResMessageKind.SessionAuthenticated };
    case "sessionAuthError":
      return {
        kind: ReqResMessageKind.SessionAuthError,
        authErrorCode: message.code,
        message: message.message,
      };
  }
}

function toGeneratedDatagram(
  message: DatagramMessage,
): GeneratedDatagramMessage {
  switch (message.kind) {
    case DatagramMessageKind.Ping:
      return { type: "ping", pingId: message.pingId };
    case DatagramMessageKind.Pong:
      return { type: "pong", pingId: message.pingId };
  }
}

function fromGeneratedDatagram(
  message: GeneratedDatagramMessage,
): DatagramMessage {
  switch (message.type) {
    case "ping":
      return { kind: DatagramMessageKind.Ping, pingId: message.pingId };
    case "pong":
      return { kind: DatagramMessageKind.Pong, pingId: message.pingId };
  }
}

function required<T>(value: T | undefined, message: string): T {
  if (value === undefined) throw new Error(message);
  return value;
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
