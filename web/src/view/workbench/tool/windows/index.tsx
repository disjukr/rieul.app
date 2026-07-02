import { useEffect, useRef, useState } from "react";
import { useAtomValue } from "jotai";
import { useBunja } from "bunja/react";
import { AppWindow, HardDrive, KeyRound, Loader2 } from "lucide-react";
import {
  subscribeWindowDetail,
  subscribeWindows,
} from "../../../../protocol/generated/client.ts";
import {
  ProcId,
  type WindowDetail,
  type WindowDetailEvent,
  type WindowInfo,
  type WindowsTableEvent,
} from "../../../../protocol/generated/rpc.ts";
import { machineModalBunja } from "../../../../state/machine-modal.ts";
import { machineStoreBunja } from "../../../../state/machine-store.ts";
import { rpcSessionBunja } from "../../../../state/rpc-session.ts";
import {
  workbenchPaneBunja,
  workbenchTabBunja,
} from "../../../../state/workbench.ts";
import { Button } from "../../../ui/button.tsx";
import { Breadcrumb } from "../../../ui/breadcrumb.tsx";
import {
  PropertyList,
  PropertyListItem,
  PropertyValue,
} from "../../../ui/property-list.tsx";

interface WindowsState {
  message?: string;
  phase: "idle" | "loading" | "ready" | "error" | "unsupported";
  rows: WindowInfo[];
}

interface WindowsRpcSession {
  webTransport: () => Promise<WebTransport>;
}

interface WindowDetailState {
  detail?: WindowDetail;
  message?: string;
  phase: "idle" | "loading" | "ready" | "closed" | "error" | "unsupported";
}

const windowsToolClassName = [
  "flex h-full min-h-0 w-full flex-col",
  "overflow-hidden bg-white text-[#20242d]",
].join(" ");
const windowsContentClassName =
  "flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden";
const emptyWorkspaceClassName = [
  "grid content-center justify-items-center w-full h-full gap-[10px]",
  "min-h-0 bg-white text-[#667085]",
  "[&_h2]:m-0 [&_h2]:text-[#303642] [&_h2]:text-[18px] [&_h2]:tracking-[0]",
  "[&_p]:m-0 [&_p]:max-w-[360px] [&_p]:text-center [&_p]:leading-[1.45]",
].join(" ");
const windowTableClassName = [
  "grid min-h-0 min-w-0 flex-1 overflow-auto leading-[1.6]",
  "[grid-template-columns:minmax(240px,1fr)_minmax(80px,112px)_minmax(96px,120px)]",
  "auto-rows-[2rem] bg-white",
].join(" ");
const windowHeadClassName = [
  "sticky top-0 z-[1] flex h-[2rem] box-border items-center",
  "border-b border-b-[#d8dde7] bg-[#f6f8fb] px-[8px]",
  "font-700 text-[#667085]",
].join(" ");
const windowRowClassName = [
  "grid [grid-column:1/-1] [grid-template-columns:subgrid]",
  "h-[2rem] min-h-[2rem] box-border border-0 border-b border-b-[#eef1f5]",
  "cursor-default bg-white hover:bg-[#f7f9fc]",
].join(" ");
const windowCellClassName = [
  "flex min-w-0 items-center overflow-hidden px-[8px]",
  "text-ellipsis whitespace-nowrap text-[#303642]",
].join(" ");
const windowFirstColumnClassName = "pl-[1rem]";
const windowMetaCellClassName = `${windowCellClassName} text-[#667085]`;
const windowPidCellClassName =
  `${windowCellClassName} font-mono text-[#475467]`;
const windowTitleClassName =
  "min-w-0 overflow-hidden text-ellipsis whitespace-nowrap";
const windowsFooterClassName = [
  "flex h-[2rem] min-h-[2rem] items-center justify-end border-t border-t-[#d8dde7]",
  "bg-[#fbfcfe] px-[8px] leading-[1.6] text-[#667085]",
].join(" ");
const windowDetailScrollClassName = "min-h-0 flex-1 overflow-auto";
const windowDetailBodyClassName =
  "grid min-w-0 content-start gap-[14px] px-[18px] py-[16px]";
