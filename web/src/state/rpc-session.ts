import {
  createSignal,
  createMemo,
  createRoot,
  getOwner,
  runWithOwner,
  untrack,
  type Accessor,
} from "solid-js";
import { bunja } from "bunja";
import { nowBunja } from "./now.ts";
import {
  authenticateWebTransport,
  closeWebTransport as closeProtocolWebTransport,
  openWebTransport,
} from "../protocol/client.ts";
import {
  completePairing,
  getDaemonInfo,
  renewClientCredential,
  startPairing,
} from "../protocol/generated/client.ts";
import type { DaemonInfo } from "../protocol/generated/rpc.ts";
import {
  DatagramMessageKind,
  decodeDatagramMessage,
  encodeDatagramMessage,
} from "../protocol/wire.ts";
import { MachineBaseUrlScope } from "./machine-scopes.ts";
import { machineBunja, machineStoreBunja } from "./machine-store.ts";
import type { Machine } from "./machines.ts";
import type { ConnectionState } from "./types.ts";
const CLIENT_CREDENTIAL_RENEWAL_INTERVAL_MS = 24 * 60 * 60 * 1000;
const DATAGRAM_PING_INTERVAL_MS = 5000;
const DATAGRAM_PING_TIMEOUT_MS = 5000;
interface DatagramRuntime {
  closed: boolean;
  nextPingId: number;
  onRtt: (rttMs: number) => void;
  onFailure: () => void;
  pendingPing?: DatagramPing;
  pingInterval: ReturnType<typeof setInterval>;
  writer: WritableStreamDefaultWriter<Uint8Array>;
}
interface DatagramPing {
  pingId: number;
  startedAt: number;
  timeout: ReturnType<typeof setTimeout>;
}
interface ManagedRpcSession {
  closed: boolean;
  generation: number;
  authenticatedClientId?: string;
  datagrams: DatagramRuntime;
  credentialRenewalStarted: boolean;
  transport: WebTransport;
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
  daemonInfo: DaemonInfoState;
}
interface RpcSessionController {
  close: () => void;
  closeRpcSession: () => void;
  completePairingSession: (code: string) => ReturnType<typeof completePairing>;
  reconnect: () => void;
  startPairingSession: (
    confirmationCode: string,
    clientLabel: string,
  ) => ReturnType<typeof startPairing>;
  state: Accessor<RpcSessionState>;
  webTransport: () => Promise<WebTransport>;
}
interface RpcSessionControllerEnv {
  getMachine: () => Machine | undefined;
  machineId: string;
  onAuthenticatedSessionInvalidated: () => void;
  setMachineCredentialExpiry: (
    machineId: string,
    clientCredentialExpiresAtUnix: number,
  ) => void;
}
function initialRpcSessionState(): RpcSessionState {
  return {
    connection: { phase: "idle" },
    daemonInfo: { phase: "idle" },
  };
}
export const rpcSessionBunja = bunja(() => {
  bunja.use(MachineBaseUrlScope);
  const machineState = bunja.use(machineBunja);
  const machines = bunja.use(machineStoreBunja);
  const now = bunja.use(nowBunja);
  const owner = getOwner();
  let activeController: RpcSessionController | undefined;
  const idleRpcSessionState = initialRpcSessionState();
  const [activeControllerValue, writeActiveController] = createSignal<
    RpcSessionController | undefined
  >(undefined);
  const rpcSession = createMemo<RpcSessionState>(() => {
    const controller = activeControllerValue();
    if (!controller) return idleRpcSessionState;
    return controller.state();
  });
  const connection = createMemo(() => rpcSession().connection);
  const daemonInfo = createMemo(() => rpcSession().daemonInfo);
  const daemonInstanceId = createMemo(() => {
    const info = daemonInfo();
    return info.phase === "ready" ? info.daemonInfo.instanceId : undefined;
  });
  const daemonServerTimeMs = createMemo(() => {
    const info = daemonInfo();
    if (info.phase !== "ready") return undefined;
    const { serverTimeMs } = info.daemonInfo;
    if (serverTimeMs <= 0) return undefined;
    const elapsedMs = Math.max(0, now.nowEverySecond() - info.receivedAtMs);
    return serverTimeMs + elapsedMs;
  });
  const daemonUptimeSeconds = createMemo(() => {
    const info = daemonInfo();
    if (info.phase !== "ready") return undefined;
    const { startedAtMs } = info.daemonInfo;
    if (startedAtMs <= 0) return undefined;
    const serverTime = daemonServerTimeMs();
    if (serverTime === undefined) return undefined;
    const uptimeSeconds = Math.floor((serverTime - startedAtMs) / 1000);
    return Math.max(0, uptimeSeconds);
  });
  bunja.effect(() => {
    replaceController();
    return () => {
      disposeController();
    };
  });
  function controller(): RpcSessionController {
    const current = activeController;
    if (current) return current;
    const controller = instantiateController();
    if (!controller) {
      throw new Error("missing machine");
    }
    setActiveController(controller);
    return controller;
  }
  function replaceController() {
    disposeController();
    setActiveController(instantiateController());
  }
  function disposeController() {
    activeController?.close();
    setActiveController(undefined);
  }
  function setActiveController(controller: RpcSessionController | undefined) {
    activeController = controller;
    writeActiveController(controller);
  }
  function instantiateController(): RpcSessionController | undefined {
    const machineId = machineState.machineId;
    if (!machineId || !untrack(machineState.machine)) {
      return undefined;
    }
    const created = runWithOwner(owner, () =>
      createRoot((dispose) => {
        const controller = createRpcSessionController(
          controllerEnv(machineId, () => {
            if (activeController === rpcController)
              rpcController.closeRpcSession();
          }),
        );
        const rpcController: RpcSessionController = {
          ...controller,
          close() {
            controller.close();
            dispose();
          },
        };
        return rpcController;
      }),
    );
    created.reconnect();
    return created;
  }
  function controllerEnv(
    machineId: string,
    onAuthenticatedSessionInvalidated: () => void,
  ): RpcSessionControllerEnv {
    return {
      getMachine: () => machines.findMachine(machineId),
      machineId,
      onAuthenticatedSessionInvalidated,
      setMachineCredentialExpiry: machines.setMachineCredentialExpiry,
    };
  }
  function closeRpcSession() {
    activeController?.closeRpcSession();
  }
  function reconnect() {
    activeController?.reconnect();
  }
  function resetController() {
    replaceController();
  }
  function startPairingSession(confirmationCode: string, clientLabel: string) {
    return controller().startPairingSession(confirmationCode, clientLabel);
  }
  function completePairingSession(code: string) {
    return controller().completePairingSession(code);
  }
  function webTransport(): Promise<WebTransport> {
    return controller().webTransport();
  }
  return {
    closeRpcSession,
    connection,
    daemonInfo,
    daemonInstanceId,
    daemonServerTimeMs,
    daemonUptimeSeconds,
    completePairingSession,
    reconnect,
    resetController,
    startPairingSession,
    webTransport,
  };
});
function createRpcSessionController(
  env: RpcSessionControllerEnv,
): RpcSessionController {
  let closed = false;
  let sessionGeneration = 0;
  let pairingStarted = false;
  let rpcSession: Promise<ManagedRpcSession> | undefined;
  const [state, setState] = createSignal<RpcSessionState>(
    initialRpcSessionState(),
  );
  const rpcController: RpcSessionController = {
    close,
    closeRpcSession,
    completePairingSession,
    reconnect,
    startPairingSession,
    state,
    webTransport: authenticatedWebTransport,
  };
  function close() {
    if (closed) return;
    closed = true;
    closeRpcSession();
  }
  function reconnect() {
    closeRpcSession();
    void openInitialSession();
  }
  async function openInitialSession(): Promise<void> {
    const generation = sessionGeneration;
    try {
      await getRpcSession();
    } catch {
      if (!closed && generation === sessionGeneration) setConnectionOffline();
    }
  }
  function authenticatedRpcSession(): Promise<ManagedRpcSession> {
    const machine = currentMachine();
    if (!machine?.clientId || !machine.clientSecret) {
      throw new Error("missing paired client credentials");
    }
    return getAuthenticatedRpcSession(machine);
  }
  async function authenticatedWebTransport(): Promise<WebTransport> {
    return (await authenticatedRpcSession()).transport;
  }
  function getRpcSession(): Promise<ManagedRpcSession> {
    if (rpcSession) return rpcSession;
    const machine = currentMachine();
    if (!machine) throw new Error("missing machine");
    const session = openRpcSession(machine, sessionGeneration);
    rpcSession = session;
    session.catch(() => {
      if (rpcSession === session) {
        rpcSession = undefined;
        if (!closed) setConnectionOffline();
      }
    });
    return session;
  }
  async function getAuthenticatedRpcSession(
    machine: Machine,
  ): Promise<ManagedRpcSession> {
    const session = await getRpcSession();
    await authenticateManagedSession(session, machine);
    return session;
  }
  async function openRpcSession(
    machine: Machine,
    generation: number,
  ): Promise<ManagedRpcSession> {
    const session = manageRpcSession(
      await openWebTransport(machine),
      generation,
      (rttMs) => {
        if (!closed && generation === sessionGeneration) setDatagramRtt(rttMs);
      },
      () => {
        if (closed || generation !== sessionGeneration) return;
        rpcSession = undefined;
        pairingStarted = false;
        sessionGeneration++;
        setConnectionOffline();
      },
    );
    if (closed || generation !== sessionGeneration) {
      closeManagedRpcSession(session);
      throw new Error("RPC session was closed");
    }
    if (machine.clientId && machine.clientSecret) {
      try {
        await authenticateManagedSession(session, machine);
      } catch (err) {
        closeManagedRpcSession(session);
        throw err;
      }
      if (closed || generation !== sessionGeneration) {
        closeManagedRpcSession(session);
        throw new Error("RPC session was closed");
      }
      await renewCredential(session);
      if (closed || generation !== sessionGeneration) {
        closeManagedRpcSession(session);
        throw new Error("RPC session was closed");
      }
    }
    setState((state) => ({
      ...state,
      connection: { phase: "reachable" },
      daemonInfo: { phase: "loading" },
    }));
    void refreshDaemonInfoForCurrentMachine({ loadingAlreadySet: true });
    return session;
  }
  async function renewCredential(session: ManagedRpcSession): Promise<void> {
    const machine = currentMachine();
    if (
      closed ||
      session.generation !== sessionGeneration ||
      !machine?.clientId ||
      !machine.clientSecret
    )
      return;
    try {
      const renewal = await renewClientCredential(session.transport);
      if (closed || session.generation !== sessionGeneration) return;
      if (
        currentMachine()?.clientId === session.authenticatedClientId &&
        currentMachine()?.clientSecret === machine.clientSecret
      ) {
        env.setMachineCredentialExpiry(
          machine.id,
          renewal.clientCredentialExpiresAtUnix,
        );
      }
    } catch {
      // A valid session can still be useful even if credential renewal fails.
      // The next renewal tick or authenticated session will retry.
    }
  }
  function startCredentialRenewalLoop(session: ManagedRpcSession): void {
    if (session.credentialRenewalStarted) return;
    session.credentialRenewalStarted = true;
    const timer = setInterval(
      () => void renewCredential(session),
      CLIENT_CREDENTIAL_RENEWAL_INTERVAL_MS,
    );
    session.transport.closed
      .catch(() => {})
      .finally(() => clearInterval(timer));
  }
  function closeRpcSession() {
    sessionGeneration++;
    pairingStarted = false;
    const session = rpcSession;
    rpcSession = undefined;
    session?.then(closeManagedRpcSession).catch(() => {});
    if (!closed) setConnectionOffline();
  }
  async function startPairingSession(
    confirmationCode: string,
    clientLabel: string,
  ) {
    const machine = currentMachine();
    if (!machine) throw new Error("missing machine");
    pairingStarted = false;
    return await withControllerRpcSession(getRpcSession(), async (session) => {
      const response = await startPairing(session.transport, {
        confirmationCode,
        clientLabel,
        clientId: machine.clientId,
      });
      pairingStarted = true;
      return response;
    });
  }
  async function completePairingSession(code: string) {
    if (!pairingStarted || !rpcSession) {
      throw new Error("Pairing was not started on this connection");
    }
    const credentials = await withControllerRpcSession(rpcSession, (session) =>
      completePairing(session.transport, { code }),
    );
    const session = await rpcSession;
    await authenticateManagedSessionWithCredential(
      session,
      credentials.clientId,
      credentials.clientSecret,
    );
    return credentials;
  }
  async function withControllerRpcSession<T>(
    session: Promise<ManagedRpcSession>,
    run: (session: ManagedRpcSession) => Promise<T>,
  ): Promise<T> {
    const managedSession = await session;
    if (!isControllerRpcSession(session)) {
      closeManagedRpcSession(managedSession);
      throw new Error("Pairing was not started on this connection");
    }
    return run(managedSession);
  }
  function isControllerRpcSession(
    session: Promise<ManagedRpcSession>,
  ): boolean {
    return !closed && rpcSession === session;
  }
  function currentMachine(): Machine | undefined {
    return env.getMachine();
  }
  async function authenticateManagedSession(
    session: ManagedRpcSession,
    machine: Machine,
  ): Promise<void> {
    if (!machine.clientId || !machine.clientSecret) {
      throw new Error("missing paired client credentials");
    }
    await authenticateManagedSessionWithCredential(
      session,
      machine.clientId,
      machine.clientSecret,
    );
  }
  async function authenticateManagedSessionWithCredential(
    session: ManagedRpcSession,
    clientId: string,
    clientSecret: string,
  ): Promise<void> {
    if (session.authenticatedClientId === clientId) return;
    await authenticateWebTransport(session.transport, clientId, clientSecret);
    session.authenticatedClientId = clientId;
    startCredentialRenewalLoop(session);
  }
  async function refreshDaemonInfoForCurrentMachine(
    options: {
      loadingAlreadySet?: boolean;
    } = {},
  ): Promise<void> {
    const generation = sessionGeneration;
    if (!options.loadingAlreadySet) {
      setState((state) => ({
        ...state,
        daemonInfo: { phase: "loading" },
      }));
    }
    try {
      const session = await getRpcSession();
      if (closed || generation !== sessionGeneration) return;
      const daemonInfo = await getDaemonInfo(session.transport);
      if (closed || generation !== sessionGeneration) return;
      setState((state) => ({
        ...state,
        daemonInfo: {
          phase: "ready",
          daemonInfo,
          receivedAtMs: Date.now(),
        },
      }));
    } catch (err) {
      if (closed || generation !== sessionGeneration) return;
      setState((state) => ({
        ...state,
        daemonInfo: {
          phase: "error",
          message: err instanceof Error ? err.message : String(err),
        },
      }));
    }
  }
  function setConnectionOffline() {
    setState((state) => ({
      ...state,
      connection: { phase: "offline" },
      daemonInfo: { phase: "idle" },
    }));
  }
  function setDatagramRtt(rttMs: number) {
    setState((state) => {
      if (state.connection.phase !== "reachable") return state;
      return {
        ...state,
        connection: { ...state.connection, rttMs },
      };
    });
  }
  return rpcController;
}
function manageRpcSession(
  transport: WebTransport,
  generation: number,
  onDatagramRtt: (rttMs: number) => void,
  onFailure: () => void,
): ManagedRpcSession {
  const managed: ManagedRpcSession = {
    closed: false,
    generation,
    authenticatedClientId: undefined,
    datagrams: startDatagramRuntime(transport, onDatagramRtt, fail),
    credentialRenewalStarted: false,
    transport,
  };
  // Observe loss as soon as transport.ready resolves, including while auth or
  // credential renewal is still pending. Both clean close and rejection count.
  transport.closed.then(fail, fail);
  function fail() {
    if (managed.closed) return;
    closeManagedRpcSession(managed);
    onFailure();
  }
  return managed;
}
function closeManagedRpcSession(session: ManagedRpcSession): void {
  if (session.closed) return;
  session.closed = true;
  closeDatagramRuntime(session.datagrams);
  closeProtocolWebTransport(session.transport);
}
function startDatagramRuntime(
  transport: WebTransport,
  onRtt: (rttMs: number) => void,
  onFailure: () => void,
): DatagramRuntime {
  const runtime: DatagramRuntime = {
    closed: false,
    nextPingId: 0,
    onRtt,
    onFailure,
    pingInterval: setInterval(
      () => sendDatagramPing(runtime),
      DATAGRAM_PING_INTERVAL_MS,
    ),
    writer: transport.datagrams.writable.getWriter(),
  };
  void readDatagrams(transport, runtime);
  sendDatagramPing(runtime);
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
      if (runtime.closed) break;
      if (done) {
        failDatagramRuntime(runtime);
        break;
      }
      await handleIncomingDatagram(runtime, value);
    }
  } catch {
    failDatagramRuntime(runtime);
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
      await runtime.writer.write(
        encodeDatagramMessage({
          kind: DatagramMessageKind.Pong,
          pingId: message.pingId,
        }),
      );
    } catch {
      failDatagramRuntime(runtime);
    }
    return;
  }
  if (message.kind === DatagramMessageKind.Pong) {
    const pending = runtime.pendingPing;
    if (!pending || pending.pingId !== message.pingId) return;
    clearPendingDatagramPing(runtime);
    runtime.onRtt(
      Math.max(1, Math.round(performance.now() - pending.startedAt)),
    );
  }
}
function sendDatagramPing(runtime: DatagramRuntime): void {
  // Keep the outstanding deadline. The interval must not replace a ping just
  // before its timeout fires (both timers use the same interval).
  if (runtime.closed || runtime.pendingPing) return;
  const pingId = nextDatagramPingId(runtime);
  const pending: DatagramPing = {
    pingId,
    startedAt: performance.now(),
    timeout: setTimeout(() => {
      if (runtime.pendingPing !== pending) return;
      failDatagramRuntime(runtime);
    }, DATAGRAM_PING_TIMEOUT_MS),
  };
  runtime.pendingPing = pending;
  runtime.writer
    .write(
      encodeDatagramMessage({
        kind: DatagramMessageKind.Ping,
        pingId,
      }),
    )
    .catch(() => {
      if (runtime.pendingPing === pending) clearPendingDatagramPing(runtime);
      failDatagramRuntime(runtime);
    });
}
function nextDatagramPingId(runtime: DatagramRuntime): number {
  runtime.nextPingId =
    runtime.nextPingId >= Number.MAX_SAFE_INTEGER ? 1 : runtime.nextPingId + 1;
  return runtime.nextPingId;
}
function clearPendingDatagramPing(runtime: DatagramRuntime): void {
  if (!runtime.pendingPing) return;
  clearTimeout(runtime.pendingPing.timeout);
  runtime.pendingPing = undefined;
}
function failDatagramRuntime(runtime: DatagramRuntime): void {
  if (runtime.closed) return;
  closeDatagramRuntime(runtime);
  runtime.onFailure();
}
function closeDatagramRuntime(runtime: DatagramRuntime): void {
  if (runtime.closed) return;
  runtime.closed = true;
  clearInterval(runtime.pingInterval);
  clearPendingDatagramPing(runtime);
  try {
    runtime.writer.releaseLock();
  } catch {
    // The writer may be in an errored state after transport shutdown.
  }
}
