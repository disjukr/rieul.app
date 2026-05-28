import { CborValue, decodeCbor, encodeCbor } from "./cbor.ts";
import {
  DatagramMessageKind,
  decodeDatagramMessage,
  decodeReqResMessageSequence,
  decodeReqResMessageSequencePrefix,
  encodeDatagramMessage,
  encodePairedSecretCredential,
  encodeReqResMessageSequence,
  PAIRED_SECRET_AUTH_MECHANISM,
  ReqResMessageKind,
  RpcErrorKind,
  SessionAuthErrorCode,
} from "./wire.ts";
import { Machine, normalizeMachineUrl } from "../state/machines.ts";

const PROC_COMPLETE_PAIRING = 2;
const PROC_SUBSCRIBE_ROOTS = 3;
const PROC_SUBSCRIBE_DIRECTORY = 4;
const PROC_READ_FILE = 5;
const PROC_WRITE_FILE = 6;
const PROC_CREATE_NODES = 7;
const PROC_RENAME_PATHS = 8;
const PROC_DELETE_PATHS = 9;
const CONNECT_TIMEOUT_MS = 10_000;
const DATAGRAM_PING_TIMEOUT_MS = 5_000;

interface RpcSession {
  transport: WebTransport;
  datagrams: DatagramRuntime;
}

interface DatagramRuntime {
  writer: WritableStreamDefaultWriter<Uint8Array>;
  pendingPings: Map<number, PendingDatagramPing>;
  nextPingId: number;
  closed: boolean;
}

interface PendingDatagramPing {
  startedAt: number;
  timeout: ReturnType<typeof setTimeout>;
  resolve: (latencyMs: number) => void;
  reject: (err: Error) => void;
}

const rpcSessions = new Map<string, Promise<RpcSession>>();

export interface CompletePairingResponse {
  clientId: string;
  clientSecret: string;
}

export enum FsEntryKind {
  File = 1,
  Directory = 2,
  Symlink = 3,
  Other = 4,
}

export interface FsEntry {
  name: string;
  path: string;
  kind: FsEntryKind;
  size?: number;
  modifiedAtMs?: number;
  readonly: boolean;
}

export type RootsTableEvent =
  | { type: "snapshot"; rows: FsEntry[] }
  | { type: "patch"; removes: { path: string }[]; upserts: FsEntry[] }
  | { type: "closed"; reason: string };

export type DirectoryTableEvent =
  | { type: "snapshot"; rows: FsEntry[] }
  | { type: "patch"; removes: { name: string }[]; upserts: FsEntry[] }
  | { type: "closed"; reason: string; to?: string };

export enum WriteFileMode {
  CreateNew = 1,
  CreateOrReplace = 2,
}

export enum DeleteMode {
  Trash = 1,
  Permanent = 2,
}

export type CreateNodeSpec =
  | { type: "file" }
  | { type: "directory" }
  | { type: "symlink"; target: string }
  | { type: "hardlink"; target: string };

export interface CreateNodeOp {
  path: string;
  spec: CreateNodeSpec;
}

export interface RenamePathOp {
  from: string;
  to: string;
}

export type BulkMutationItemResult =
  | { ok: true; index: number }
  | { ok: false; index: number; code: string; message: string };

export interface BulkMutationResponse {
  results: BulkMutationItemResult[];
}

export class RpcError extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
    this.name = "RpcError";
  }
}

export class DatagramPingTimeoutError extends Error {
  constructor(timeoutMs: number) {
    super(`datagram pong timed out after ${timeoutMs}ms`);
    this.name = "DatagramPingTimeoutError";
  }
}

export function isDatagramPingTimeoutError(
  err: unknown,
): err is DatagramPingTimeoutError {
  return err instanceof DatagramPingTimeoutError;
}