const windowDetailNoteClassName = "text-[12px] text-[#667085]";
const windowDetailInlineActionClassName = [
  "inline-flex min-w-0 items-center gap-[0.5rem]",
  "max-w-full flex-wrap",
].join(" ");
const windowDetailOpenButtonClassName = [
  "inline-flex h-[1.6rem] items-center rounded-[0.25rem]",
  "border border-[#d8dde7] bg-white px-[0.5rem]",
  "cursor-pointer text-[#344054] [font-family:inherit]",
  "hover:border-[#b7c3d7] hover:bg-[#eef3fb]",
].join(" ");
const windowDetailFooterClassName = [
  "flex h-[2rem] min-h-[2rem] items-center justify-end border-t border-t-[#d8dde7]",
  "bg-[#fbfcfe] px-[8px] leading-[1.6] text-[#667085]",
].join(" ");

export function WindowsTool() {
  const machineModal = useBunja(machineModalBunja);
  const machineStore = useBunja(machineStoreBunja);
  const rpcSession = useBunja(rpcSessionBunja);
  const paneState = useBunja(workbenchPaneBunja);
  const tabState = useBunja(workbenchTabBunja);
  const machine = useAtomValue(machineStore.selectedAtom);
  const isPaired = useAtomValue(machineStore.selectedIsPairedAtom);
  const daemonInfo = useAtomValue(rpcSession.daemonInfoAtom);
  const tab = useAtomValue(tabState.tabAtom);
  const selectedWindowId = tab?.windowDetailId;

  const windowListSupported = daemonInfo.phase === "ready" &&
    daemonInfo.daemonInfo.supportedProcIds.includes(ProcId.SubscribeWindows);
  const windowDetailSupported = daemonInfo.phase === "ready" &&
    daemonInfo.daemonInfo.supportedProcIds.includes(
      ProcId.SubscribeWindowDetail,
    );

  if (!machine) {
    return (
      <section className={emptyWorkspaceClassName}>
        <HardDrive size={28} />
        <h2>No machine selected</h2>
      </section>
    );
  }

  if (!isPaired) {
    return (
      <section className={emptyWorkspaceClassName}>
        <KeyRound size={28} />
        <h2>Pairing required</h2>
        <Button onClick={() => machineModal.openPairMachineModal(machine.id)}>
          <KeyRound size={16} />
          Pair
        </Button>
      </section>
    );
  }

  return (
    <section className={windowsToolClassName}>
      <WindowsBreadcrumb
        selectedWindowId={selectedWindowId}
        onOpenRoot={() => tabState.setWindowDetailId(undefined)}
      />
      {selectedWindowId === undefined
        ? (
          <WindowListView
            daemonInfoPhase={daemonInfo.phase}
            machineId={machine.id}
            rpcSession={rpcSession}
            supported={windowListSupported}
            onOpenWindow={(window) =>
              paneState.addWindowsTab({
                title: windowTitle(window),
                windowDetailId: window.windowId,
              })}
          />
        )
        : (
          <WindowDetailView
            daemonInfoPhase={daemonInfo.phase}
            machineId={machine.id}
            onOpenProcess={(pid) =>
              paneState.addProcessesTab({
                processDetailPid: pid,
                title: `PID ${pid}`,
              })}
            rpcSession={rpcSession}
            supported={windowDetailSupported}
            windowId={selectedWindowId}
          />
        )}
    </section>
  );
}

interface WindowsBreadcrumbProps {
  selectedWindowId?: string;
  onOpenRoot: () => void;
}

function WindowsBreadcrumb(
  { selectedWindowId, onOpenRoot }: WindowsBreadcrumbProps,
) {
  return (
    <Breadcrumb
      ariaLabel="Window location"
      className="flex-[0_0_auto] border-b border-b-[#d8dde7] bg-[#fbfcfe] px-[0.5rem]"
      items={[
        {
          label: "Windows",
          onClick: selectedWindowId === undefined ? undefined : onOpenRoot,
        },
        {
          label: selectedWindowId === undefined ? "Overview" : selectedWindowId,
          muted: selectedWindowId === undefined,
          title: selectedWindowId,
        },
      ]}
    />
  );
}

