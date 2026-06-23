import { createContext } from "react";
import { bunja } from "bunja";
import { createScopeFromContext } from "bunja/react";
import { atom } from "jotai";
import { nowBunja } from "unsaturated/now";
import { JotaiStoreScope } from "unsaturated/store";
import {
  authenticateWebTransport,
  closeWebTransport as closeProtocolWebTransport,
  type DaemonInfo,
  getDaemonInfo,
  openWebTransport,
  renewWebTransportCredential,
  type RpcCallOptions,
} from "../protocol/rpc.ts";
import {
  DatagramMessageKind,
  decodeDatagramMessage,
  encodeDatagramMessage,
} from "../protocol/wire.ts";
import { machineBunja, machineStoreBunja } from "./machine-store.ts";
import type { Machine } from "./machines.ts";
import { normalizeMachineUrl } from "./machines.ts";
import type { ConnectionState } from "./types.ts";

const CLIENT_CREDENTIAL_RENEWAL_INTERVAL_MS = 24 * 60 * 60 * 1000;
const DATAGRAM_PING_TIMEOUT_MS = 5_000;
const STATUS_PING_INTERVAL_MS = 5_000;

interface DatagramRuntime {
  closed: boolean;
  nextPingId: number;
  pendingPings: Map<number, PendingDatagramPing>;
  writer: WritableStreamDefaultWriter<Uint8Array>;
}

interface ManagedRpcSession {
  datagrams: DatagramRuntime;
  transport: WebTransport;
}

interface PendingDatagramPing {
  reject: (err: Error) => void;
  resolve: (latencyMs: number) => void;
  startedAt: number;
  timeout: ReturnType<typeof setTimeout>;
}

interface IdleDaemonInfoState {
  phase: "idle";
}

interface LoadingDaemonInfoState {
  phase: "loading";
}

interface ReadyDaemonInfoState {
  daemonInfo: DaemonInfo;
  phase: "ready";
  receivedAtMs: number;
}

interface ErrorDaemonInfoState {
  message: string;
  phase: "error";
}

export type DaemonInfoState =
  | IdleDaemonInfoState
  | LoadingDaemonInfoState
  | ReadyDaemonInfoState
  | ErrorDaemonInfoState;

interface RpcSessionState {
  connection: ConnectionState;
  connectionEpoch: number;
  daemonInfo: DaemonInfoState;
}

interface ReachabilityResult {
  latencyMs?: number;
}

export const RpcSessionKeyContext = createContext<string | undefined>(
  undefined,
);
export const RpcSessionKeyScope = createScopeFromContext(
  RpcSessionKeyContext,
);