export async function completePairing(
  machine: Machine,
  code: string,
  clientLabel: string,
): Promise<CompletePairingResponse> {
  const payload = encodeCbor(
    new Map<number, CborValue>([
      [1, code],
      [2, clientLabel],
    ]),
  );
  const response = await callUnaryPayload(
    machine,
    PROC_COMPLETE_PAIRING,
    payload,
    {
      includeAuth: false,
    },
  );
  const map = decodeMap(response);
  return {
    clientId: text(map.get(1)),
    clientSecret: text(map.get(2)),
  };
}

export async function* subscribeRoots(
  machine: Machine,
): AsyncGenerator<RootsTableEvent> {
  yield* callServerStreamEvents(
    machine,
    PROC_SUBSCRIBE_ROOTS,
    undefined,
    decodeRootsTableEvent,
  );
}

export async function* subscribeDirectory(
  machine: Machine,
  path: string,
): AsyncGenerator<DirectoryTableEvent> {
  const payload = encodeCbor(new Map<number, CborValue>([[1, path]]));
  yield* callServerStreamEvents(
    machine,
    PROC_SUBSCRIBE_DIRECTORY,
    payload,
    decodeDirectoryTableEvent,
  );
}

export async function readFile(
  machine: Machine,
  path: string,
): Promise<Uint8Array> {
  const payload = encodeCbor(new Map<number, CborValue>([[1, path]]));
  const response = await callUnaryPayload(machine, PROC_READ_FILE, payload);
  const map = decodeMap(response);
  return bytes(map.get(1));
}

export async function writeFile(
  machine: Machine,
  path: string,
  mode: WriteFileMode,
  fileBytes: Uint8Array,
): Promise<void> {
  const payload = encodeCbor(
    new Map<number, CborValue>([
      [1, path],
      [2, mode],
      [3, fileBytes],
    ]),
  );
  await callUnary(machine, PROC_WRITE_FILE, payload);
}

export async function createNodes(
  machine: Machine,
  nodes: CreateNodeOp[],
): Promise<BulkMutationResponse> {
  const payload = encodeCbor(
    new Map<number, CborValue>([
      [1, nodes.map(encodeCreateNodeOp)],
    ]),
  );
  const response = await callUnaryPayload(machine, PROC_CREATE_NODES, payload);
  return decodeBulkMutationResponse(response);
}

export async function renamePaths(
  machine: Machine,
  ops: RenamePathOp[],
): Promise<BulkMutationResponse> {
  const payload = encodeCbor(
    new Map<number, CborValue>([
      [
        1,
        ops.map((op) =>
          new Map<number, CborValue>([
            [1, op.from],
            [2, op.to],
          ])
        ),
      ],
    ]),
  );
  const response = await callUnaryPayload(machine, PROC_RENAME_PATHS, payload);
  return decodeBulkMutationResponse(response);
}

export async function deletePaths(
  machine: Machine,
  paths: string[],
  mode: DeleteMode,
): Promise<BulkMutationResponse> {
  const payload = encodeCbor(
    new Map<number, CborValue>([
      [1, paths],
      [2, mode],
    ]),
  );
  const response = await callUnaryPayload(machine, PROC_DELETE_PATHS, payload);
  return decodeBulkMutationResponse(response);
}

export async function checkReachable(machine: Machine): Promise<number> {
  if (machine.clientId && machine.clientSecret) {
    const session = await authenticatedSession(machine);
    try {
      return await pingDatagram(session.datagrams);
    } catch (err) {
      if (session.datagrams.closed) {
        closeSession(machine);
      }
      throw err;
    }
  }

  const session = await connect(machine, "/rpc");
  try {
    return await pingDatagram(session.datagrams);
  } finally {
    closeRpcSession(session);
  }
}

async function callUnaryPayload(
  machine: Machine,
  procId: number,
  payload?: Uint8Array,
  options: { includeAuth?: boolean } = {},
): Promise<Uint8Array> {
  const response = await callUnary(machine, procId, payload, options);
  if (!response) throw new Error("missing response payload");
  return response;
}

