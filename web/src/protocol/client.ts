import { decodeCbor, encodeCbor } from "./cbor.ts";
import type { ProcCodec } from "./generated/rpc.ts";
import {
  decodeRpcErrorPayloadValue,
  RpcErrorCode,
  RpcErrorKind,
} from "./generated/wire.ts";
import {
  decodeReqResMessageSequence,
  decodeReqResMessageSequencePrefix,
  encodePairedSecretCredential,
  encodeReqResMessageSequence,
  PAIRED_SECRET_AUTH_MECHANISM,
  type ReqResMessage,
  ReqResMessageKind,
  SessionAuthErrorCode,
} from "./wire.ts";
import { Machine, normalizeMachineUrl } from "../state/machines.ts";

const CONNECT_TIMEOUT_MS = 10_000;

export type RpcClientStream<T> = AsyncIterable<T> | Iterable<T>;

export class RpcError extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
    this.name = "RpcError";
  }
}

export function isInvalidCredentialsError(err: unknown): boolean {
  return err instanceof RpcError && err.code === "invalidCredentials";
}

export async function openWebTransport(
  machine: Machine,
  path = "/rieul/rpc",
): Promise<WebTransport> {
  const transport = new WebTransport(
    `${normalizeMachineUrl(machine.baseUrl)}${path}`,
  );
  try {
    await withTimeout(
      transport.ready,
      CONNECT_TIMEOUT_MS,
      "WebTransport connection",
    );
  } catch (err) {
    transport.close();
    throw err;
  }
  return transport;
}

export function closeWebTransport(transport: WebTransport): void {
  transport.close();
}

export async function authenticateWebTransport(
  transport: WebTransport,
  clientId: string,
  clientSecret: string,
): Promise<void> {
  const stream = await transport.createBidirectionalStream();
  const request = encodeReqResMessageSequence([{
    kind: ReqResMessageKind.SessionAuthenticate,
    mechanism: PAIRED_SECRET_AUTH_MECHANISM,
    payload: encodePairedSecretCredential({
      credentialId: clientId,
      credentialSecret: clientSecret,
    }),
  }]);
  const writer = stream.writable.getWriter();
  await writer.write(request);
  await writer.close();

  const bytes = await readAll(stream.readable);
  const messages = decodeReqResMessageSequence(bytes);
  if (messages.length !== 1) {
    throw new Error("expected one session authentication response");
  }
  const response = messages[0]!;
  if (response.kind === ReqResMessageKind.SessionAuthError) {
    throw new RpcError(
      sessionAuthErrorCode(response.authErrorCode),
      response.message ?? "Session authentication failed",
    );
  }
  if (response.kind !== ReqResMessageKind.SessionAuthenticated) {
    throw new Error("expected session authentication response");
  }
}

export async function callUnary<Request, Response, ErrorPayload>(
  transport: WebTransport,
  proc: ProcCodec<Request, Response, ErrorPayload>,
  request: Request,
): Promise<Response> {
  const payload = encodeRequest(proc, request);
  const response = await sendUnary(transport, proc, payload);
  if (!response) return proc.decodeResponse(undefined as never);
  return proc.decodeResponse(decodeCbor(response));
}

export async function callClientStream<Request, Response, ErrorPayload>(
  transport: WebTransport,
  proc: ProcCodec<Request, Response, ErrorPayload>,
  requests: RpcClientStream<Request>,
): Promise<Response> {
  const response = await sendClientStream(
    transport,
    proc,
    encodeStreamRequests(
      proc,
      requests,
    ),
  );
  if (!response) return proc.decodeResponse(undefined as never);
  return proc.decodeResponse(decodeCbor(response));
}

async function* encodeStreamRequests<Request, Response, ErrorPayload>(
  proc: ProcCodec<Request, Response, ErrorPayload>,
  requests: RpcClientStream<Request>,
): AsyncGenerator<Uint8Array> {
  for await (const request of requests) {
    yield encodeCbor(proc.encodeRequest(request));
  }
}

export async function* callServerStream<Request, Response, ErrorPayload>(
  transport: WebTransport,
  proc: ProcCodec<Request, Response, ErrorPayload>,
  request: Request,
): AsyncGenerator<Response> {
  yield* streamServerEvents(
    transport,
    proc,
    encodeRequest(proc, request),
  );
}

