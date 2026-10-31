import type {
  WindowDetail,
  WindowDetailEvent,
  WindowsTableEvent,
} from "../../../../protocol/generated/rpc.ts";
import { createSignal, createMemo, createEffect } from "solid-js";
import { useAtomValue } from "../../../../solid/jotai.tsx";
import { useBunja } from "../../../../solid/bunja.tsx";
import {
  AppWindow,
  HardDrive,
  KeyRound,
  Loader2,
} from "../../../../solid/icons.tsx";
import {
  subscribeWindowDetail,
  subscribeWindows,
} from "../../../../protocol/generated/client.ts";
import { ProcId, type WindowInfo } from "../../../../protocol/generated/rpc.ts";
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
  "overflow-hidden bg-rieul-surface text-rieul-text",
].join(" ");
const windowsContentClassName =
  "flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden";
const emptyWorkspaceClassName = [
  "grid content-center justify-items-center w-full h-full gap-[10px]",
  "min-h-0 bg-rieul-surface text-rieul-text-3",
  "[&_h2]:m-0 [&_h2]:text-rieul-text [&_h2]:text-[18px] [&_h2]:tracking-[0]",
  "[&_p]:m-0 [&_p]:max-w-[360px] [&_p]:text-center [&_p]:leading-[1.45]",
].join(" ");
const windowTableClassName = [
  "grid min-h-0 min-w-0 flex-1 overflow-auto leading-[1.6]",
  "[grid-template-columns:minmax(240px,1fr)_minmax(80px,112px)_minmax(96px,120px)]",
  "auto-rows-[2rem] bg-rieul-surface",
].join(" ");
const windowHeadClassName = [
  "sticky top-0 z-[1] flex h-[2rem] box-border items-center",
  "border-b border-b-rieul-border bg-rieul-surface-2 px-[8px]",
  "font-600 text-rieul-text-3",
].join(" ");
const windowRowClassName = [
  "grid [grid-column:1/-1] [grid-template-columns:subgrid]",
  "h-[2rem] min-h-[2rem] box-border border-0 border-b border-b-rieul-border-subtle",
  "cursor-default bg-rieul-surface hover:bg-rieul-hover",
].join(" ");
const windowCellClassName = [
  "flex min-w-0 items-center overflow-hidden px-[8px]",
  "text-ellipsis whitespace-nowrap text-rieul-text",
].join(" ");
const windowFirstColumnClassName = "pl-[1rem]";
const windowMetaCellClassName = `${windowCellClassName} text-rieul-text-3`;
const windowPidCellClassName = `${windowCellClassName} font-mono text-rieul-text-2`;
const windowTitleClassName =
  "min-w-0 overflow-hidden text-ellipsis whitespace-nowrap";
const windowsFooterClassName = [
  "flex h-[2rem] min-h-[2rem] items-center justify-end border-t border-t-rieul-border",
  "bg-rieul-surface-2 px-[8px] leading-[1.6] text-rieul-text-3",
].join(" ");
const windowDetailScrollClassName = "min-h-0 flex-1 overflow-auto";
const windowDetailBodyClassName =
  "grid min-w-0 content-start gap-[14px] px-[18px] py-[16px]";