async function callUnary(
  machine: Machine,
  procId: number,
  payload?: Uint8Array,
  options: { includeAuth?: boolean } = {},
): Promise<Uint8Array | undefined> {
  if (
    options.includeAuth !== false && machine.clientId && machine.clientSecret
  ) {
    const session = await authenticatedSession(machine);
    try {
      return await sendUnary(session.transport, procId, payload);
    } catch (err) {
      closeSession(machine);
      throw err;
    }
  }

  const session = await connect(machine, "/rpc");
  try {
    return await sendUnary(session.transport, procId, payload);
  } finally {
    closeRpcSession(session);
  }
}

async function* callServerStreamEvents<T>(
  machine: Machine,
  procId: number,
  payload: Uint8Array | undefined,
  decodePayload: (bytes: Uint8Array) => T,
): AsyncGenerator<T> {
  if (machine.clientId && machine.clientSecret) {
    const session = await authenticatedSession(machine);
    try {
      yield* streamServerEvents(
        session.transport,
        procId,
        payload,
        decodePayload,
      );
    } catch (err) {
      closeSession(machine);
      throw err;
    }
    return;
  }

  const session = await connect(machine, "/rpc");
  try {
    yield* streamServerEvents(
      session.transport,
      procId,
      payload,
      decodePayload,
    );
  } finally {
    closeRpcSession(session);
  }
}

async function connect(
  machine: Machine,
  path: string,
): Promise<RpcSession> {
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
  return {
    transport,
    datagrams: startDatagramRuntime(transport),
  };
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

function authenticatedSession(machine: Machine): Promise<RpcSession> {
  const key = sessionKey(machine);
  const current = rpcSessions.get(key);
  if (current) return current;

  const sessionPromise: Promise<RpcSession> = (async () => {
    if (!machine.clientId || !machine.clientSecret) {
      throw new Error("missing paired client credentials");
    }
    const session = await connect(machine, "/rpc");
    try {
      await authenticateSession(
        session.transport,
        machine.clientId,
        machine.clientSecret,
      );
    } catch (err) {
      closeRpcSession(session);
      throw err;
    }
    session.transport.closed.finally(() => {
      if (rpcSessions.get(key) === sessionPromise) rpcSessions.delete(key);
    });
    return session;
  })();

  rpcSessions.set(key, sessionPromise);
  sessionPromise.catch(() => {
    if (rpcSessions.get(key) === sessionPromise) rpcSessions.delete(key);
  });
  return sessionPromise;
}

function closeSession(machine: Machine): void {
  const key = sessionKey(machine);
  const session = rpcSessions.get(key);
  rpcSessions.delete(key);
  session?.then(closeRpcSession).catch(() => {});
}

function sessionKey(machine: Machine): string {
  return [
    machine.id,
    normalizeMachineUrl(machine.baseUrl),
    machine.clientId ?? "",
    machine.clientSecret ?? "",
  ].join("\n");
}

async function authenticateSession(
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

function startDatagramRuntime(transport: WebTransport): DatagramRuntime {
  const runtime: DatagramRuntime = {
    writer: transport.datagrams.writable.getWriter(),
    pendingPings: new Map(),
    nextPingId: 0,
    closed: false,
  };
  void readDatagrams(transport, runtime);
  transport.closed
    .catch(() => {})
    .finally(() => {
      closeDatagramRuntime(runtime, new Error("WebTransport session closed"));
    });
  return runtime;
}

async function readDatagrams(
  transport: WebTransport,
  runtime: DatagramRuntime,
): Promise<void> {
  const reader = transport.datagrams.readable.getReader();
  try {
    while (!runtime.closed) {
      const { done, value } = await reader.read();
      if (done) break;
      await handleIncomingDatagram(runtime, value);
    }
  } catch (err) {
    closeDatagramRuntime(
      runtime,
      err instanceof Error ? err : new Error(String(err)),
    );
  } finally {
    try {
      reader.releaseLock();
    } catch {
      // The reader may already be detached by transport shutdown.
    }
  }
}

async function handleIncomingDatagram(
  runtime: DatagramRuntime,
  bytes: Uint8Array,
): Promise<void> {
  let message;
  try {
    message = decodeDatagramMessage(bytes);
  } catch {
    return;
  }

  if (message.kind === DatagramMessageKind.Ping) {
    try {
      await runtime.writer.write(encodeDatagramMessage({
        kind: DatagramMessageKind.Pong,
        pingId: message.pingId,
      }));
    } catch {
      closeDatagramRuntime(runtime, new Error("failed to send datagram pong"));
    }
    return;
  }

  const pending = runtime.pendingPings.get(message.pingId);
  if (!pending) return;

  runtime.pendingPings.delete(message.pingId);
  clearTimeout(pending.timeout);
  pending.resolve(performance.now() - pending.startedAt);
}

function pingDatagram(
  runtime: DatagramRuntime,
  timeoutMs = DATAGRAM_PING_TIMEOUT_MS,
): Promise<number> {
  if (runtime.closed) {
    return Promise.reject(new Error("datagram runtime is closed"));
  }

  const pingId = nextPingId(runtime);
  const startedAt = performance.now();
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      runtime.pendingPings.delete(pingId);
      reject(new DatagramPingTimeoutError(timeoutMs));
    }, timeoutMs);
    const pending: PendingDatagramPing = {
      startedAt,
      timeout,
      resolve,
      reject,
    };
    runtime.pendingPings.set(pingId, pending);

    runtime.writer.write(encodeDatagramMessage({
      kind: DatagramMessageKind.Ping,
      pingId,
    })).catch((err) => {
      if (runtime.pendingPings.get(pingId) !== pending) return;
      runtime.pendingPings.delete(pingId);
      clearTimeout(timeout);
      const error = err instanceof Error ? err : new Error(String(err));
      closeDatagramRuntime(runtime, error);
      reject(error);
    });
  });
}

