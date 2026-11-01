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
  attachTerminalSession,
  closeTerminalSession,
  createTerminalSession,
  takeTerminalControl,
  writeTerminalInput,
} from "../../../../protocol/generated/client.ts";
import { RpcError } from "../../../../protocol/client.ts";
import type {
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
  const latestSeqRef = { current: undefined as number | undefined };
  const stopAttachRef = { current: undefined as (() => void) | undefined };
  const generationRef = { current: 0 };
  const inputQueueRef = { current: Promise.resolve() as Promise<void> };
  const takeControlPromiseRef = {
    current: undefined as Promise<void> | undefined,
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
    void takeCurrentControl();
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
      void takeCurrentControl();
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
  const attachmentKey = createMemo(
    () => [
      machine()?.id,
      machine()?.baseUrl,
      machine()?.clientId,
      machine()?.clientSecret,
      isPaired(),
      daemonInstanceId(),
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
    const runtime = await terminalRuntime();
    if (!runtime || generationRef.current !== generation) return;
    const size = activeRef.current
      ? terminalSize(runtime.terminal)
      : (sessionInfo() ?? terminalDimensions());
    let cancelled = false;
    const attachment: { iterator?: AsyncGenerator<TerminalEvent> } = {};
    stopAttachRef.current = () => {
      cancelled = true;
      void attachment.iterator?.return(undefined);
    };
    const transport = await session.webTransport();
    if (cancelled || generationRef.current !== generation) return;
    const iterator = (attachment.iterator = attachTerminalSession(transport, {
      terminalSessionId,
      afterSeq: latestSeqRef.current,
      viewportCols: size.cols,
      viewportRows: size.rows,
    }));
    for await (const event of iterator) {
      if (cancelled || generationRef.current !== generation) return;
      handleTerminalEvent(event);
    }
    if (
      !cancelled &&
      generationRef.current === generation &&
      !terminalSessionFinishedRef.current
    ) {
      setStatus({
        phase: "closed",
        message: "Terminal session ended.",
      });
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
  function handleTerminalEvent(event: TerminalEvent) {
    switch (event.type) {
      case "attached":
        attachIdRef.current = event.attachId;
        primaryAttachIdRef.current = event.primaryAttachId;
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
        setStatus({
          phase:
            event.primaryAttachId === event.attachId ? "attached" : "viewing",
          message:
            event.primaryAttachId === event.attachId
              ? "Terminal attached"
              : "Terminal attached in view mode",
        });
        if (activeRef.current) void takeCurrentControl();
        return;
      case "outputChunk":
        latestSeqRef.current = event.seq;
        writeTerminalOutput(event.bytes, isSuppressibleReplayOutput(event.seq));
        if (
          replayOutputUntilSeqRef.current !== undefined &&
          event.seq >= replayOutputUntilSeqRef.current
        ) {
          replayOutputUntilSeqRef.current = undefined;
        }
        return;
      case "historyGap":
        setStatus({
          phase: "viewing",
          message: `Output history resumes at ${event.nextSeq}`,
        });
        return;
      case "controlChanged":
        primaryAttachIdRef.current = event.primaryAttachId;
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
        return;
      case "pseudoTerminalResized":
        setTerminalDimensions({ cols: event.cols, rows: event.rows });
        setSessionInfo((current) =>
          current
            ? { ...current, cols: event.cols, rows: event.rows }
            : current,
        );
        return;
      case "sessionExited":
        terminalSessionFinishedRef.current = true;
        setSessionInfo((current) =>
          current ? { ...current, exit: event.exit } : current,
        );
        return;
      case "sessionClosed":
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
  function queueTerminalInput(data: string) {
    const encoder = new TextEncoder();
    const bytes = encoder.encode(data);
    inputQueueRef.current = inputQueueRef.current
      .catch(() => {})
      .then(async () => {
        const currentMachine = machineRef.current;
        if (
          terminalSessionFinishedRef.current ||
          !currentMachine ||
          !terminalSessionIdRef.current
        )
          return;
        if (!(await ensureCurrentControl())) return;
        const terminalSessionId = terminalSessionIdRef.current;
        const attachId = attachIdRef.current;
        if (
          !terminalSessionId ||
          !attachId ||
          primaryAttachIdRef.current !== attachId
        )
          return;
        await writeTerminalInput(await rpcSession().webTransport(), [
          { type: "writeTerminalInputStart", terminalSessionId, attachId },
          { type: "writeTerminalInputChunk", bytes },
        ]);
      })
      .catch((err) => {
        if (isStalePrimaryAttachError(err)) return;
        setStatus({ phase: "error", message: errorMessage(err) });
      });
  }
  function isSuppressibleReplayOutput(seq: number) {
    return (
      replayOutputUntilSeqRef.current !== undefined &&
      seq <= replayOutputUntilSeqRef.current
    );
  }
  function writeTerminalOutput(
    bytes: Uint8Array,
    suppressGeneratedInput: boolean,
  ) {
    const terminal = runtimeRef.current?.terminal;
    if (!terminal) return;
    if (!suppressGeneratedInput) {
      terminal.write(bytes);
      return;
    }
    replayWriteDepthRef.current += 1;
    try {
      terminal.write(bytes, () => {
        replayWriteDepthRef.current = Math.max(
          0,
          replayWriteDepthRef.current - 1,
        );
      });
    } catch (err) {
      replayWriteDepthRef.current = Math.max(
        0,
        replayWriteDepthRef.current - 1,
      );
      throw err;
    }
  }
  function isLivePrimaryAttach() {
    const attachId = attachIdRef.current;
    return attachId !== undefined && primaryAttachIdRef.current === attachId;
  }
  async function ensureCurrentControl() {
    if (isLivePrimaryAttach()) return true;
    if (terminalSessionFinishedRef.current || !activeRef.current) return false;
    takeControlPromiseRef.current ??= takeCurrentControl().finally(() => {
      takeControlPromiseRef.current = undefined;
    });
    await takeControlPromiseRef.current;
    return isLivePrimaryAttach();
  }
  async function takeCurrentControl() {
    const generation = generationRef.current;
    const currentMachine = machineRef.current;
    const runtime = runtimeRef.current;
    const terminalSessionId = terminalSessionIdRef.current;
    const attachId = attachIdRef.current;
    if (
      terminalSessionFinishedRef.current ||
      !activeRef.current ||
      !currentMachine ||
      !runtime ||
      !terminalSessionId ||
      !attachId
    )
      return;
    const size = terminalSize(runtime.terminal);
    const previous = lastSizeRef.current;
    lastSizeRef.current = size;
    setTerminalDimensions(size);
    try {
      const response = await takeTerminalControl(
        await rpcSession().webTransport(),
        {
          terminalSessionId,
          attachId,
          viewportCols: size.cols,
          viewportRows: size.rows,
        },
      );
      if (generationRef.current !== generation) return;
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
      if (generationRef.current !== generation) return;
      setStatus({ phase: "error", message: errorMessage(err) });
    }
  }
  function fitTerminal() {
    const runtime = runtimeRef.current;
    if (!runtime) return;
    try {
      runtime.fitAddon.fit();
      setTerminalDimensions(terminalSize(runtime.terminal));
    } catch {
      // xterm fit can fail while the pane is hidden or not yet measurable.
    }
  }
  function stopCurrentAttach() {
    generationRef.current++;
    stopAttachRef.current?.();
    stopAttachRef.current = undefined;
  }
  function clearTerminalSessionReference() {
    terminalSessionIdRef.current = undefined;
    attachIdRef.current = undefined;
    primaryAttachIdRef.current = undefined;
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
