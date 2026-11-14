import { style } from "../../../../zyzz.config.ts";
import {
  createEffect,
  createSignal,
  createMemo,
  Show,
  onCleanup,
  untrack,
} from "solid-js";

import { useBunja } from "bunja/solid";
import type { FitAddon } from "@xterm/addon-fit";
import type { Terminal as XTerm } from "@xterm/xterm";
import "@xterm/xterm/css/xterm.css";
import { HardDrive, KeyRound, Loader2 } from "../../../../solid/icons.tsx";
import {
  closeTerminalSession,
  createTerminalSession,
  takeTerminalControl,
  writeTerminalInput,
} from "../../../../protocol/generated/client.ts";
import { TerminalInputStream } from "./input-stream.ts";
import {
  allowsNewTerminalInput,
  allowsTerminalControlRequest,
  requestTerminalAttachControl,
  terminalAttachControl,
  type TerminalAttachControl,
} from "./attach-control.ts";
import { callServerStream, RpcError } from "../../../../protocol/client.ts";
import { attachTerminalSessionProc } from "../../../../protocol/generated/rpc.ts";
import type {
  WriteTerminalInputReq,
  TerminalEvent,
  TerminalExit,
  TerminalLaunchSpec,
  TerminalSessionCloseReason,
  TerminalSessionInfo,
} from "../../../../protocol/generated/rpc.ts";
import { machineModalBunja } from "../../../../state/machine-modal.ts";
import { machineStoreBunja } from "../../../../state/machine-store.ts";
import type { Machine } from "../../../../state/machines.ts";
import { rpcSessionBunja } from "../../../../state/rpc-session.ts";
import {
  workbenchTabBunja,
  type WorkbenchTerminalSessionSnapshot,
} from "../../../../state/workbench.ts";
import { Button } from "../../../ui/button.tsx";