function nextPingId(runtime: DatagramRuntime): number {
  runtime.nextPingId = runtime.nextPingId >= Number.MAX_SAFE_INTEGER
    ? 1
    : runtime.nextPingId + 1;
  return runtime.nextPingId;
}

function closeRpcSession(session: RpcSession): void {
  closeDatagramRuntime(session.datagrams, new Error("RPC session closed"));
  session.transport.close();
}

function closeDatagramRuntime(runtime: DatagramRuntime, err: Error): void {
  if (runtime.closed) return;
  runtime.closed = true;
  for (const [pingId, pending] of runtime.pendingPings) {
    runtime.pendingPings.delete(pingId);
    clearTimeout(pending.timeout);
    pending.reject(err);
  }
  try {
    runtime.writer.releaseLock();
  } catch {
    // The writer may be in an errored state after transport shutdown.
  }
}

async function sendUnary(
  transport: WebTransport,
  procId: number,
  payload?: Uint8Array,
): Promise<Uint8Array | undefined> {
  const stream = await transport.createBidirectionalStream();

  const request = encodeReqResMessageSequence([{
    kind: ReqResMessageKind.RequestUnary,
    procId,
    payload,
  }]);
  const writer = stream.writable.getWriter();
  await writer.write(request);
  await writer.close();

  const bytes = await readAll(stream.readable);
  const messages = decodeReqResMessageSequence(bytes);
  if (messages.length !== 1) throw new Error("expected one response message");
  const response = messages[0]!;
  if (response.kind === ReqResMessageKind.ResponseUnaryError) {
    if (!response.error) {
      throw new RpcError("rpc_error", "RPC error response");
    }
    if (!response.errorKind) {
      throw new RpcError("rpc_error", "RPC error response without kind");
    }
    const error = decodeErrorPayload(
      procId,
      response.errorKind,
      response.error,
    );
    throw new RpcError(error.code, error.message);
  }
  if (response.kind !== ReqResMessageKind.ResponseUnaryOk) {
    throw new Error("expected unary response message");
  }
  return response.payload;
}