interface WindowListViewProps {
  daemonInfoPhase: string;
  machineId: string;
  rpcSession: WindowsRpcSession;
  supported: boolean;
  onOpenWindow: (window: WindowInfo) => void;
}

function WindowListView(
  {
    daemonInfoPhase,
    machineId,
    rpcSession,
    supported,
    onOpenWindow,
  }: WindowListViewProps,
) {
  const rowsRef = useRef<WindowInfo[]>([]);
  const [state, setState] = useState<WindowsState>({
    phase: "idle",
    rows: [],
  });

  useEffect(() => {
    if (daemonInfoPhase === "error") {
      rowsRef.current = [];
      setState({
        message: "Daemon info unavailable",
        phase: "error",
        rows: [],
      });
      return;
    }
    if (daemonInfoPhase !== "ready") {
      rowsRef.current = [];
      setState({ phase: "loading", rows: [] });
      return;
    }
    if (!supported) {
      rowsRef.current = [];
      setState({
        message: "This daemon does not support window subscriptions.",
        phase: "unsupported",
        rows: [],
      });
      return;
    }

    let cancelled = false;
    let iterator: AsyncGenerator<WindowsTableEvent> | undefined;
    setState((current) => ({ ...current, phase: "loading" }));

    void (async () => {
      try {
        const transport = await rpcSession.webTransport();
        if (cancelled) return;
        iterator = subscribeWindows(transport);
        for await (const event of iterator) {
          if (cancelled) return;
          const rows = applyWindowsEvent(rowsRef.current, event);
          rowsRef.current = rows;
          setState({ phase: "ready", rows });
        }
      } catch (err) {
        if (cancelled) return;
        rowsRef.current = [];
        setState({
          message: err instanceof Error ? err.message : String(err),
          phase: "error",
          rows: [],
        });
      }
    })();

    return () => {
      cancelled = true;
      void iterator?.return(undefined);
    };
  }, [daemonInfoPhase, machineId, rpcSession, supported]);

  if (state.phase === "loading" || daemonInfoPhase !== "ready") {
    return (
      <section className={emptyWorkspaceClassName}>
        <Loader2 size={24} className="animate-spin" />
        <h2>Loading windows</h2>
      </section>
    );
  }

  if (state.phase === "unsupported" || state.phase === "error") {
    return (
      <section className={emptyWorkspaceClassName}>
        <AppWindow size={28} />
        <h2>
          {state.phase === "unsupported"
            ? "Windows unavailable"
            : "Failed to load windows"}
        </h2>
        {state.message ? <p>{state.message}</p> : null}
      </section>
    );
  }

  return (
    <div className={windowsContentClassName}>
      <div className={windowTableClassName} role="grid" aria-label="Windows">
        <div
          className={`${windowHeadClassName} ${windowFirstColumnClassName}`}
          role="columnheader"
        >
          Title
        </div>
        <div className={windowHeadClassName} role="columnheader">
          PID
        </div>
        <div className={windowHeadClassName} role="columnheader">
          State
        </div>
        {state.rows.length === 0
          ? (
            <div className={`${windowCellClassName} [grid-column:1/-1]`}>
              No windows
            </div>
          )
          : state.rows.map((window) => (
            <div
              key={window.windowId}
              className={windowRowClassName}
              role="row"
              onDoubleClick={() => onOpenWindow(window)}
            >
              <span
                className={`${windowCellClassName} ${windowFirstColumnClassName}`}
                title={windowTitle(window)}
              >
                <span className={windowTitleClassName}>
                  {windowTitle(window)}
                </span>
              </span>
              <span className={windowPidCellClassName}>
                {window.processId ?? ""}
              </span>
              <span className={windowMetaCellClassName}>
                {window.focused ? "Focused" : ""}
              </span>
            </div>
          ))}
      </div>
      <footer className={windowsFooterClassName}>
        {state.rows.length} {state.rows.length === 1 ? "window" : "windows"}
      </footer>
    </div>
  );
}