interface TerminalRuntime {
  terminal: XTerm;
  fitAddon: FitAddon;
  inputDisposable: {
    dispose: () => void;
  };
  replayQueryDisposables: Array<{
    dispose: () => void;
  }>;
  resizeObserver: ResizeObserver;
}
interface DeferredTerminalResize {
  generation: number;
  attachId: string;
  control: TerminalAttachControl | undefined;
  waitingOn?: Promise<void>;
}
interface TerminalStatus {
  phase:
    | "idle"
    | "waiting"
    | "attached"
    | "viewing"
    | "closed"
    | "missing"
    | "error";
  message: string;
}
interface TerminalNotice {
  actionLabel: string;
  presentation: "banner" | "overlay";
  message: string;
  title: string;
}
interface OpenTerminalOptions {
  cwd?: string;
  existingSessionId?: string;
  launch?: TerminalLaunchSpec;
  title?: string;
}
export function TerminalTool() {
  const machineStore = useBunja(machineStoreBunja);
  const machineModal = useBunja(machineModalBunja);
  const rpcSession = useBunja(rpcSessionBunja);
  const tabState = useBunja(workbenchTabBunja);
  const machine = () => machineStore().selected();
  const isPaired = () => machineStore().selectedIsPaired();
  const daemonInstanceId = () => rpcSession().daemonInstanceId();
  const tab = () => tabState().tab();
  const focused = () => tabState().focused();
  const [hostElement, setHostElement] = createSignal<HTMLDivElement>();
  const machineRef = { current: undefined as Machine | undefined };
  const activeRef = { current: false };
  const runtimeRef = { current: undefined as TerminalRuntime | undefined };
  const terminalSessionIdRef = { current: undefined as string | undefined };
  const attachIdRef = { current: undefined as string | undefined };
  const primaryAttachIdRef = { current: undefined as string | undefined };
  const attachControlRef = {
    current: undefined as TerminalAttachControl | undefined,
  };
  const controlVersionRef = { current: 0 };
  const latestSeqRef = { current: undefined as number | undefined };
  const stopAttachRef = { current: undefined as (() => void) | undefined };
  const generationRef = { current: 0 };
  const inputStreamRef = {
    current: undefined as TerminalInputStream | undefined,
  };
  const takeControlPromiseRef = {
    current: undefined as Promise<void> | undefined,
  };
  const deferredResizeRef = {
    current: undefined as DeferredTerminalResize | undefined,
  };
  const replayOutputUntilSeqRef = { current: undefined as number | undefined };
  const suppressReplayGeneratedInputRef = { current: false };
  const replayWriteDepthRef = { current: 0 };
  const persistedSessionSnapshotKeyRef = {
    current: undefined as string | undefined,
  };
  const terminalSessionFinishedRef = { current: false };
  const xtermReadyPromiseRef = {
    current: undefined as Promise<TerminalRuntime | undefined> | undefined,
  };
  const lastSizeRef = {
    current: undefined as
      | {
          cols: number;
          rows: number;
        }
      | undefined,
  };
  const [status, setStatus] = createSignal<TerminalStatus>({
    phase: "waiting",
    message: "Waiting for terminal",
  });
  const [terminalDimensions, setTerminalDimensions] = createSignal({
    cols: 80,
    rows: 24,
  });
  const [sessionInfo, setSessionInfo] = createSignal<TerminalSessionInfo>();
  createEffect(machine, (value) => {
    machineRef.current = value;
  });
  createEffect(focused, (value) => {
    activeRef.current = value;
  });
  createEffect(focused, (value) => {
    if (!value) return;
    fitTerminal();
    void takeCurrentControl(true);
  });
  createEffect(
    () => ({ info: sessionInfo(), state: tabState() }),
    ({ info, state }) => {
      if (!info) {
        persistedSessionSnapshotKeyRef.current = undefined;
        return;
      }
      const snapshot: WorkbenchTerminalSessionSnapshot = {
        lastKnownCwd: info.lastKnownCwd,
        lastKnownTitle: info.lastKnownTitle,
        launch: info.launch,
      };
      const snapshotKey = terminalSessionSnapshotKey(snapshot);
      if (persistedSessionSnapshotKeyRef.current === snapshotKey) return;
      persistedSessionSnapshotKeyRef.current = snapshotKey;
      state.setTerminalSessionSnapshot(snapshot);
    },
  );
  createEffect(hostElement, (host) => {
    if (!host) return;
    let disposed = false;
    const readyPromise = setupXtermRuntime(host).then((runtime) => {
      if (disposed || !runtime) {
        disposeTerminalRuntime(runtime);
        return undefined;
      }
      runtimeRef.current = runtime;
      return runtime;
    });
    xtermReadyPromiseRef.current = readyPromise;
    return () => {
      disposed = true;
      stopCurrentAttach();
      disposeTerminalRuntime(runtimeRef.current);
      runtimeRef.current = undefined;
      xtermReadyPromiseRef.current = undefined;
    };
  });
  async function setupXtermRuntime(
    host: HTMLDivElement,
  ): Promise<TerminalRuntime | undefined> {
    const [{ Terminal }, { FitAddon }] = await Promise.all([
      import("@xterm/xterm"),
      import("@xterm/addon-fit"),
    ]);
    if (!host.isConnected) return undefined;
    const terminal = new Terminal({
      cursorBlink: true,
      fontFamily: "Cascadia Mono, CaskaydiaCove Nerd Font, Consolas, monospace",
      fontSize: 13,
      lineHeight: 1.15,
      scrollback: 5000,
      theme: {
        background: "#0b0f16",
        foreground: "#e5edf7",
        cursor: "#f8fafc",
        selectionBackground: "#334155",
      },
    });
    const fitAddon = new FitAddon();
    terminal.loadAddon(fitAddon);
    terminal.open(host);
    fitAddon.fit();
    const size = terminalSize(terminal);
    lastSizeRef.current = size;
    setTerminalDimensions(size);
    const inputDisposable = terminal.onData((data) => queueTerminalInput(data));
    const replayQueryDisposables = installReplayQueryHandlers(
      terminal,
      () => replayWriteDepthRef.current > 0,
    );
    installTerminalClipboardShortcuts(terminal);
    const resizeObserver = new ResizeObserver(() => {
      fitTerminal();
      void takeCurrentControl(true);
    });
    resizeObserver.observe(host);
    return {
      terminal,
      fitAddon,
      inputDisposable,
      replayQueryDisposables,
      resizeObserver,
    };
  }
  function disposeTerminalRuntime(runtime: TerminalRuntime | undefined) {
    runtime?.inputDisposable.dispose();
    for (const disposable of runtime?.replayQueryDisposables ?? []) {
      disposable.dispose();
    }
    runtime?.resizeObserver.disconnect();
    runtime?.terminal.dispose();
  }
  // Temporary transport loss clears daemon info. Preserve the terminal model
  // until a different daemon instance is actually observed.
  const lastDaemonInstance = createMemo(
    (last: { machineId: string; instanceId: string } | undefined) => {
      const machineId = machine()?.id;
      const instanceId = daemonInstanceId();
      if (!machineId || !isPaired()) return undefined;
      if (instanceId) return { machineId, instanceId };
      return last?.machineId === machineId ? last : undefined;
    },
    undefined,
  );
  const attachmentKey = createMemo(
    () => [
      machine()?.id,
      machine()?.baseUrl,
      machine()?.clientId,
      machine()?.clientSecret,
      isPaired(),
      lastDaemonInstance()?.instanceId,
      tab()?.id,
    ],
    {
      equals: (previous, next) =>
        previous.length === next.length &&
        previous.every((value, i) => Object.is(value, next[i])),
    },
  );
  createEffect(attachmentKey, (key) => {
    if (!key[0] || !key[4]) {
      stopCurrentAttach();
      terminalSessionIdRef.current = undefined;
      attachIdRef.current = undefined;
      primaryAttachIdRef.current = undefined;
      takeControlPromiseRef.current = undefined;
      replayOutputUntilSeqRef.current = undefined;
      suppressReplayGeneratedInputRef.current = false;
      replayWriteDepthRef.current = 0;
      latestSeqRef.current = undefined;
      setSessionInfo(undefined);
      setStatus({ phase: "idle", message: "Terminal idle" });
      return;
    }
    if (!key[5]) {
      stopCurrentAttach();
      terminalSessionIdRef.current = undefined;
      attachIdRef.current = undefined;
      primaryAttachIdRef.current = undefined;
      takeControlPromiseRef.current = undefined;
      replayOutputUntilSeqRef.current = undefined;
      suppressReplayGeneratedInputRef.current = false;
      replayWriteDepthRef.current = 0;
      latestSeqRef.current = undefined;
      setSessionInfo(undefined);
      setStatus({ phase: "waiting", message: "Waiting for terminal" });
      return;
    }
    const currentTab = untrack(tab);
    void openTerminal({
      cwd: currentTab?.terminalLastKnownCwd,
      existingSessionId: currentTab?.terminalSessionId,
      launch: currentTab?.terminalLaunch,
      title: currentTab?.terminalLastKnownTitle ?? currentTab?.title,
    });
    return () => stopCurrentAttach();
  });
  async function openTerminal(options: OpenTerminalOptions) {
    const rpc = untrack(rpcSession);
    const currentTabState = untrack(tabState);
    const currentMachine = machineRef.current;
    if (!currentMachine) return;
    stopCurrentAttach();
    const generation = generationRef.current;
    terminalSessionIdRef.current = undefined;
    attachIdRef.current = undefined;
    primaryAttachIdRef.current = undefined;
    attachControlRef.current = undefined;
    takeControlPromiseRef.current = undefined;
    replayOutputUntilSeqRef.current = undefined;
    suppressReplayGeneratedInputRef.current =
      options.existingSessionId !== undefined;
    replayWriteDepthRef.current = 0;
    latestSeqRef.current = undefined;
    terminalSessionFinishedRef.current = false;
    persistedSessionSnapshotKeyRef.current = undefined;
    setSessionInfo(undefined);
    resetTerminalIfReady();
    try {
      if (options.existingSessionId) {
        terminalSessionIdRef.current = options.existingSessionId;
        setStatus({ phase: "waiting", message: "Waiting for terminal" });
        await attachTerminal(options.existingSessionId, generation);
        return;
      }
      setStatus({ phase: "waiting", message: "Waiting for terminal" });
      if (!options.launch?.command) {
        setStatus({
          phase: "error",
          message: "Terminal launch command is missing",
        });
        const runtime = await terminalRuntime();
        runtime?.terminal.writeln("Terminal launch command is missing.");
        runtime?.terminal.writeln("Open a terminal from the machine panel.");
        return;
      }
      const size = terminalStartupSize();
      const transportPromise = rpc.webTransport();
      const runtimePromise = terminalRuntime();
      const transport = await transportPromise;
      const session = await createTerminalSession(transport, {
        cols: size.cols,
        cwd: options.cwd,
        rows: size.rows,
        launch: options.launch,
        title: options.title,
      });
      if (generationRef.current !== generation) {
        void closeTerminalSession(transport, {
          terminalSessionId: session.terminalSessionId,
        }).catch(() => {});
        return;
      }
      terminalSessionIdRef.current = session.terminalSessionId;
      currentTabState.setTerminalSessionId(session.terminalSessionId);
      setSessionInfo(session);
      await runtimePromise;
      await attachTerminal(session.terminalSessionId, generation);
    } catch (err) {
      if (generationRef.current !== generation) return;
      if (options.existingSessionId && isTerminalSessionNotFoundError(err)) {
        clearTerminalSessionReference();
        setStatus({
          phase: "missing",
          message: "The daemon no longer has this terminal session.",
        });
        return;
      }
      setStatus({ phase: "error", message: errorMessage(err) });
    }
  }
  async function attachTerminal(terminalSessionId: string, generation: number) {
    const session = rpcSession();
    const controller = new AbortController();
    stopAttachRef.current = () => controller.abort();
    const current = () =>
      !controller.signal.aborted && generationRef.current === generation;
    // Restoring an existing session can run before the conditional xterm host
    // is inserted; wait for that runtime rather than abandoning the attach.
    let runtime = await terminalRuntime();
    while (current() && !runtime) {
      await new Promise((resolve) => setTimeout(resolve, 25));
      runtime = await terminalRuntime();
    }
    if (!runtime || !current()) return;
    let retries = 0;
    while (current() && !terminalSessionFinishedRef.current) {
      const attempt = new AbortController();
      try {
        const transport = await session.webTransport();
        if (!current()) return;
        const requestControl = activeRef.current;
        const size = requestControl
          ? terminalSize(runtime.terminal)
          : (sessionInfo() ?? terminalDimensions());
        for await (const event of callServerStream(
          transport,
          attachTerminalSessionProc,
          {
            terminalSessionId,
            afterSeq: latestSeqRef.current,
            viewportCols: size.cols,
            viewportRows: size.rows,
            screenSnapshots: true,
            requestControl: requestControl || undefined,
          },
          AbortSignal.any([controller.signal, attempt.signal]),
        )) {
          if (!current()) return;
          if (event.type === "attached") retries = 0;
          if (event.type === "historyGap" && event.reconnect) {
            latestSeqRef.current = undefined;
            resetTerminalIfReady();
            break;
          }
          await handleTerminalEvent(event, generation);
        }
      } catch (err) {
        if (!current()) return;
        if (isTerminalSessionNotFoundError(err)) {
          clearTerminalSessionReference();
          setStatus({
            phase: "missing",
            message: "The daemon no longer has this terminal session.",
          });
          return;
        }
        if (err instanceof RpcError) throw err;
      } finally {
        attempt.abort();
        if (current()) {
          stopTerminalInput();
          attachIdRef.current = undefined;
          primaryAttachIdRef.current = undefined;
          attachControlRef.current = undefined;
          takeControlPromiseRef.current = undefined;
          deferredResizeRef.current = undefined;
        }
      }
      if (!current() || terminalSessionFinishedRef.current) return;
      suppressReplayGeneratedInputRef.current = true;
      setStatus({ phase: "waiting", message: "Reconnecting to terminal…" });
      await new Promise((resolve) =>
        setTimeout(resolve, Math.min(250 * 2 ** Math.min(retries++, 4), 4000)),
      );
    }
  }
  async function terminalRuntime(): Promise<TerminalRuntime | undefined> {
    const runtime = runtimeRef.current;
    if (runtime) return runtime;
    const promise = xtermReadyPromiseRef.current;
    if (!promise) return undefined;
    return await promise;
  }
  function resetTerminalIfReady() {
    runtimeRef.current?.terminal.reset();
  }
  function terminalStartupSize() {
    const runtime = runtimeRef.current;
    if (!runtime) return lastSizeRef.current ?? untrack(terminalDimensions);
    fitTerminal();
    return terminalSize(runtime.terminal);
  }
  async function handleTerminalEvent(event: TerminalEvent, generation: number) {
    switch (event.type) {
      case "attached": {
        const control = terminalAttachControl(event, activeRef.current);
        attachControlRef.current = control;
        attachIdRef.current = event.attachId;
        primaryAttachIdRef.current = control.primaryAttachId;
        replayOutputUntilSeqRef.current =
          suppressReplayGeneratedInputRef.current
            ? event.session.latestOutputSeq
            : undefined;
        setSessionInfo(event.session);
        if (event.session.exit) {
          terminalSessionFinishedRef.current = true;
          setStatus({
            phase: "closed",
            message: terminalExitMessage(event.session.exit),
          });
          return;
        }
        if (control.refusal !== undefined) {
          setStatus({ phase: "error", message: control.refusal });
          return;
        }
        const ownsControl = isLivePrimaryAttach();
        setStatus({
          phase: ownsControl ? "attached" : "viewing",
          message: ownsControl
            ? "Terminal attached"
            : "Terminal attached in view mode",
        });
        if (activeRef.current) {
          if (!ownsControl) {
            void ensureCurrentControl();
          } else if (runtimeRef.current) {
            const size = terminalSize(runtimeRef.current.terminal);
            if (
              event.session.cols !== size.cols ||
              event.session.rows !== size.rows
            )
              void takeCurrentControl();
          }
        }
        return;
      }
      case "outputChunk":
        if (event.seq <= (latestSeqRef.current ?? 0)) return;
        await writeTerminalOutput(
          event.bytes,
          isSuppressibleReplayOutput(event.seq),
        );
        if (generationRef.current !== generation) return;
        latestSeqRef.current = event.seq;
        if (
          replayOutputUntilSeqRef.current !== undefined &&
          event.seq >= replayOutputUntilSeqRef.current
        ) {
          replayOutputUntilSeqRef.current = undefined;
        }
        return;
      case "screenSnapshot": {
        const terminal = runtimeRef.current?.terminal;
        if (!terminal) return;
        if (!isTerminalGridBounded(event.cols, event.rows)) {
          throw new RpcError(
            "invalidSize",
            "Invalid terminal screen snapshot size",
          );
        }
        terminal.reset();
        terminal.resize(event.cols, event.rows);
        await writeTerminalOutput(event.bytes, true);
        if (generationRef.current !== generation) return;
        latestSeqRef.current = event.baseSeq;
        return;
      }
      case "historyGap":
        resetTerminalIfReady();
        if (attachControlRef.current?.refusal === undefined) {
          setStatus({
            phase: "viewing",
            message: `Output history resumes at ${event.nextSeq}`,
          });
        }
        return;
      case "controlChanged":
        if (event.primaryAttachId !== attachIdRef.current) stopTerminalInput();
        primaryAttachIdRef.current = event.primaryAttachId;
        controlVersionRef.current++;
        if (attachControlRef.current?.refusal !== undefined) return;
        setStatus({
          phase:
            event.primaryAttachId === attachIdRef.current
              ? "attached"
              : "viewing",
          message:
            event.primaryAttachId === attachIdRef.current
              ? "Terminal attached"
              : "Another view has control",
        });
        if (isLivePrimaryAttach()) reconcileDeferredResize();
        return;
      case "pseudoTerminalResized":
        if (isTerminalGridBounded(event.cols, event.rows)) {
          runtimeRef.current?.terminal.resize(event.cols, event.rows);
        }
        setTerminalDimensions({ cols: event.cols, rows: event.rows });
        setSessionInfo((current) =>
          current
            ? { ...current, cols: event.cols, rows: event.rows }
            : current,
        );
        return;
      case "sessionExited":
        stopTerminalInput();
        terminalSessionFinishedRef.current = true;
        setSessionInfo((current) =>
          current ? { ...current, exit: event.exit } : current,
        );
        return;
      case "sessionClosed":
        stopTerminalInput();
        terminalSessionFinishedRef.current = true;
        primaryAttachIdRef.current = undefined;
        takeControlPromiseRef.current = undefined;
        replayOutputUntilSeqRef.current = undefined;
        suppressReplayGeneratedInputRef.current = false;
        replayWriteDepthRef.current = 0;
        clearTerminalSessionReference();
        setStatus({
          phase: "closed",
          message: terminalSessionClosedMessage(event.reason),
        });
        return;
      case "workingDirectoryChanged":
        setSessionInfo((current) =>
          current ? { ...current, lastKnownCwd: event.cwd } : current,
        );
        return;
      case "titleChanged":
        setSessionInfo((current) =>
          current ? { ...current, lastKnownTitle: event.title } : current,
        );
        return;
    }
  }
  function stopTerminalInput() {
    inputStreamRef.current?.close();
    inputStreamRef.current = undefined;
  }
  function queueTerminalInput(data: string) {
    const terminalSessionId = terminalSessionIdRef.current;
    const attachId = attachIdRef.current;
    if (
      !terminalSessionId ||
      !attachId ||
      terminalSessionFinishedRef.current ||
      !allowsNewTerminalInput(attachControlRef.current, activeRef.current)
    )
      return;
    const generation = generationRef.current;
    let stream = inputStreamRef.current;
    if (!stream) {
      stream = new TerminalInputStream();
      inputStreamRef.current = stream;
      void sendTerminalInput(stream, terminalSessionId, attachId, generation);
    }
    if (!stream.enqueue(new TextEncoder().encode(data))) {
      setStatus({
        phase: "error",
        message: "Terminal input queue full; input not sent.",
      });
    }
  }
  async function sendTerminalInput(
    stream: TerminalInputStream,
    terminalSessionId: string,
    attachId: string,
    generation: number,
  ) {
    const current = () =>
      generation === generationRef.current &&
      attachId === attachIdRef.current &&
      inputStreamRef.current === stream;
    const canStart = () =>
      current() &&
      isLivePrimaryAttach() &&
      allowsNewTerminalInput(attachControlRef.current, activeRef.current);
    async function* requests(): AsyncGenerator<WriteTerminalInputReq> {
      if (!canStart()) return;
      yield { type: "writeTerminalInputStart", terminalSessionId, attachId };
      let sentInput = false;
      for await (const bytes of stream.read()) {
        if (
          !current() ||
          !isLivePrimaryAttach() ||
          (!sentInput && !canStart())
        )
          return;
        sentInput = true;
        yield { type: "writeTerminalInputChunk", bytes };
      }
    }
    try {
      if (!(await ensureCurrentControl()) || !current()) return;
      const transport = await rpcSession().webTransport();
      if (!canStart()) return;
      await writeTerminalInput(transport, requests());
    } catch (err) {
      if (
        current() &&
        allowsNewTerminalInput(attachControlRef.current, activeRef.current) &&
        !isStalePrimaryAttachError(err)
      ) {
        setStatus({ phase: "error", message: errorMessage(err) });
      }
    } finally {
      stream.close();
      if (inputStreamRef.current === stream) inputStreamRef.current = undefined;
    }
  }
  function isSuppressibleReplayOutput(seq: number) {
    return (
      replayOutputUntilSeqRef.current !== undefined &&
      seq <= replayOutputUntilSeqRef.current
    );
  }
  async function writeTerminalOutput(
    bytes: Uint8Array,
    suppressGeneratedInput: boolean,
  ) {
    const terminal = runtimeRef.current?.terminal;
    if (!terminal) return;
    const generation = generationRef.current;
    if (suppressGeneratedInput) replayWriteDepthRef.current += 1;
    try {
      await new Promise<void>((resolve) => terminal.write(bytes, resolve));
    } finally {
      if (suppressGeneratedInput && generationRef.current === generation) {
        replayWriteDepthRef.current = Math.max(
          0,
          replayWriteDepthRef.current - 1,
        );
      }
    }
  }
  function isLivePrimaryAttach() {
    const attachId = attachIdRef.current;
    return attachId !== undefined && primaryAttachIdRef.current === attachId;
  }
  async function ensureCurrentControl() {
    if (!allowsNewTerminalInput(attachControlRef.current, activeRef.current)) {
      return false;
    }
    if (!isLivePrimaryAttach()) await takeCurrentControl();
    return (
      isLivePrimaryAttach() &&
      allowsNewTerminalInput(attachControlRef.current, activeRef.current)
    );
  }
  function takeCurrentControl(resize = false) {
    const attachId = attachIdRef.current;
    const control = attachControlRef.current;
    const generation = generationRef.current;
    if (
      !attachId ||
      terminalSessionFinishedRef.current ||
      !allowsTerminalControlRequest(control, activeRef.current)
    )
      return;
    const pending = takeControlPromiseRef.current;
    if (resize && pending) {
      deferredResizeRef.current ??= { generation, attachId, control };
      reconcileDeferredResize();
      return pending;
    }
    if (resize && isLivePrimaryAttach()) deferredResizeRef.current = undefined;
    return requestTerminalAttachControl(
      attachControlRef.current,
      activeRef.current,
      isLivePrimaryAttach(),
      takeControlPromiseRef,
      requestTerminalControl,
    );
  }
  function reconcileDeferredResize() {
    const intent = deferredResizeRef.current;
    if (!intent) return;
    if (
      generationRef.current !== intent.generation ||
      attachIdRef.current !== intent.attachId ||
      attachControlRef.current !== intent.control ||
      terminalSessionFinishedRef.current
    ) {
      deferredResizeRef.current = undefined;
      return;
    }
    if (intent.waitingOn) return;
    const pending = takeControlPromiseRef.current;
    if (pending) {
      intent.waitingOn = pending;
      void pending.then(() => {
        if (deferredResizeRef.current !== intent) return;
        intent.waitingOn = undefined;
        reconcileDeferredResize();
      });
      return;
    }
    if (
      !isLivePrimaryAttach() ||
      !allowsTerminalControlRequest(intent.control, activeRef.current)
    )
      return;
    const controlVersion = controlVersionRef.current;
    intent.waitingOn = requestTerminalControl(intent);
    void intent.waitingOn.then(() => {
      if (deferredResizeRef.current !== intent) return;
      intent.waitingOn = undefined;
      // A new ownership event can arrive while the transport wait unwinds.
      if (controlVersionRef.current !== controlVersion)
        reconcileDeferredResize();
    });
  }
  async function requestTerminalControl(resizeIntent?: DeferredTerminalResize) {
    const generation = generationRef.current;
    const runtime = runtimeRef.current;
    const terminalSessionId = terminalSessionIdRef.current;
    const attachId = attachIdRef.current;
    const control = attachControlRef.current;
    if (!machineRef.current || !runtime || !terminalSessionId || !attachId)
      return;
    const current = () =>
      generationRef.current === generation &&
      attachIdRef.current === attachId &&
      attachControlRef.current === control &&
      !terminalSessionFinishedRef.current;
    const canRequest = () =>
      current() &&
      allowsTerminalControlRequest(control, activeRef.current) &&
      (!resizeIntent ||
        (deferredResizeRef.current === resizeIntent && isLivePrimaryAttach()));
    if (!canRequest()) return;
    let size = terminalSize(runtime.terminal);
    try {
      const transport = await rpcSession().webTransport();
      if (!canRequest()) return;
      const previous = lastSizeRef.current;
      if (resizeIntent) {
        // The daemon may have restored xterm to the earlier requested size.
        if (!fitTerminal()) return;
        size = terminalSize(runtime.terminal);
        deferredResizeRef.current = undefined;
        if (size.cols === previous?.cols && size.rows === previous?.rows)
          return;
      }
      lastSizeRef.current = size;
      setTerminalDimensions(size);
      const controlVersion = controlVersionRef.current;
      const response = await takeTerminalControl(transport, {
        terminalSessionId,
        attachId,
        viewportCols: size.cols,
        viewportRows: size.rows,
      });
      if (!current()) return;
      // A newer stream event wins over an asynchronous unary response.
      if (
        controlVersionRef.current !== controlVersion &&
        primaryAttachIdRef.current !== response.primaryAttachId
      )
        return;
      primaryAttachIdRef.current = response.primaryAttachId;
      setStatus({
        phase: "attached",
        message:
          previous?.cols !== size.cols || previous?.rows !== size.rows
            ? `${size.cols}x${size.rows}`
            : "Terminal attached",
      });
      setSessionInfo((current) =>
        current
          ? {
              ...current,
              cols: size.cols,
              rows: size.rows,
              primaryAttachId: response.primaryAttachId,
            }
          : current,
      );
    } catch (err) {
      if (!current()) return;
      setStatus({ phase: "error", message: errorMessage(err) });
    }
  }
  function fitTerminal() {
    const runtime = runtimeRef.current;
    if (!runtime) return false;
    try {
      runtime.fitAddon.fit();
      setTerminalDimensions(terminalSize(runtime.terminal));
      return true;
    } catch {
      // xterm fit can fail while the pane is hidden or not yet measurable.
      return false;
    }
  }
  function stopCurrentAttach() {
    generationRef.current++;
    deferredResizeRef.current = undefined;
    attachControlRef.current = undefined;
    stopTerminalInput();
    stopAttachRef.current?.();
    stopAttachRef.current = undefined;
  }
  function clearTerminalSessionReference() {
    deferredResizeRef.current = undefined;
    terminalSessionIdRef.current = undefined;
    attachIdRef.current = undefined;
    primaryAttachIdRef.current = undefined;
    attachControlRef.current = undefined;
    takeControlPromiseRef.current = undefined;
    replayOutputUntilSeqRef.current = undefined;
    suppressReplayGeneratedInputRef.current = false;
    replayWriteDepthRef.current = 0;
    latestSeqRef.current = undefined;
    tabState().setTerminalSessionId(undefined);
  }
  async function openNewTerminalSession() {
    const exitedSessionId = sessionInfo()?.exit
      ? sessionInfo()!.terminalSessionId
      : undefined;
    const launch = sessionInfo()?.launch ?? tab()?.terminalLaunch;
    const cwd = sessionInfo()?.lastKnownCwd ?? tab()?.terminalLastKnownCwd;
    const title =
      sessionInfo()?.lastKnownTitle ??
      tab()?.terminalLastKnownTitle ??
      tab()?.title;
    if (exitedSessionId) {
      try {
        await closeTerminalSession(await rpcSession().webTransport(), {
          terminalSessionId: exitedSessionId,
        });
      } catch (err) {
        if (!isTerminalSessionNotFoundError(err)) {
          setStatus({ phase: "error", message: errorMessage(err) });
          return;
        }
      }
    }
    clearTerminalSessionReference();
    void openTerminal({
      cwd,
      launch,
      title,
    });
  }
  function TerminalHost() {
    onCleanup(() => setHostElement(undefined));
    return <div ref={setHostElement} {...styles.terminalHost()} />;
  }
  const terminalNotice = createMemo(() =>
    terminalNoticeFromState(status(), sessionInfo()),
  );
  const canOpenNewTerminal = createMemo(() =>
    Boolean(sessionInfo()?.launch.command ?? tab()?.terminalLaunch?.command),
  );
  return (
    <Show
      when={machine()}
      fallback={
        <section {...styles.emptyWorkspace()}>
          <HardDrive size={28} />
          <h2>No machine selected</h2>
        </section>
      }
    >
      <Show
        when={isPaired()}
        fallback={
          <section {...styles.emptyWorkspace()}>
            <KeyRound size={28} />
            <h2>Pairing required</h2>
            <Button
              onClick={() => machineModal().openPairMachineModal(machine()!.id)}
            >
              <KeyRound size={16} />
              Pair
            </Button>
          </section>
        }
      >
        <section {...styles.terminalTool()}>
          <div {...styles.terminalSurface()}>
            <TerminalHost />
            {status().phase === "waiting" ? (
              <div {...styles.terminalWaitingNotice()}>
                <div>
                  <Loader2 size={16} className={styles.loader2().class} />
                  <span>{status().message}</span>
                </div>
              </div>
            ) : null}
            {terminalNotice()?.presentation === "overlay" ? (
              <div {...styles.terminalOverlayNotice()}>
                <div>
                  <h2>{terminalNotice()!.title}</h2>
                  <p>{terminalNotice()!.message}</p>
                  {canOpenNewTerminal() ? (
                    <Button
                      className={styles.terminalNoticeButton().class}
                      onClick={() => void openNewTerminalSession()}
                    >
                      {terminalNotice()!.actionLabel}
                    </Button>
                  ) : null}
                </div>
              </div>
            ) : null}
          </div>
          {terminalNotice()?.presentation === "banner" ? (
            <div {...styles.terminalStatusNotice()}>
              <strong>{terminalNotice()!.title}</strong>
              <span>{terminalNotice()!.message}</span>
              {canOpenNewTerminal() ? (
                <Button
                  className={styles.terminalNoticeButton().class}
                  onClick={() => void openNewTerminalSession()}
                >
                  {terminalNotice()!.actionLabel}
                </Button>
              ) : null}
            </div>
          ) : null}
          <div {...styles.terminalFooter()}>
            <div {...styles.terminalFooterDetails()}>
              <strong>{terminalLaunchName(sessionInfo())}</strong>
              {sessionInfo()?.lastKnownCwd ? (
                <span>{sessionInfo()!.lastKnownCwd}</span>
              ) : null}
            </div>
            <span {...styles.terminalFooterSize()}>
              {sessionInfo()?.cols ?? terminalDimensions().cols}
              {" x "}
              {sessionInfo()?.rows ?? terminalDimensions().rows}
            </span>
          </div>
        </section>
      </Show>
    </Show>
  );
}
function terminalSize(terminal: XTerm): {
  cols: number;
  rows: number;
} {
  return {
    cols: Math.max(1, terminal.cols || 80),
    rows: Math.max(1, terminal.rows || 24),
  };
}
function terminalLaunchName(sessionInfo: TerminalSessionInfo | undefined) {
  if (!sessionInfo?.launch.command) return "Terminal";
  return commandName(sessionInfo.launch.command);
}
function terminalNoticeFromState(
  status: TerminalStatus,
  sessionInfo: TerminalSessionInfo | undefined,
): TerminalNotice | undefined {
  if (sessionInfo?.exit) {
    return {
      actionLabel: "Restart",
      presentation: "banner",
      title: "Exited",
      message: terminalExitMessage(sessionInfo.exit),
    };
  }
  if (status.phase === "missing") {
    return {
      actionLabel: "Start new terminal session",
      presentation: "overlay",
      title: "Terminal session closed",
      message: status.message,
    };
  }
  if (status.phase === "closed") {
    return {
      actionLabel: "Start new terminal session",
      presentation: "overlay",
      title: "Terminal session closed",
      message: status.message,
    };
  }
  if (status.phase === "error") {
    return {
      actionLabel: "Start new terminal session",
      presentation: "overlay",
      title: "Terminal error",
      message: status.message,
    };
  }
  return undefined;
}
function terminalExitMessage(exit: TerminalExit): string {
  if (exit.code !== undefined) return `Process exited with code ${exit.code}.`;
  if (exit.signal) return `Process exited after signal ${exit.signal}.`;
  return "Process exited.";
}
function terminalSessionClosedMessage(
  reason: TerminalSessionCloseReason,
): string {
  if (reason.type === "closedByClient") {
    return "A client closed this terminal session.";
  }
  if (reason.type === "failed") return reason.message;
  return humanizeCode(reason.type, "The terminal session was closed.");
}
function terminalSessionSnapshotKey(
  snapshot: WorkbenchTerminalSessionSnapshot,
): string {
  return JSON.stringify([
    snapshot.launch?.command,
    snapshot.launch?.args ?? [],
    snapshot.lastKnownCwd,
    snapshot.lastKnownTitle,
  ]);
}
function commandName(command: string): string {
  const normalized = command.replaceAll("\\", "/");
  const segments = normalized.split("/").filter(Boolean);
  return segments[segments.length - 1] ?? command;
}
function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
function isTerminalGridBounded(cols: number, rows: number): boolean {
  return cols > 0 && rows > 0 && cols * rows <= 64 * 1024;
}
function isStalePrimaryAttachError(err: unknown): boolean {
  return err instanceof RpcError && err.code === "notPrimaryAttach";
}
function installTerminalClipboardShortcuts(terminal: XTerm) {
  terminal.attachCustomKeyEventHandler((event) => {
    if (event.type !== "keydown") return true;
    const modifierPressed = event.ctrlKey || event.metaKey;
    if (!modifierPressed || event.altKey) return true;
    const key = event.key.toLowerCase();
    if (key === "c" && terminal.hasSelection()) {
      event.preventDefault();
      void copyTerminalSelection(terminal).catch(() => {});
      return false;
    }
    if (key === "v") {
      event.preventDefault();
      void pasteClipboardToTerminal(terminal).catch(() => {});
      return false;
    }
    return true;
  });
}
async function copyTerminalSelection(terminal: XTerm) {
  const selection = terminal.getSelection();
  if (!selection) return;
  await navigator.clipboard.writeText(selection);
}
async function pasteClipboardToTerminal(terminal: XTerm) {
  const text = await navigator.clipboard.readText();
  if (!text) return;
  terminal.paste(text);
}
function installReplayQueryHandlers(
  terminal: XTerm,
  shouldSuppress: () => boolean,
): Array<{
  dispose: () => void;
}> {
  const consumeReplayQuery = () => shouldSuppress();
  return [
    terminal.parser.registerCsiHandler({ final: "n" }, consumeReplayQuery),
    terminal.parser.registerCsiHandler(
      { prefix: "?", final: "n" },
      consumeReplayQuery,
    ),
    terminal.parser.registerCsiHandler({ final: "c" }, consumeReplayQuery),
    terminal.parser.registerCsiHandler(
      { prefix: ">", final: "c" },
      consumeReplayQuery,
    ),
    terminal.parser.registerCsiHandler(
      { prefix: "=", final: "c" },
      consumeReplayQuery,
    ),
  ];
}
function isTerminalSessionNotFoundError(err: unknown): boolean {
  return err instanceof RpcError && err.code === "notFound";
}
function humanizeCode(code: string, fallback: string): string {
  const words = code
    .replaceAll(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replaceAll(/[_-]+/g, " ")
    .trim()
    .toLowerCase();
  if (!words) return fallback;
  return `${capitalize(words)}.`;
}
function capitalize(text: string): string {
  return text.length === 0 ? text : text[0]!.toUpperCase() + text.slice(1);
}

namespace styles {
  export const terminalTool = style({
    gridTemplateRows: "minmax(0,1fr) auto auto",
    display: "grid",
    height: "100%",
    minHeight: "0",
    minWidth: "0",
    width: "100%",
    overflow: "hidden",
    borderBottomLeftRadius: "12px",
    borderBottomRightRadius: "12px",
    backgroundColor: "rgba(8, 12, 20, 0.72)",
    color: "rgb(216 222 233 / 1)",
    WebkitBackdropFilter: "blur(40px)",
    backdropFilter: "blur(40px)",
    "@media (max-width: 680px)": {
      borderRadius: "0",
    },
  });
  export const terminalSurface = style({
    position: "relative",
    height: "100%",
    minHeight: "0",
    minWidth: "0",
    width: "100%",
    overflow: "hidden",
  });
  export const emptyWorkspace = style({
    display: "grid",
    selectors: {
      "& h2": {
        margin: "0",
        fontSize: "18px",
        color: "rgb(238 243 250 / 1)",
        letterSpacing: "0",
      },
    },
    height: "100%",
    minHeight: "0",
    width: "100%",
    alignContent: "center",
    justifyItems: "center",
    gap: "10px",
    backgroundColor: "rgba(8, 12, 20, 0.72)",
    color: "rgb(154 166 184 / 1)",
    WebkitBackdropFilter: "blur(40px)",
    backdropFilter: "blur(40px)",
  });
  export const terminalFooter = style({
    boxSizing: "border-box",
    height: "2rem",
    minHeight: "2rem",
    display: "flex",
    alignItems: "center",
    justifyContent: "flex-end",
    gap: "12px",
    borderTopWidth: "1px",
    borderTopColor: "rgb(255 255 255 / 0.08)",
    borderBottomLeftRadius: "12px",
    borderBottomRightRadius: "12px",
    backgroundColor: "rgb(0 0 0 / 0.14)",
    paddingLeft: "8px",
    paddingRight: "8px",
    color: "rgb(154 166 184 / 1)",
    lineHeight: 1.6,
    boxShadow:
      "0 0 rgb(0 0 0 / 0), 0 0 rgb(0 0 0 / 0), inset 0 1px 0 rgba(255, 255, 255, 0.05)",
    WebkitBackdropFilter: "blur(24px)",
    backdropFilter: "blur(24px)",
    "@container workbench-tab-page (min-width:520px)": {
      justifyContent: "space-between",
    },
    "@media (max-width: 680px)": {
      borderRadius: "0",
    },
  });
  export const terminalFooterDetails = style({
    display: "none",
    selectors: {
      "& span": {
        minWidth: "0",
        overflow: "hidden",
        textOverflow: "ellipsis",
        whiteSpace: "nowrap",
      },
      "& strong": {
        minWidth: "0",
        overflow: "hidden",
        textOverflow: "ellipsis",
        whiteSpace: "nowrap",
        color: "rgb(220 230 244 / 1)",
        fontWeight: 650,
      },
    },
    minWidth: "0",
    alignItems: "center",
    gap: "8px",
    "@container workbench-tab-page (min-width:520px)": {
      display: "flex",
    },
  });
  export const terminalFooterSize = style({
    flex: "0 0 auto",
  });
  export const terminalHost = style({
    selectors: {
      "& .xterm-viewport": {
        scrollbarGutter: "stable",
        backgroundColor: "rgb(11 15 22 / 1)",
      },
      "& .xterm": {
        boxSizing: "border-box",
        height: "100%",
        backgroundColor: "rgb(11 15 22 / 1)",
        paddingRight: "12px",
      },
    },
    boxSizing: "border-box",
    height: "100%",
    minHeight: "0",
    minWidth: "0",
    width: "100%",
    overflow: "hidden",
    backgroundColor: "rgb(11 15 22 / 1)",
    paddingLeft: "8px",
    paddingRight: "8px",
  });
  export const terminalOverlayNotice = style({
    position: "absolute",
    inset: "0",
    zIndex: 2,
    selectors: {
      "& div": {
        display: "grid",
        maxWidth: "360px",
        justifyItems: "center",
        gap: "10px",
      },
      "& h2": {
        margin: "0",
        fontSize: "18px",
        color: "rgb(242 244 247 / 1)",
        fontWeight: 750,
      },
      "& p": {
        margin: "0",
        fontSize: "13px",
        lineHeight: 1.45,
      },
    },
    display: "grid",
    placeItems: "center",
    backgroundColor: "rgba(8, 12, 20, 0.78)",
    paddingLeft: "18px",
    paddingRight: "18px",
    textAlign: "center",
    color: "rgb(208 213 221 / 1)",
    WebkitBackdropFilter: "blur(40px)",
    backdropFilter: "blur(40px)",
  });
  export const terminalWaitingNotice = style({
    position: "absolute",
    inset: "0",
    zIndex: 1,
    display: "grid",
    selectors: {
      "& div": {
        display: "flex",
        alignItems: "center",
        gap: "8px",
      },
      "& span": {
        fontSize: "13px",
        lineHeight: 1.6,
      },
    },
    placeItems: "center",
    backgroundColor: "rgba(8, 12, 20, 0.68)",
    paddingLeft: "18px",
    paddingRight: "18px",
    color: "rgb(208 213 221 / 1)",
    WebkitBackdropFilter: "blur(24px)",
    backdropFilter: "blur(24px)",
  });
  export const terminalStatusNotice = style({
    selectors: {
      "& span": {
        minWidth: "0",
        flex: "1 1 auto",
        overflow: "hidden",
        textOverflow: "ellipsis",
        whiteSpace: "nowrap",
      },
      "& strong": {
        flex: "0 0 auto",
        color: "rgb(208 213 221 / 1)",
        fontWeight: 650,
      },
    },
    minHeight: "2rem",
    display: "flex",
    alignItems: "center",
    gap: "8px",
    borderTopWidth: "1px",
    borderTopColor: "rgb(255 255 255 / 0.08)",
    backgroundColor: "rgb(0 0 0 / 0.18)",
    paddingLeft: "8px",
    paddingRight: "8px",
    color: "rgb(152 162 179 / 1)",
    lineHeight: 1.6,
    WebkitBackdropFilter: "blur(24px)",
    backdropFilter: "blur(24px)",
  });
  export const terminalNoticeButton = style({
    height: "1.5rem !important",
    minHeight: "1.5rem !important",
    borderColor: "rgb(56 70 90 / 1 ) !important",
    borderRadius: "4px !important",
    backgroundColor: "rgb(17 24 39 / 1 ) !important",
    selectors: {
      "&:hover": {
        backgroundColor: "rgb(23 32 51 / 1 ) !important",
      },
    },
    paddingLeft: "6px !important",
    paddingRight: "6px !important",
    color: "rgb(208 213 221 / 1 ) !important",
    lineHeight: "1 !important",
  });
  export const loader2 = style({
    animation: "spin 1s linear infinite",
  });
}