export const rpcSessionBunja = bunja(() => {
  const store = bunja.use(JotaiStoreScope);
  const machineState = bunja.use(machineBunja);
  const machines = bunja.use(machineStoreBunja);
  const now = bunja.use(nowBunja);
  const rpcSessionKey = bunja.use(RpcSessionKeyScope);
  let current: Promise<ManagedRpcSession> | undefined;
  let pingGeneration = 0;
  let daemonInfoGeneration = 0;
  let stopped = false;
  let pingTimer: ReturnType<typeof setTimeout> | undefined;

  const rpcSessionAtom = atom<RpcSessionState>({
    connection: {
      phase: "idle",
      message: "No machine selected",
    },
    connectionEpoch: 0,
    daemonInfo: { phase: "idle" },
  });
  const connectionAtom = atom((get) => get(rpcSessionAtom).connection);
  const connectionEpochAtom = atom((get) =>
    get(rpcSessionAtom).connectionEpoch
  );
  const daemonInfoAtom = atom((get) => get(rpcSessionAtom).daemonInfo);
  const daemonServerTimeMsAtom = atom((get) => {
    const daemonInfo = get(daemonInfoAtom);
    if (daemonInfo.phase !== "ready") return undefined;
    const { serverTimeMs } = daemonInfo.daemonInfo;
    if (serverTimeMs <= 0) return undefined;
    const elapsedMs = Math.max(
      0,
      get(now.nowEverySecondAtom) - daemonInfo.receivedAtMs,
    );
    return serverTimeMs + elapsedMs;
  });
  const daemonUptimeSecondsAtom = atom((get) => {
    const daemonInfo = get(daemonInfoAtom);
    if (daemonInfo.phase !== "ready") return undefined;
    const { startedAtMs } = daemonInfo.daemonInfo;
    if (startedAtMs <= 0) return undefined;
    const daemonServerTimeMs = get(daemonServerTimeMsAtom);
    if (daemonServerTimeMs === undefined) return undefined;
    const uptimeSeconds = Math.floor(
      (daemonServerTimeMs - startedAtMs) / 1000,
    );
    return Math.max(0, uptimeSeconds);
  });
  const selectedConnectionKeyAtom = atom((get) =>
    connectionKey(get(machineState.machineAtom))
  );

  bunja.effect(() => () => {
    stopped = true;
    nextPingGeneration();
    clearPingTimer();
    closeRpcSession();
  });

  bunja.effect(() => {
    const unsubscribe = store.sub(selectedConnectionKeyAtom, restartPingLoop);
    restartPingLoop();
    return () => {
      stopped = true;
      nextPingGeneration();
      clearPingTimer();
      unsubscribe();
    };
  });

  function authenticatedRpcSession(): Promise<ManagedRpcSession> {
    if (!rpcSessionKey) {
      return openAuthenticatedWebTransport();
    }
    if (current) return current;
    const session = openAuthenticatedWebTransport();
    current = session;
    session.then((rpcSession) => {
      rpcSession.transport.closed.catch(() => {}).finally(() => {
        if (current === session) current = undefined;
        if (!stopped) handleTransportClosed();
      });
    }).catch(() => {
      if (current === session) current = undefined;
    });
    return session;
  }

  async function authenticatedWebTransport(): Promise<WebTransport> {
    return (await authenticatedRpcSession()).transport;
  }

  async function openAuthenticatedWebTransport(): Promise<
    ManagedRpcSession
  > {
    const machine = store.get(machineState.machineAtom);
    if (!machine?.clientId || !machine.clientSecret) {
      throw new Error("missing paired client credentials");
    }
    const session = manageRpcSession(
      await openWebTransport(machine, "/rpc"),
    );
    try {
      await authenticateWebTransport(
        session.transport,
        machine.clientId,
        machine.clientSecret,
      );
    } catch (err) {
      closeManagedRpcSession(session);
      throw err;
    }
    await renewCredential(session);
    startCredentialRenewalLoop(session);
    markReachable("Connected", undefined, { phase: "loading" });
    void refreshDaemonInfoForCurrentMachine({ loadingAlreadySet: true });
    return session;
  }

  async function renewCredential(session: ManagedRpcSession): Promise<void> {
    const machine = store.get(machineState.machineAtom);
    if (!machine?.clientId || !machine.clientSecret) return;
    await renewWebTransportCredential(
      machine,
      session.transport,
      machines.rpcCallOptions(),
    );
  }

  function startCredentialRenewalLoop(session: ManagedRpcSession): void {
    const timer = setInterval(
      () => void renewCredential(session),
      CLIENT_CREDENTIAL_RENEWAL_INTERVAL_MS,
    );
    session.transport.closed
      .catch(() => {})
      .finally(() => clearInterval(timer));
  }

  function closeRpcSession() {
    const session = current;
    current = undefined;
    session?.then(closeManagedRpcSession).catch(() => {});
  }

  function reconnect() {
    closeRpcSession();
    restartPingLoop();
  }

  function rpcCallOptions(): Pick<
    RpcCallOptions,
    "closeRpcSession" | "rpcSession"
  > {
    return {
      closeRpcSession,
      rpcSession: authenticatedWebTransport,
    };
  }

  function setChecking(
    message: string,
    options: { clearDaemonInfo?: boolean } = {},
  ) {
    store.set(rpcSessionAtom, (state) => ({
      ...state,
      connection: { phase: "checking", message },
      daemonInfo: options.clearDaemonInfo
        ? { phase: "idle" }
        : state.daemonInfo,
    }));
  }

  function markReachable(
    message: string,
    latencyMs?: number,
    daemonInfoOnReconnect?: DaemonInfoState,
  ): boolean {
    const state = store.get(rpcSessionAtom);
    const becameReachable = state.connection.phase !== "reachable";
    store.set(rpcSessionAtom, {
      ...state,
      connection: { phase: "reachable", message, latencyMs },
      connectionEpoch: becameReachable
        ? state.connectionEpoch + 1
        : state.connectionEpoch,
      daemonInfo: becameReachable && daemonInfoOnReconnect
        ? daemonInfoOnReconnect
        : state.daemonInfo,
    });
    return becameReachable;
  }

  function markOffline(message: string) {
    store.set(rpcSessionAtom, (state) => ({
      ...state,
      connection: { phase: "offline", message },
      daemonInfo: { phase: "idle" },
    }));
  }

  function restartPingLoop() {
    clearPingTimer();
    const generation = nextPingGeneration();
    const machine = store.get(machineState.machineAtom);
    if (!machine) {
      store.set(rpcSessionAtom, (state) => ({
        ...state,
        connection: {
          phase: "idle",
          message: "No machine selected",
        },
        daemonInfo: { phase: "idle" },
      }));
      return;
    }
    void pingStatus(machine, true, generation);
  }

  async function pingStatus(
    machine: Machine,
    showChecking: boolean,
    generation: number,
  ) {
    const key = connectionKey(machine);
    if (showChecking) {
      setChecking("Checking transport", { clearDaemonInfo: true });
    }

    try {
      const reachability = await checkReachable(machine);
      if (!isCurrentPing(generation, key)) return;
      const becameReachable = markReachable(
        formatReachability(reachability),
        reachability.latencyMs,
        { phase: "loading" },
      );
      if (becameReachable) {
        void refreshDaemonInfoForCurrentMachine({ loadingAlreadySet: true });
      }
    } catch (err) {
      if (!isCurrentPing(generation, key)) return;
      markOffline(connectionErrorMessage(err, machine));
    } finally {
      if (isCurrentPing(generation, key)) {
        schedulePing(machine, generation, STATUS_PING_INTERVAL_MS);
      }
    }
  }

  function handleTransportClosed() {
    const machine = store.get(machineState.machineAtom);
    if (!machine) return;
    markOffline("Connection lost");
    const generation = nextPingGeneration();
    clearPingTimer();
    schedulePing(machine, generation, 0);
  }

  async function refreshDaemonInfoForCurrentMachine(
    options: { loadingAlreadySet?: boolean } = {},
  ): Promise<void> {
    const generation = ++daemonInfoGeneration;
    const machine = store.get(machineState.machineAtom);
    const key = connectionKey(machine);
    if (!machine) {
      store.set(rpcSessionAtom, (state) => ({
        ...state,
        daemonInfo: { phase: "idle" },
      }));
      return;
    }

    if (!options.loadingAlreadySet) {
      store.set(rpcSessionAtom, (state) => ({
        ...state,
        daemonInfo: { phase: "loading" },
      }));
    }
    try {
      const daemonInfo = await getDaemonInfo(machine);
      if (generation !== daemonInfoGeneration) return;
      if (key !== connectionKey(store.get(machineState.machineAtom))) return;
      store.set(rpcSessionAtom, (state) => ({
        ...state,
        daemonInfo: {
          phase: "ready",
          daemonInfo,
          receivedAtMs: Date.now(),
        },
      }));
    } catch (err) {
      if (generation !== daemonInfoGeneration) return;
      if (key !== connectionKey(store.get(machineState.machineAtom))) return;
      store.set(rpcSessionAtom, (state) => ({
        ...state,
        daemonInfo: {
          phase: "error",
          message: err instanceof Error ? err.message : String(err),
        },
      }));
    }
  }

  function schedulePing(
    machine: Machine,
    generation: number,
    delayMs: number,
  ) {
    pingTimer = setTimeout(
      () => void pingStatus(machine, false, generation),
      delayMs,
    );
  }

  function clearPingTimer() {
    if (pingTimer !== undefined) {
      clearTimeout(pingTimer);
      pingTimer = undefined;
    }
  }

  function nextPingGeneration(): number {
    pingGeneration += 1;
    return pingGeneration;
  }

  function isCurrentPing(generation: number, key: string): boolean {
    return !stopped &&
      pingGeneration === generation &&
      store.get(selectedConnectionKeyAtom) === key;
  }

  async function checkReachable(machine: Machine): Promise<ReachabilityResult> {
    const startedAt = performance.now();
    if (machine.clientId && machine.clientSecret) {
      const session = await authenticatedRpcSession();
      try {
        return {
          latencyMs: await pingDatagram(session.datagrams),
        };
      } catch (err) {
        if (err instanceof DatagramPingTimeoutError) return {};
        closeRpcSession();
        throw err;
      }
    }

    const session = await openWebTransport(machine, "/rpc");
    try {
      return { latencyMs: performance.now() - startedAt };
    } finally {
      closeProtocolWebTransport(session);
    }
  }

  return {
    closeRpcSession,
    connectionAtom,
    connectionEpochAtom,
    daemonInfoAtom,
    daemonServerTimeMsAtom,
    daemonUptimeSecondsAtom,
    markOffline,
    markReachable,
    reconnect,
    rpcCallOptions,
    setChecking,
  };
});