function encodeRequest<Request, Response, ErrorPayload>(
  proc: ProcCodec<Request, Response, ErrorPayload>,
  request: Request,
): Uint8Array | undefined {
  if (request === undefined) return undefined;
  return encodeCbor(proc.encodeRequest(request));
}

async function sendUnary<Request, Response, ErrorPayload>(
  transport: WebTransport,
  proc: ProcCodec<Request, Response, ErrorPayload>,
  payload?: Uint8Array,
): Promise<Uint8Array | undefined> {
  const stream = await transport.createBidirectionalStream();
  const request = encodeReqResMessageSequence([{
    kind: ReqResMessageKind.RequestUnary,
    procId: proc.id,
    payload,
  }]);
  const writer = stream.writable.getWriter();
  await writer.write(request);
  await writer.close();

  const bytes = await readAll(stream.readable);
  const messages = decodeReqResMessageSequence(bytes);
  return decodeUnaryResponse(proc, messages);
}

async function sendClientStream<Request, Response, ErrorPayload>(
  transport: WebTransport,
  proc: ProcCodec<Request, Response, ErrorPayload>,
  payloads: AsyncIterable<Uint8Array> | Iterable<Uint8Array>,
): Promise<Uint8Array | undefined> {
  const stream = await transport.createBidirectionalStream();
  const writer = stream.writable.getWriter();
  try {
    let started = false;
    for await (const payload of payloads) {
      if (!started) {
        started = true;
        await writer.write(encodeReqResMessageSequence([{
          kind: ReqResMessageKind.RequestStreamStart,
          procId: proc.id,
          payload,
        }]));
        continue;
      }
      await writer.write(encodeReqResMessageSequence([{
        kind: ReqResMessageKind.RequestStreamChunk,
        payload,
      }]));
    }
    if (!started) throw new Error("client stream request must not be empty");
    await writer.close();
  } finally {
    try {
      writer.releaseLock();
    } catch {
      // The writer may already be detached by stream shutdown.
    }
  }

  const bytes = await readAll(stream.readable);
  const messages = decodeReqResMessageSequence(bytes);
  return decodeUnaryResponse(proc, messages);
}

function decodeUnaryResponse<Request, Response, ErrorPayload>(
  proc: ProcCodec<Request, Response, ErrorPayload>,
  messages: ReqResMessage[],
): Uint8Array | undefined {
  if (messages.length !== 1) throw new Error("expected one response message");
  const response = messages[0]!;
  if (response.kind === ReqResMessageKind.ResponseUnaryError) {
    throwRpcError(proc, response);
  }
  if (response.kind !== ReqResMessageKind.ResponseUnaryOk) {
    throw new Error("expected unary response message");
  }
  return response.payload;
}

async function* streamServerEvents<Request, Response, ErrorPayload>(
  transport: WebTransport,
  proc: ProcCodec<Request, Response, ErrorPayload>,
  payload: Uint8Array | undefined,
): AsyncGenerator<Response> {
  const stream = await transport.createBidirectionalStream();
  const request = encodeReqResMessageSequence([{
    kind: ReqResMessageKind.RequestUnary,
    procId: proc.id,
    payload,
  }]);
  const writer = stream.writable.getWriter();
  try {
    await writer.write(request);
    await writer.close();
  } finally {
    try {
      writer.releaseLock();
    } catch {
      // The stream may already be closing after a transport failure.
    }
  }

  const reader = stream.readable.getReader();
  let buffered: Uint8Array<ArrayBufferLike> = new Uint8Array();
  let completed = false;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) {
        completed = true;
        break;
      }
      buffered = concatBytes(buffered, value);

      const { messages, readBytes } = decodeReqResMessageSequencePrefix(
        buffered,
      );
      if (readBytes > 0) buffered = buffered.slice(readBytes);

      for (const message of messages) {
        if (message.kind === ReqResMessageKind.ResponseStreamErrorEnd) {
          throwRpcError(proc, message);
        }
        if (
          message.kind !== ReqResMessageKind.ResponseStreamStart &&
          message.kind !== ReqResMessageKind.ResponseStreamChunk
        ) {
          throw new Error("expected stream response message");
        }
        if (!message.payload) {
          throw new Error("missing stream response payload");
        }
        yield proc.decodeResponse(decodeCbor(message.payload));
      }
    }

    if (buffered.length > 0) {
      throw new Error("incomplete stream response message");
    }
  } finally {
    if (!completed) {
      try {
        await reader.cancel();
      } catch {
        // The stream may already be closed by the server.
      }
    }
    try {
      reader.releaseLock();
    } catch {
      // The reader may already be detached by stream shutdown.
    }
  }
}