interface WindowDetailViewProps {
  daemonInfoPhase: string;
  machineId: string;
  onOpenProcess: (pid: number) => void;
  rpcSession: WindowsRpcSession;
  supported: boolean;
  windowId: string;
}

function WindowDetailView(
  {
    daemonInfoPhase,
    machineId,
    onOpenProcess,
    rpcSession,
    supported,
    windowId,
  }: WindowDetailViewProps,
) {
  const [state, setState] = useState<WindowDetailState>({
    phase: "idle",
  });

  useEffect(() => {
    if (daemonInfoPhase === "error") {
      setState({
        message: "Daemon info unavailable",
        phase: "error",
      });
      return;
    }
    if (daemonInfoPhase !== "ready") {
      setState({ phase: "loading" });
      return;
    }
    if (!supported) {
      setState({
        message: "This daemon does not support window detail subscriptions.",
        phase: "unsupported",
      });
      return;
    }

    let cancelled = false;
    let iterator: AsyncGenerator<WindowDetailEvent> | undefined;
    setState({ phase: "loading" });

    void (async () => {
      try {
        const transport = await rpcSession.webTransport();
        if (cancelled) return;
        iterator = subscribeWindowDetail(transport, { windowId });
        for await (const event of iterator) {
          if (cancelled) return;
          setState((current) => applyWindowDetailEvent(current, event));
          if (event.type === "closed") return;
        }
      } catch (err) {
        if (cancelled) return;
        setState({
          message: err instanceof Error ? err.message : String(err),
          phase: "error",
        });
      }
    })();

    return () => {
      cancelled = true;
      void iterator?.return(undefined);
    };
  }, [daemonInfoPhase, machineId, rpcSession, supported, windowId]);

  if (state.phase === "loading" || daemonInfoPhase !== "ready") {
    return (
      <section className={emptyWorkspaceClassName}>
        <Loader2 size={24} className="animate-spin" />
        <h2>Loading window</h2>
      </section>
    );
  }

  if (state.phase === "unsupported" || state.phase === "error") {
    return (
      <section className={emptyWorkspaceClassName}>
        <AppWindow size={28} />
        <h2>
          {state.phase === "unsupported"
            ? "Window detail unavailable"
            : "Failed to load window"}
        </h2>
        {state.message ? <p>{state.message}</p> : null}
      </section>
    );
  }

  if (!state.detail) {
    return (
      <section className={emptyWorkspaceClassName}>
        <AppWindow size={28} />
        <h2>No window detail</h2>
      </section>
    );
  }

  return (
    <div className={windowsContentClassName}>
      <WindowDetailSummary
        detail={state.detail}
        onOpenProcess={onOpenProcess}
      />
      <footer className={windowDetailFooterClassName}>
        {state.phase === "closed"
          ? "Window closed"
          : state.detail.info.windowId}
      </footer>
    </div>
  );
}

interface WindowDetailSummaryProps {
  detail: WindowDetail;
  onOpenProcess: (pid: number) => void;
}

function WindowDetailSummary(
  { detail, onOpenProcess }: WindowDetailSummaryProps,
) {
  const { bounds, info, state } = detail;
  return (
    <div className={windowDetailScrollClassName}>
      <div className={windowDetailBodyClassName}>
        <PropertyList>
          <WindowDetailItem label="Title" value={windowTitle(info)} />
          <WindowDetailItem label="Window ID" value={info.windowId} />
          <WindowProcessIdItem
            processId={info.processId}
            onOpenProcess={onOpenProcess}
          />
          <WindowDetailItem
            label="Focused"
            value={booleanLabel(info.focused)}
          />
        </PropertyList>
        <PropertyList>
          <WindowDetailItem
            label="Visible"
            value={booleanLabel(state.visible)}
          />
          <WindowDetailItem
            label="Minimized"
            value={booleanLabel(state.minimized)}
          />
          <WindowDetailItem
            label="Maximized"
            value={booleanLabel(state.maximized)}
          />
        </PropertyList>
        <PropertyList>
          <WindowDetailItem label="X" value={formatBoundsNumber(bounds?.x)} />
          <WindowDetailItem label="Y" value={formatBoundsNumber(bounds?.y)} />
          <WindowDetailItem
            label="Width"
            value={formatBoundsNumber(bounds?.width)}
          />
          <WindowDetailItem
            label="Height"
            value={formatBoundsNumber(bounds?.height)}
          />
        </PropertyList>
      </div>
    </div>
  );
}