async function* streamServerEvents<T>(
  transport: WebTransport,
  procId: number,
  payload: Uint8Array | undefined,
  decodePayload: (bytes: Uint8Array) => T,
): AsyncGenerator<T> {
  const stream = await transport.createBidirectionalStream();

  const request = encodeReqResMessageSequence([{
    kind: ReqResMessageKind.RequestUnary,
    procId,
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
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffered = concatBytes(buffered, value);

      const { messages, readBytes } = decodeReqResMessageSequencePrefix(
        buffered,
      );
      if (readBytes > 0) buffered = buffered.slice(readBytes);

      for (const message of messages) {
        if (message.kind === ReqResMessageKind.ResponseStreamErrorEnd) {
          if (!message.error || !message.errorKind) {
            throw new RpcError("rpc_error", "RPC stream error response");
          }
          const error = decodeErrorPayload(
            procId,
            message.errorKind,
            message.error,
          );
          throw new RpcError(error.code, error.message);
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
        yield decodePayload(message.payload);
      }
    }

    if (buffered.length > 0) {
      throw new Error("incomplete stream response message");
    }
  } finally {
    try {
      await reader.cancel();
    } catch {
      // The stream may already be closed by the server.
    }
    try {
      reader.releaseLock();
    } catch {
      // The reader may already be detached by stream shutdown.
    }
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

function decodeMap(bytes: Uint8Array): Map<number, CborValue> {
  const map = decodeCbor(bytes);
  if (!(map instanceof Map)) throw new Error("expected CBOR map");
  return map;
}

function encodeCreateNodeOp(op: CreateNodeOp): CborValue {
  return new Map<number, CborValue>([
    [1, op.path],
    [2, encodeCreateNodeSpec(op.spec)],
  ]);
}

function encodeCreateNodeSpec(spec: CreateNodeSpec): CborValue {
  switch (spec.type) {
    case "file":
      return [1, new Map<number, CborValue>()];
    case "directory":
      return [2, new Map<number, CborValue>()];
    case "symlink":
      return [3, new Map<number, CborValue>([[1, spec.target]])];
    case "hardlink":
      return [4, new Map<number, CborValue>([[1, spec.target]])];
  }
}

function decodeRootsTableEvent(bytes: Uint8Array): RootsTableEvent {
  const [variantId, fields] = decodeUnion(decodeCbor(bytes));
  switch (variantId) {
    case 1:
      return { type: "snapshot", rows: decodeFsEntries(fields.get(1)) };
    case 2:
      return {
        type: "patch",
        removes: array(fields.get(1)).map((value) => {
          const row = mapValue(value);
          return { path: text(row.get(1)) };
        }),
        upserts: decodeFsEntries(fields.get(2)),
      };
    case 3:
      return { type: "closed", reason: rootsCloseReason(fields.get(1)) };
    default:
      throw new Error(`unknown RootsTableEvent variant ${variantId}`);
  }
}

function decodeDirectoryTableEvent(bytes: Uint8Array): DirectoryTableEvent {
  const [variantId, fields] = decodeUnion(decodeCbor(bytes));
  switch (variantId) {
    case 1:
      return { type: "snapshot", rows: decodeFsEntries(fields.get(1)) };
    case 2:
      return {
        type: "patch",
        removes: array(fields.get(1)).map((value) => {
          const row = mapValue(value);
          return { name: text(row.get(1)) };
        }),
        upserts: decodeFsEntries(fields.get(2)),
      };
    case 3: {
      const [reason, reasonFields] = decodeUnionValue(fields.get(1));
      if (reason === 2) {
        return {
          type: "closed",
          reason: "Moved",
          to: optionalText(reasonFields.get(1)),
        };
      }
      return { type: "closed", reason: directoryCloseReason(reason) };
    }
    default:
      throw new Error(`unknown DirectoryTableEvent variant ${variantId}`);
  }
}

function decodeBulkMutationResponse(bytes: Uint8Array): BulkMutationResponse {
  const map = decodeMap(bytes);
  return {
    results: array(map.get(1)).map(decodeBulkMutationItemResult),
  };
}

function decodeBulkMutationItemResult(
  value: CborValue,
): BulkMutationItemResult {
  const [variantId, fields] = decodeUnion(value);
  switch (variantId) {
    case 0: {
      const [errorVariant, errorFields] = decodeUnionValue(fields.get(2));
      return {
        ok: false,
        index: integer(fields.get(1)),
        code: fsMutationItemErrorCode(errorVariant),
        message: text(errorFields.get(1)),
      };
    }
    case 1:
      return { ok: true, index: integer(fields.get(1)) };
    default:
      throw new Error(`unknown BulkMutationItemResult variant ${variantId}`);
  }
}

function decodeFsEntries(value: unknown): FsEntry[] {
  return array(value).map(decodeFsEntry);
}

function decodeFsEntry(value: CborValue): FsEntry {
  const map = mapValue(value);
  return {
    name: text(map.get(1)),
    path: text(map.get(2)),
    kind: fsEntryKind(map.get(3)),
    size: optionalInteger(map.get(4)),
    modifiedAtMs: optionalInteger(map.get(5)),
    readonly: optionalBoolean(map.get(6)) ?? false,
  };
}

function decodeUnion(value: CborValue): [number, Map<number, CborValue>] {
  if (!Array.isArray(value) || value.length !== 2) {
    throw new Error("expected union tuple");
  }
  return [integer(value[0]), mapValue(value[1])];
}

function decodeUnionValue(
  value: unknown,
): [number, Map<number, CborValue>] {
  if (!isCborValue(value)) throw new Error("expected union value");
  return decodeUnion(value);
}

function mapValue(value: unknown): Map<number, CborValue> {
  if (!(value instanceof Map)) throw new Error("expected CBOR map");
  return value;
}

function array(value: unknown): CborValue[] {
  if (!Array.isArray(value)) throw new Error("expected CBOR array");
  return value;
}

function bytes(value: unknown): Uint8Array {
  if (!(value instanceof Uint8Array)) throw new Error("expected bytes field");
  return value;
}

function fsEntryKind(value: unknown): FsEntryKind {
  const kind = integer(value);
  switch (kind) {
    case FsEntryKind.File:
    case FsEntryKind.Directory:
    case FsEntryKind.Symlink:
    case FsEntryKind.Other:
      return kind;
    default:
      throw new Error(`unknown filesystem entry kind ${kind}`);
  }
}

function rootsCloseReason(value: unknown): string {
  const [variantId] = decodeUnionValue(value);
  switch (variantId) {
    case 0:
      return "Failed";
    case 1:
      return "PermissionLost";
    case 2:
      return "Unknown";
    default:
      return `RootsSubscriptionCloseReason${variantId}`;
  }
}

function directoryCloseReason(variantId: number): string {
  switch (variantId) {
    case 0:
      return "Failed";
    case 1:
      return "Deleted";
    case 3:
      return "PermissionLost";
    case 4:
      return "ReplacedByNonDirectory";
    case 5:
      return "Unknown";
    default:
      return `DirectorySubscriptionCloseReason${variantId}`;
  }
}

function fsMutationItemErrorCode(variantId: number): string {
  switch (variantId) {
    case 0:
      return "Failed";
    case 1:
      return "PermissionDenied";
    case 2:
      return "NotFound";
    case 3:
      return "AlreadyExists";
    case 4:
      return "NotDirectory";
    case 5:
      return "NotFile";
    case 6:
      return "InvalidPath";
    case 7:
      return "Unsupported";
    default:
      return `FsMutationItemError${variantId}`;
  }
}

function decodeErrorPayload(
  procId: number,
  kind: RpcErrorKind,
  bytes: Uint8Array,
): { code: string; message: string } {
  const value = decodeCbor(bytes);
  if (kind === RpcErrorKind.System) {
    if (!(value instanceof Map)) {
      throw new Error("invalid system error payload");
    }
    return {
      code: rpcErrorCode(value.get(1)),
      message: text(value.get(2)),
    };
  }
  if (kind !== RpcErrorKind.Method) {
    throw new Error("invalid error kind");
  }
  if (!Array.isArray(value) || value.length < 2) {
    throw new Error("invalid method error payload");
  }
  const variantId = integer(value[0]);
  const fields = value[1];
  if (!(fields instanceof Map)) {
    throw new Error("invalid method error payload");
  }
  return {
    code: methodErrorCode(procId, variantId),
    message: text(fields.get(1)),
  };
}

function methodErrorCode(procId: number, variantId: number): string {
  const key = `${procId}:${variantId}`;
  return METHOD_ERROR_CODES[key] ?? `method_error_${variantId}`;
}

function rpcErrorCode(value: unknown): string {
  const code = integer(value);
  return RPC_ERROR_CODES[code.toString()] ?? `rpc_error_${code}`;
}

function sessionAuthErrorCode(value: SessionAuthErrorCode | undefined): string {
  if (value === undefined) return "SessionAuthError";
  return SESSION_AUTH_ERROR_CODES[value.toString()] ??
    `session_auth_error_${value}`;
}

const RPC_ERROR_CODES: Record<string, string> = {
  "1": "BadMessage",
  "2": "Unauthorized",
  "3": "MissingPayload",
  "4": "NotImplemented",
  "6": "PermissionDenied",
  "7": "NotFound",
  "8": "AlreadyExists",
  "9": "OperationFailed",
  "10": "MalformedPayload",
};

const METHOD_ERROR_CODES: Record<string, string> = {
  "1:1": "PairingNotStarted",
  "1:2": "PairingExpired",
  "2:1": "PairingNotStarted",
  "2:2": "PairingExpired",
  "2:3": "InvalidPairingCode",
  "3:0": "Failed",
  "4:0": "Failed",
  "4:1": "PermissionDenied",
  "4:2": "NotFound",
  "4:3": "NotDirectory",
  "5:0": "Failed",
  "5:1": "PermissionDenied",
  "5:2": "NotFound",
  "5:3": "NotFile",
  "5:4": "InvalidPath",
  "6:0": "Failed",
  "6:1": "PermissionDenied",
  "6:2": "NotFound",
  "6:3": "AlreadyExists",
  "6:4": "NotDirectory",
  "6:5": "NotFile",
  "6:6": "InvalidPath",
  "7:0": "Failed",
  "8:0": "Failed",
  "9:0": "Failed",
};

const SESSION_AUTH_ERROR_CODES: Record<string, string> = {
  "1": "UnsupportedMechanism",
  "2": "InvalidCredentials",
  "3": "MalformedPayload",
  "4": "AlreadyAuthenticated",
};

function integer(value: unknown): number {
  if (typeof value === "number" && Number.isSafeInteger(value)) return value;
  throw new Error("expected integer field");
}

function optionalInteger(value: unknown): number | undefined {
  if (value == null) return undefined;
  return integer(value);
}

function text(value: unknown): string {
  if (typeof value !== "string") throw new Error("expected string field");
  return value;
}

function optionalText(value: unknown): string | undefined {
  if (value == null) return undefined;
  return text(value);
}

function optionalBoolean(value: unknown): boolean | undefined {
  if (value == null) return undefined;
  if (typeof value !== "boolean") throw new Error("expected boolean field");
  return value;
}

function isCborValue(value: unknown): value is CborValue {
  return value === null ||
    typeof value === "boolean" ||
    typeof value === "number" ||
    typeof value === "string" ||
    value instanceof Uint8Array ||
    Array.isArray(value) ||
    value instanceof Map;
}