function throwRpcError<Request, Response, ErrorPayload>(
  proc: ProcCodec<Request, Response, ErrorPayload>,
  response: ReqResMessage,
): never {
  if (!response.error || !response.errorKind) {
    throw new RpcError("rpc_error", "RPC error response");
  }
  if (response.errorKind === RpcErrorKind.Method) {
    const error = proc.decodeError(decodeCbor(response.error));
    throw new RpcError(errorCode(error), errorMessage(error));
  }
  const error = systemErrorPayload(response.error);
  throw new RpcError(error.code, error.message);
}

function systemErrorPayload(
  bytes: Uint8Array,
): { code: string; message: string } {
  const error = decodeRpcErrorPayloadValue(decodeCbor(bytes));
  return {
    code: rpcErrorCode(error.code),
    message: error.message,
  };
}

function errorCode(value: unknown): string {
  if (!value || typeof value !== "object" || !("type" in value)) {
    if (value && typeof value === "object" && "code" in value) {
      return String(value.code);
    }
    return "rpcError";
  }
  return String(value.type);
}

function errorMessage(value: unknown): string {
  if (!value || typeof value !== "object" || !("message" in value)) {
    return "RPC error response";
  }
  return String(value.message);
}

function sessionAuthErrorCode(value: SessionAuthErrorCode | undefined): string {
  if (value === undefined) return "SessionAuthError";
  switch (value) {
    case SessionAuthErrorCode.UnsupportedMechanism:
      return "unsupportedMechanism";
    case SessionAuthErrorCode.InvalidCredentials:
      return "invalidCredentials";
    case SessionAuthErrorCode.MalformedPayload:
      return "malformedPayload";
    case SessionAuthErrorCode.AlreadyAuthenticated:
      return "alreadyAuthenticated";
  }
}

function rpcErrorCode(value: RpcErrorCode): string {
  switch (value) {
    case RpcErrorCode.BadMessage:
      return "badMessage";
    case RpcErrorCode.Unauthorized:
      return "unauthorized";
    case RpcErrorCode.MissingPayload:
      return "missingPayload";
    case RpcErrorCode.NotImplemented:
      return "notImplemented";
    case RpcErrorCode.PermissionDenied:
      return "permissionDenied";
    case RpcErrorCode.NotFound:
      return "notFound";
    case RpcErrorCode.OperationFailed:
      return "operationFailed";
    case RpcErrorCode.MalformedPayload:
      return "malformedPayload";
  }
}

async function readAll(
  readable: ReadableStream<Uint8Array>,
): Promise<Uint8Array> {
  const reader = readable.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    total += value.length;
  }
  const out = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.length;
  }
  return out;
}

function concatBytes(left: Uint8Array, right: Uint8Array): Uint8Array {
  if (left.length === 0) return right;
  if (right.length === 0) return left;
  const out = new Uint8Array(left.length + right.length);
  out.set(left, 0);
  out.set(right, left.length);
  return out;
}

function withTimeout<T>(
  promise: Promise<T>,
  timeoutMs: number,
  label: string,
): Promise<T> {
  let timeout: ReturnType<typeof setTimeout> | undefined;
  const timeoutPromise = new Promise<never>((_, reject) => {
    timeout = setTimeout(
      () => reject(new Error(`${label} timed out after ${timeoutMs}ms`)),
      timeoutMs,
    );
  });
  return Promise.race([promise, timeoutPromise]).finally(() => {
    if (timeout !== undefined) clearTimeout(timeout);
  });
}