class DatagramPingTimeoutError extends Error {
  constructor(timeoutMs: number) {
    super(`datagram pong timed out after ${timeoutMs}ms`);
    this.name = "DatagramPingTimeoutError";
  }
}

function manageRpcSession(
  transport: WebTransport,
): ManagedRpcSession {
  const managed = {
    datagrams: startDatagramRuntime(transport),
    transport,
  };
  transport.closed
    .catch(() => {})
    .finally(() => {
      closeDatagramRuntime(
        managed.datagrams,
        new Error("WebTransport session closed"),
      );
    });
  return managed;
}

function closeManagedRpcSession(
  session: ManagedRpcSession,
): void {
  closeDatagramRuntime(
    session.datagrams,
    new Error("RPC session closed"),
  );
  closeProtocolWebTransport(session.transport);
}

function startDatagramRuntime(transport: WebTransport): DatagramRuntime {
  const runtime: DatagramRuntime = {
    closed: false,
    nextPingId: 0,
    pendingPings: new Map(),
    writer: transport.datagrams.writable.getWriter(),
  };
  void readDatagrams(transport, runtime);
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
      reject,
      resolve,
      startedAt,
      timeout,
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

export function rpcSessionKeyForMachine(
  machine?: Machine,
): string | undefined {
  if (!machine?.clientId || !machine.clientSecret) return undefined;
  return [
    machine.id,
    normalizeMachineUrl(machine.baseUrl),
    machine.clientId,
    machine.clientSecret,
  ].join("\n");
}

function connectionKey(machine?: Machine): string {
  if (!machine) return "";
  return [
    machine.id,
    machine.baseUrl,
    machine.clientId ?? "",
    machine.clientSecret ?? "",
  ].join("\n");
}

function formatReachability(reachability: ReachabilityResult): string {
  if (reachability.latencyMs === undefined) return "Connected";
  return `${Math.max(1, Math.round(reachability.latencyMs))}ms`;
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

export function connectionErrorMessage(
  err: unknown,
  machine?: Machine,
): string {
  const message = errorMessage(err);
  if (!message.toLowerCase().includes("handshake")) return message;

  const host = machine ? safeHost(machine.baseUrl) : "";
  if (host === "localhost" || host === "127.0.0.1" || host === "::1") {
    return "WebTransport TLS handshake failed. Use the daemon URL printed by the pairing command; localhost will fail when the daemon certificate is issued for another host.";
  }
  return "WebTransport TLS handshake failed. Check that the daemon URL matches a trusted certificate host.";
}

function safeHost(raw: string): string {
  try {
    return new URL(raw).hostname.toLowerCase();
  } catch {
    return "";
  }
}