interface WindowProcessIdItemProps {
  onOpenProcess: (pid: number) => void;
  processId?: number;
}

function WindowProcessIdItem(
  { onOpenProcess, processId }: WindowProcessIdItemProps,
) {
  return (
    <PropertyListItem label="PID">
      {processId === undefined
        ? <PropertyValue>Unknown</PropertyValue>
        : (
          <span className={windowDetailInlineActionClassName}>
            <PropertyValue>{processId}</PropertyValue>
            <button
              type="button"
              className={windowDetailOpenButtonClassName}
              onClick={() => onOpenProcess(processId)}
              title={`Open process ${processId}`}
            >
              Open
            </button>
          </span>
        )}
    </PropertyListItem>
  );
}

interface WindowDetailItemProps {
  label: string;
  note?: string;
  value: string;
}

function WindowDetailItem({ label, note, value }: WindowDetailItemProps) {
  return (
    <PropertyListItem label={label}>
      <PropertyValue>{value}</PropertyValue>
      {note ? <span className={windowDetailNoteClassName}>{note}</span> : null}
    </PropertyListItem>
  );
}

function applyWindowDetailEvent(
  current: WindowDetailState,
  event: WindowDetailEvent,
): WindowDetailState {
  switch (event.type) {
    case "snapshot":
      return { detail: event.detail, phase: "ready" };
    case "infoChanged":
      return current.detail
        ? {
          detail: { ...current.detail, info: event.info },
          phase: current.phase === "closed" ? "closed" : "ready",
        }
        : current;
    case "stateChanged":
      return current.detail
        ? {
          detail: { ...current.detail, state: event.state },
          phase: current.phase === "closed" ? "closed" : "ready",
        }
        : current;
    case "boundsChanged":
      return current.detail
        ? {
          detail: { ...current.detail, bounds: event.bounds },
          phase: current.phase === "closed" ? "closed" : "ready",
        }
        : current;
    case "closed":
      return { ...current, phase: "closed" };
  }
}

function applyWindowsEvent(
  currentRows: WindowInfo[],
  event: WindowsTableEvent,
): WindowInfo[] {
  if (event.type === "snapshot") {
    return sortedWindows(event.rows);
  }

  const rowsById = new Map(currentRows.map((row) => [row.windowId, row]));
  for (const windowId of event.removes) {
    rowsById.delete(windowId);
  }
  for (const row of event.upserts) {
    rowsById.set(row.windowId, row);
  }
  return sortedWindows([...rowsById.values()]);
}

function sortedWindows(rows: WindowInfo[]): WindowInfo[] {
  return [...rows].sort((a, b) => {
    const pidCompare = compareOptionalNumber(a.processId, b.processId);
    if (pidCompare !== 0) return pidCompare;

    const titleCompare = windowTitle(a).localeCompare(windowTitle(b));
    if (titleCompare !== 0) return titleCompare;

    return a.windowId.localeCompare(b.windowId);
  });
}

function compareOptionalNumber(
  left: number | undefined,
  right: number | undefined,
): number {
  if (left === right) return 0;
  if (left === undefined) return 1;
  if (right === undefined) return -1;
  return left - right;
}

function windowTitle(window: WindowInfo): string {
  return window.title || window.windowId;
}

function booleanLabel(value: boolean | undefined): string {
  if (value === undefined) return "Unknown";
  return value ? "Yes" : "No";
}

function formatBoundsNumber(value: number | undefined): string {
  return value === undefined ? "Unknown" : String(value);
}
