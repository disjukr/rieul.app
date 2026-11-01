import { style, theme } from "../../../../zyzz.config.ts";
import type {
  WindowDetail,
  WindowDetailEvent,
  WindowsTableEvent,
} from "../../../../protocol/generated/rpc.ts";
import { createSignal, createMemo, createEffect } from "solid-js";

import { useBunja } from "bunja/solid";
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

export function WindowsTool() {
  const machineModal = useBunja(machineModalBunja);
  const machineStore = useBunja(machineStoreBunja);
  const rpcSession = useBunja(rpcSessionBunja);
  const paneState = useBunja(workbenchPaneBunja);
  const tabState = useBunja(workbenchTabBunja);
  const machine = () => machineStore().selected();
  const isPaired = () => machineStore().selectedIsPaired();
  const daemonInfo = () => rpcSession().daemonInfo();
  const readyDaemonInfo = createMemo(() => {
    const value = daemonInfo();
    return value.phase === "ready" ? value.daemonInfo : undefined;
  });
  const tab = () => tabState().tab();
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
            <section {...styles.emptyWorkspace()}>
              <HardDrive size={28} />
              <h2>No machine selected</h2>
            </section>
          );
        }
        if (!isPaired()) {
          return (
            <section {...styles.emptyWorkspace()}>
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
          <section {...styles.windowsTool()}>
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
            className={styles.breadcrumb().class}
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
            <section {...styles.emptyWorkspace()}>
              <Loader2 size={24} className={styles.loader2().class} />
              <h2>Loading windows</h2>
            </section>
          );
        }
        if (state().phase === "unsupported" || state().phase === "error") {
          return (
            <section {...styles.emptyWorkspace()}>
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
          <div {...styles.windowsContent()}>
            <div {...styles.windowTable()} role="grid" aria-label="Windows">
              <div
                class={`${styles.windowHead().class} ${styles.windowFirstColumn().class}`}
                role="columnheader"
              >
                Title
              </div>
              <div {...styles.windowHead()} role="columnheader">
                PID
              </div>
              <div {...styles.windowHead()} role="columnheader">
                State
              </div>
              {state().rows.length === 0 ? (
                <div
                  class={`${styles.windowCell().class} ${styles.fullRow().class}`}
                >
                  No windows
                </div>
              ) : (
                state().rows.map((window) => (
                  <div
                    class={`${styles.windowRow().class} ${styles.interactiveRow().class}`}
                    role="row"
                    onDblClick={() => props.onOpenWindow(window)}
                  >
                    <span
                      class={`${styles.windowCell().class} ${styles.windowFirstColumn().class}`}
                      title={windowTitle(window)}
                    >
                      <span {...styles.windowTitle()}>
                        {windowTitle(window)}
                      </span>
                    </span>
                    <span
                      class={`${styles.windowCell().class} ${styles.monospaceCell().class} `}
                    >
                      {window.processId ?? ""}
                    </span>
                    <span
                      class={`${styles.windowCell().class} ${styles.mutedCell().class} `}
                    >
                      {window.focused ? "Focused" : ""}
                    </span>
                  </div>
                ))
              )}
            </div>
            <footer {...styles.windowsFooter()}>
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
            <section {...styles.emptyWorkspace()}>
              <Loader2 size={24} className={styles.loader2().class} />
              <h2>Loading window</h2>
            </section>
          );
        }
        if (state().phase === "unsupported" || state().phase === "error") {
          return (
            <section {...styles.emptyWorkspace()}>
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
            <section {...styles.emptyWorkspace()}>
              <AppWindow size={28} />
              <h2>No window detail</h2>
            </section>
          );
        }
        return (
          <div {...styles.windowsContent()}>
            <WindowDetailSummary
              detail={state().detail!}
              onOpenProcess={props.onOpenProcess}
            />
            <footer {...styles.windowsFooter()}>
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
          <div {...styles.windowDetailScroll()}>
            <div {...styles.windowDetailBody()}>
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
              <span {...styles.windowDetailInlineAction()}>
                <PropertyValue>{props.processId}</PropertyValue>
                <button
                  type="button"
                  {...styles.windowDetailOpenButton()}
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
              <span {...styles.windowDetailNote()}>{props.note}</span>
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

namespace styles {
  export const monospaceCell = style({
    color: theme.textSecondary,
    fontFamily:
      'ui-monospace,SFMono-Regular,Menlo,Monaco,Consolas,"Liberation Mono","Courier New",monospace',
  });
  export const mutedCell = style({
    color: theme.textTertiary,
  });
  export const fullRow = style({
    gridColumn: "1/-1",
  });

  export const interactiveRow = style({
    cursor: "pointer !important",
  });

  export const windowsTool = style({
    height: "100%",
    minHeight: "0",
    width: "100%",
    display: "flex",
    flexDirection: "column",
    overflow: "hidden",
    backgroundColor: theme.bgPrimary,
    color: theme.textPrimary,
  });
  export const windowsContent = style({
    minHeight: "0",
    minWidth: "0",
    display: "flex",
    flex: "1 1 0%",
    flexDirection: "column",
    overflow: "hidden",
  });
  export const emptyWorkspace = style({
    display: "grid",
    selectors: {
      "& h2": {
        margin: "0",
        fontSize: "18px",
        color: theme.textPrimary,
        letterSpacing: "0",
      },
      "& p": {
        margin: "0",
        maxWidth: "360px",
        textAlign: "center",
        lineHeight: 1.45,
      },
    },
    height: "100%",
    minHeight: "0",
    width: "100%",
    alignContent: "center",
    justifyItems: "center",
    gap: "10px",
    backgroundColor: theme.bgPrimary,
    color: theme.textTertiary,
  });
  export const windowTable = style({
    gridTemplateColumns:
      "minmax(240px,1fr) minmax(80px,112px) minmax(96px,120px)",
    display: "grid",
    gridAutoRows: "2rem",
    minHeight: "0",
    minWidth: "0",
    flex: "1 1 0%",
    overflow: "auto",
    backgroundColor: theme.bgPrimary,
    lineHeight: 1.6,
  });
  export const windowHead = style({
    position: "sticky",
    top: "0",
    zIndex: 1,
    boxSizing: "border-box",
    height: "2rem",
    display: "flex",
    alignItems: "center",
    borderBottomWidth: "1px",
    borderBottomColor: theme.borderLight,
    backgroundColor: theme.bgSecondary,
    paddingLeft: "8px",
    paddingRight: "8px",
    color: theme.textTertiary,
    fontWeight: 600,
  });
  export const windowRow = style({
    gridColumn: "1/-1",
    gridTemplateColumns: "subgrid",
    display: "grid",
    boxSizing: "border-box",
    height: "2rem",
    minHeight: "2rem",
    cursor: "default",
    borderWidth: "0px",
    borderBottomWidth: "1px",
    borderBottomColor: theme.borderSubtle,
    backgroundColor: theme.bgPrimary,
    selectors: {
      "&:hover": {
        backgroundColor: theme.bgHover,
      },
    },
  });
  export const windowCell = style({
    minWidth: "0",
    display: "flex",
    alignItems: "center",
    overflow: "hidden",
    textOverflow: "ellipsis",
    whiteSpace: "nowrap",
    paddingLeft: "8px",
    paddingRight: "8px",
    color: theme.textPrimary,
  });
  export const windowFirstColumn = style({
    paddingLeft: "1rem",
  });
  export const windowTitle = style({
    minWidth: "0",
    overflow: "hidden",
    textOverflow: "ellipsis",
    whiteSpace: "nowrap",
  });
  export const windowsFooter = style({
    height: "2rem",
    minHeight: "2rem",
    display: "flex",
    alignItems: "center",
    justifyContent: "flex-end",
    borderTopWidth: "1px",
    borderTopColor: theme.borderLight,
    backgroundColor: theme.bgSecondary,
    paddingLeft: "8px",
    paddingRight: "8px",
    color: theme.textTertiary,
    lineHeight: 1.6,
  });
  export const windowDetailScroll = style({
    minHeight: "0",
    flex: "1 1 0%",
    overflow: "auto",
  });
  export const windowDetailBody = style({
    display: "grid",
    minWidth: "0",
    alignContent: "flex-start",
    gap: "14px",
    paddingLeft: "18px",
    paddingRight: "18px",
    paddingTop: "16px",
    paddingBottom: "16px",
  });
  export const windowDetailNote = style({
    fontSize: "13px",
    color: theme.textTertiary,
  });
  export const windowDetailInlineAction = style({
    maxWidth: "100%",
    minWidth: "0",
    display: "inline-flex",
    flexWrap: "wrap",
    alignItems: "center",
    gap: "0.5rem",
  });
  export const windowDetailOpenButton = style({
    fontFamily: "inherit",
    height: "1.6rem",
    display: "inline-flex",
    cursor: "pointer",
    alignItems: "center",
    borderWidth: "1px",
    borderColor: theme.borderLight,
    selectors: {
      "&:hover": {
        borderColor: theme.borderMedium,
        backgroundColor: theme.bgHover,
      },
    },
    borderRadius: "0.25rem",
    backgroundColor: theme.bgPrimary,
    paddingLeft: "0.5rem",
    paddingRight: "0.5rem",
    color: theme.textSecondary,
  });

  export const breadcrumb = style({
    flex: "0 0 auto",
    borderBottomWidth: "1px",
    borderBottomColor: "rgb(216 221 231 / 1)",
    backgroundColor: "rgb(251 252 254 / 1)",
    paddingLeft: "0.5rem",
    paddingRight: "0.5rem",
  });
  export const loader2 = style({
    animation: "spin 1s linear infinite",
  });
}