const windowDetailNoteClassName = "text-[13px] text-rieul-text-3";
const windowDetailInlineActionClassName = [
  "inline-flex min-w-0 items-center gap-[0.5rem]",
  "max-w-full flex-wrap",
].join(" ");
const windowDetailOpenButtonClassName = [
  "inline-flex h-[1.6rem] items-center rounded-[0.25rem]",
  "border border-rieul-border bg-rieul-surface px-[0.5rem]",
  "cursor-pointer text-rieul-text-2 [font-family:inherit]",
  "hover:border-rieul-border-medium hover:bg-rieul-hover",
].join(" ");
const windowDetailFooterClassName = [
  "flex h-[2rem] min-h-[2rem] items-center justify-end border-t border-t-rieul-border",
  "bg-rieul-surface-2 px-[8px] leading-[1.6] text-rieul-text-3",
].join(" ");
export function WindowsTool() {
  const machineModal = useBunja(machineModalBunja);
  const machineStore = useBunja(machineStoreBunja);
  const rpcSession = useBunja(rpcSessionBunja);
  const paneState = useBunja(workbenchPaneBunja);
  const tabState = useBunja(workbenchTabBunja);
  const machine = useAtomValue(() => machineStore().selectedAtom);
  const isPaired = useAtomValue(() => machineStore().selectedIsPairedAtom);
  const daemonInfo = useAtomValue(() => rpcSession().daemonInfoAtom);
  const readyDaemonInfo = createMemo(() => {
    const value = daemonInfo();
    return value.phase === "ready" ? value.daemonInfo : undefined;
  });
  const tab = useAtomValue(() => tabState().tabAtom);
  const selectedWindowId = createMemo(() => tab()?.windowDetailId);
  const windowListSupported = createMemo(
    () =>
      daemonInfo().phase === "ready" &&
      readyDaemonInfo()!.supportedProcIds.includes(ProcId.SubscribeWindows),
  );
  const windowDetailSupported = createMemo(
    () =>
      daemonInfo().phase === "ready" &&
      readyDaemonInfo()!.supportedProcIds.includes(
        ProcId.SubscribeWindowDetail,
      ),
  );
  return (
    <>
      {(() => {
        if (!machine()) {
          return (
            <section class={emptyWorkspaceClassName}>
              <HardDrive size={28} />
              <h2>No machine selected</h2>
            </section>
          );
        }
        if (!isPaired()) {
          return (
            <section class={emptyWorkspaceClassName}>
              <KeyRound size={28} />
              <h2>Pairing required</h2>
              <Button
                onClick={() =>
                  machineModal().openPairMachineModal(machine()!.id)
                }
              >
                <KeyRound size={16} />
                Pair
              </Button>
            </section>
          );
        }
        return (
          <section class={windowsToolClassName}>
            <WindowsBreadcrumb
              selectedWindowId={selectedWindowId()}
              onOpenRoot={() => tabState().setWindowDetailId(undefined)}
            />
            {selectedWindowId() === undefined ? (
              <WindowListView
                daemonInfoPhase={daemonInfo().phase}
                machineId={machine()!.id}
                rpcSession={rpcSession()}
                supported={windowListSupported()}
                onOpenWindow={(window) =>
                  paneState().addWindowsTab({
                    title: windowTitle(window),
                    windowDetailId: window.windowId,
                  })
                }
              />
            ) : (
              <WindowDetailView
                daemonInfoPhase={daemonInfo().phase}
                machineId={machine()!.id}
                onOpenProcess={(pid) =>
                  paneState().addProcessesTab({
                    processDetailPid: pid,
                    title: `PID ${pid}`,
                  })
                }
                rpcSession={rpcSession()}
                supported={windowDetailSupported()}
                windowId={selectedWindowId()!}
              />
            )}
          </section>
        );
      })()}
    </>
  );
}
interface WindowsBreadcrumbProps {
  selectedWindowId?: string;
  onOpenRoot: () => void;
}
function WindowsBreadcrumb(props: WindowsBreadcrumbProps) {
  return (
    <>
      {(() => {
        return (
          <Breadcrumb
            ariaLabel="Window location"
            className="flex-[0_0_auto] border-b border-b-[#d8dde7] bg-[#fbfcfe] px-[0.5rem]"
            items={[
              {
                label: "Windows",
                onClick:
                  props.selectedWindowId === undefined
                    ? undefined
                    : props.onOpenRoot,
              },
              {
                label:
                  props.selectedWindowId === undefined
                    ? "Overview"
                    : props.selectedWindowId,
                muted: props.selectedWindowId === undefined,
                title: props.selectedWindowId,
              },
            ]}
          />
        );
      })()}
    </>
  );
}
interface WindowListViewProps {
  daemonInfoPhase: string;
  machineId: string;
  rpcSession: WindowsRpcSession;
  supported: boolean;
  onOpenWindow: (window: WindowInfo) => void;
}
function WindowListView(props: WindowListViewProps) {
  const rowsRef = {
    current: [] as WindowInfo[],
  };
  const [state, setState] = createSignal<WindowsState>({
    phase: "idle",
    rows: [],
  });
  createEffect(
    createMemo(
      () =>
        [
          props.daemonInfoPhase,
          props.machineId,
          props.rpcSession,
          props.supported,
        ] as const,
      {
        equals: (a, b) =>
          a.length === b.length &&
          a.every((value, index) => Object.is(value, b[index])),
      },
    ),
    ([snapshotDaemonInfoPhase, , snapshotRpcSession, snapshotSupported]) => {
      if (snapshotDaemonInfoPhase === "error") {
        rowsRef.current = [];
        setState({
          message: "Daemon info unavailable",
          phase: "error",
          rows: [],
        });
        return;
      }
      if (snapshotDaemonInfoPhase !== "ready") {
        rowsRef.current = [];
        setState({
          phase: "loading",
          rows: [],
        });
        return;
      }
      if (!snapshotSupported) {
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
      setState((current) => ({
        ...current,
        phase: "loading",
      }));
      void (async () => {
        try {
          const transport = await snapshotRpcSession.webTransport();
          if (cancelled) return;
          iterator = subscribeWindows(transport);
          for await (const event of iterator) {
            if (cancelled) return;
            const rows = applyWindowsEvent(rowsRef.current, event);
            rowsRef.current = rows;
            setState({
              phase: "ready",
              rows,
            });
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
    },
  );
  return (
    <>
      {(() => {
        if (state().phase === "loading" || props.daemonInfoPhase !== "ready") {
          return (
            <section class={emptyWorkspaceClassName}>
              <Loader2 size={24} className="animate-spin" />
              <h2>Loading windows</h2>
            </section>
          );
        }
        if (state().phase === "unsupported" || state().phase === "error") {
          return (
            <section class={emptyWorkspaceClassName}>
              <AppWindow size={28} />
              <h2>
                {state().phase === "unsupported"
                  ? "Windows unavailable"
                  : "Failed to load windows"}
              </h2>
              {state().message ? <p>{state().message}</p> : null}
            </section>
          );
        }
        return (
          <div class={windowsContentClassName}>
            <div class={windowTableClassName} role="grid" aria-label="Windows">
              <div
                class={`${windowHeadClassName} ${windowFirstColumnClassName}`}
                role="columnheader"
              >
                Title
              </div>
              <div class={windowHeadClassName} role="columnheader">
                PID
              </div>
              <div class={windowHeadClassName} role="columnheader">
                State
              </div>
              {state().rows.length === 0 ? (
                <div class={`${windowCellClassName} [grid-column:1/-1]`}>
                  No windows
                </div>
              ) : (
                state().rows.map((window) => (
                  <div
                    class={`${windowRowClassName} !cursor-pointer`}
                    role="row"
                    onDblClick={() => props.onOpenWindow(window)}
                  >
                    <span
                      class={`${windowCellClassName} ${windowFirstColumnClassName}`}
                      title={windowTitle(window)}
                    >
                      <span class={windowTitleClassName}>
                        {windowTitle(window)}
                      </span>
                    </span>
                    <span class={windowPidCellClassName}>
                      {window.processId ?? ""}
                    </span>
                    <span class={windowMetaCellClassName}>
                      {window.focused ? "Focused" : ""}
                    </span>
                  </div>
                ))
              )}
            </div>
            <footer class={windowsFooterClassName}>
              {state().rows.length}{" "}
              {state().rows.length === 1 ? "window" : "windows"}
            </footer>
          </div>
        );
      })()}
    </>
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
function WindowDetailView(props: WindowDetailViewProps) {
  const [state, setState] = createSignal<WindowDetailState>({
    phase: "idle",
  });
  createEffect(
    createMemo(
      () =>
        [
          props.daemonInfoPhase,
          props.machineId,
          props.rpcSession,
          props.supported,
          props.windowId,
        ] as const,
      {
        equals: (a, b) =>
          a.length === b.length &&
          a.every((value, index) => Object.is(value, b[index])),
      },
    ),
    ([
      snapshotDaemonInfoPhase,
      ,
      snapshotRpcSession,
      snapshotSupported,
      snapshotWindowId,
    ]) => {
      if (snapshotDaemonInfoPhase === "error") {
        setState({
          message: "Daemon info unavailable",
          phase: "error",
        });
        return;
      }
      if (snapshotDaemonInfoPhase !== "ready") {
        setState({
          phase: "loading",
        });
        return;
      }
      if (!snapshotSupported) {
        setState({
          message: "This daemon does not support window detail subscriptions.",
          phase: "unsupported",
        });
        return;
      }
      let cancelled = false;
      let iterator: AsyncGenerator<WindowDetailEvent> | undefined;
      setState({
        phase: "loading",
      });
      void (async () => {
        try {
          const transport = await snapshotRpcSession.webTransport();
          if (cancelled) return;
          iterator = subscribeWindowDetail(transport, {
            windowId: snapshotWindowId,
          });
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
    },
  );
  return (
    <>
      {(() => {
        if (state().phase === "loading" || props.daemonInfoPhase !== "ready") {
          return (
            <section class={emptyWorkspaceClassName}>
              <Loader2 size={24} className="animate-spin" />
              <h2>Loading window</h2>
            </section>
          );
        }
        if (state().phase === "unsupported" || state().phase === "error") {
          return (
            <section class={emptyWorkspaceClassName}>
              <AppWindow size={28} />
              <h2>
                {state().phase === "unsupported"
                  ? "Window detail unavailable"
                  : "Failed to load window"}
              </h2>
              {state().message ? <p>{state().message}</p> : null}
            </section>
          );
        }
        if (!state().detail) {
          return (
            <section class={emptyWorkspaceClassName}>
              <AppWindow size={28} />
              <h2>No window detail</h2>
            </section>
          );
        }
        return (
          <div class={windowsContentClassName}>
            <WindowDetailSummary
              detail={state().detail!}
              onOpenProcess={props.onOpenProcess}
            />
            <footer class={windowDetailFooterClassName}>
              {state().phase === "closed"
                ? "Window closed"
                : state().detail!.info.windowId}
            </footer>
          </div>
        );
      })()}
    </>
  );
}
interface WindowDetailSummaryProps {
  detail: WindowDetail;
  onOpenProcess: (pid: number) => void;
}
function WindowDetailSummary(props: WindowDetailSummaryProps) {
  const _value = createMemo(() => props.detail);
  return (
    <>
      {(() => {
        return (
          <div class={windowDetailScrollClassName}>
            <div class={windowDetailBodyClassName}>
              <PropertyList>
                <WindowDetailItem
                  label="Title"
                  value={windowTitle(_value().info)}
                />
                <WindowDetailItem
                  label="Window ID"
                  value={_value().info.windowId}
                />
                <WindowProcessIdItem
                  processId={_value().info.processId}
                  onOpenProcess={props.onOpenProcess}
                />
                <WindowDetailItem
                  label="Focused"
                  value={booleanLabel(_value().info.focused)}
                />
              </PropertyList>
              <PropertyList>
                <WindowDetailItem
                  label="Visible"
                  value={booleanLabel(_value().state.visible)}
                />
                <WindowDetailItem
                  label="Minimized"
                  value={booleanLabel(_value().state.minimized)}
                />
                <WindowDetailItem
                  label="Maximized"
                  value={booleanLabel(_value().state.maximized)}
                />
              </PropertyList>
              <PropertyList>
                <WindowDetailItem
                  label="X"
                  value={formatBoundsNumber(_value().bounds?.x)}
                />
                <WindowDetailItem
                  label="Y"
                  value={formatBoundsNumber(_value().bounds?.y)}
                />
                <WindowDetailItem
                  label="Width"
                  value={formatBoundsNumber(_value().bounds?.width)}
                />
                <WindowDetailItem
                  label="Height"
                  value={formatBoundsNumber(_value().bounds?.height)}
                />
              </PropertyList>
            </div>
          </div>
        );
      })()}
    </>
  );
}
interface WindowProcessIdItemProps {
  onOpenProcess: (pid: number) => void;
  processId?: number;
}
function WindowProcessIdItem(props: WindowProcessIdItemProps) {
  return (
    <>
      {(() => {
        return (
          <PropertyListItem label="PID">
            {props.processId === undefined ? (
              <PropertyValue>Unknown</PropertyValue>
            ) : (
              <span class={windowDetailInlineActionClassName}>
                <PropertyValue>{props.processId}</PropertyValue>
                <button
                  type="button"
                  class={windowDetailOpenButtonClassName}
                  onClick={() => props.onOpenProcess(props.processId!)}
                  title={`Open process ${props.processId}`}
                >
                  Open
                </button>
              </span>
            )}
          </PropertyListItem>
        );
      })()}
    </>
  );
}
interface WindowDetailItemProps {
  label: string;
  note?: string;
  value: string;
}
function WindowDetailItem(props: WindowDetailItemProps) {
  return (
    <>
      {(() => {
        return (
          <PropertyListItem label={props.label}>
            <PropertyValue>{props.value}</PropertyValue>
            {props.note ? (
              <span class={windowDetailNoteClassName}>{props.note}</span>
            ) : null}
          </PropertyListItem>
        );
      })()}
    </>
  );
}
function applyWindowDetailEvent(
  current: WindowDetailState,
  event: WindowDetailEvent,
): WindowDetailState {
  switch (event.type) {
    case "snapshot":
      return {
        detail: event.detail,
        phase: "ready",
      };
    case "infoChanged":
      return current.detail
        ? {
            detail: {
              ...current.detail,
              info: event.info,
            },
            phase: current.phase === "closed" ? "closed" : "ready",
          }
        : current;
    case "stateChanged":
      return current.detail
        ? {
            detail: {
              ...current.detail,
              state: event.state,
            },
            phase: current.phase === "closed" ? "closed" : "ready",
          }
        : current;
    case "boundsChanged":
      return current.detail
        ? {
            detail: {
              ...current.detail,
              bounds: event.bounds,
            },
            phase: current.phase === "closed" ? "closed" : "ready",
          }
        : current;
    case "closed":
      return {
        ...current,
        phase: "closed",
      };
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
