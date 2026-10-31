import type {
  FsEntry,
  ProcessDetail,
  ProcessDetailEvent,
  ProcessModulesTableEvent,
  ProcessResourcesInUseTableEvent,
  ProcessSocketsInUseTableEvent,
  ProcessStatus,
  SocketEndpoint,
} from "../../../../protocol/generated/rpc.ts";
import type { WorkbenchProcessPage } from "../../../../state/workbench.ts";
import type { BreadcrumbItem } from "../../../ui/breadcrumb.tsx";
import { createSignal, createMemo, createEffect } from "solid-js";
import { useAtomValue } from "../../../../solid/jotai.tsx";
import { useBunja } from "../../../../solid/bunja.tsx";
import { nowBunja } from "../../../../state/now.ts";
import {
  Activity,
  CircleStop,
  ExternalLink,
  HardDrive,
  KeyRound,
  Loader2,
  X,
} from "../../../../solid/icons.tsx";
import {
  killProcess,
  subscribeProcessDetail,
  subscribeProcessModules,
  subscribeProcessResourcesInUse,
  subscribeProcessSocketsInUse,
} from "../../../../protocol/generated/client.ts";
import {
  FsEntryKind,
  type ProcessInfo,
  type ProcessModuleInfo,
  ProcessModuleKind,
  type ProcessResourceInUseInfo,
  ProcessResourceInUseKind,
  type ProcessSocketInUseInfo,
  ProcId,
} from "../../../../protocol/generated/rpc.ts";
import { processesBunja } from "../../../../state/processes.ts";
import { machineModalBunja } from "../../../../state/machine-modal.ts";
import { machineStoreBunja } from "../../../../state/machine-store.ts";
import { rpcSessionBunja } from "../../../../state/rpc-session.ts";
import {
  parentPath,
  writeExplorerDirectoryNavigationState,
  writeExplorerFileNavigationState,
} from "../../../../state/explorer.ts";
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
interface ProcessesRpcSession {
  webTransport: () => Promise<WebTransport>;
}
interface ProcessDetailState {
  detail?: ProcessDetail;
  message?: string;
  phase: "idle" | "loading" | "ready" | "exited" | "error" | "unsupported";
}
interface ProcessResourcesInUseState {
  message?: string;
  phase: "idle" | "loading" | "ready" | "exited" | "error" | "unsupported";
  rows: ProcessResourceInUseInfo[];
}
interface ProcessSocketsInUseState {
  message?: string;
  phase: "idle" | "loading" | "ready" | "exited" | "error" | "unsupported";
  rows: ProcessSocketInUseInfo[];
}
interface ProcessModulesState {
  message?: string;
  phase: "idle" | "loading" | "ready" | "exited" | "error" | "unsupported";
  rows: ProcessModuleInfo[];
}
interface ProcessTreeNode {
  depth: number;
  process: ProcessInfo;
}
const processesToolClassName = [
  "flex h-full min-h-0 w-full flex-col",
  "overflow-hidden bg-white text-[#20242d]",
].join(" ");
const processesContentClassName =
  "flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden";
const emptyWorkspaceClassName = [
  "grid content-center justify-items-center w-full h-full gap-[10px]",
  "min-h-0 bg-white text-[#667085]",
  "[&_h2]:m-0 [&_h2]:text-[#303642] [&_h2]:text-[18px] [&_h2]:tracking-[0]",
  "[&_p]:m-0 [&_p]:max-w-[360px] [&_p]:text-center [&_p]:leading-[1.45]",
].join(" ");
const processTableClassName = [
  "grid min-h-0 min-w-0 flex-1 overflow-auto leading-[1.6]",
  "[grid-template-columns:minmax(72px,96px)_minmax(72px,96px)_minmax(180px,1fr)_minmax(104px,132px)]",
  "auto-rows-[2rem] bg-white",
].join(" ");
const processTreeTableClassName = [
  "grid min-h-0 min-w-0 flex-1 overflow-auto leading-[1.6]",
  "[grid-template-columns:minmax(240px,1fr)_minmax(72px,96px)_minmax(72px,96px)_minmax(104px,132px)]",
  "auto-rows-[2rem] bg-white",
].join(" ");
const processResourceTableClassName = [
  "grid min-h-0 min-w-0 flex-1 overflow-auto leading-[1.6]",
  "[grid-template-columns:minmax(180px,1fr)_minmax(136px,168px)_minmax(96px,120px)_minmax(120px,168px)]",
  "auto-rows-[2rem] bg-white",
].join(" ");
const processSocketTableClassName = [
  "grid min-h-0 min-w-0 flex-1 overflow-auto leading-[1.6]",
  "[grid-template-columns:minmax(96px,120px)_minmax(180px,1fr)_minmax(180px,1fr)_minmax(96px,120px)]",
  "auto-rows-[2rem] bg-white",
].join(" ");
const processSocketTableEmptyClassName = [
  "grid min-h-0 min-w-0 flex-1 overflow-auto leading-[1.6]",
  "[grid-template-columns:minmax(96px,120px)_minmax(180px,1fr)_minmax(180px,1fr)_minmax(96px,120px)]",
  "[grid-template-rows:2rem_minmax(0,1fr)] bg-white",
].join(" ");
const processModuleTableClassName = [
  "grid min-h-0 min-w-0 flex-1 overflow-auto leading-[1.6]",
  "[grid-template-columns:minmax(180px,1fr)_minmax(120px,148px)_minmax(136px,168px)_minmax(96px,120px)_minmax(240px,2fr)]",
  "auto-rows-[2rem] bg-white",
].join(" ");
const processHeadClassName = [
  "sticky top-0 z-[1] flex h-[2rem] box-border items-center",
  "border-b border-b-[#d8dde7] bg-[#f6f8fb] px-[8px]",
  "font-700 text-[#667085]",
].join(" ");
const processRowClassName = [
  "grid [grid-column:1/-1] [grid-template-columns:subgrid]",
  "h-[2rem] min-h-[2rem] box-border border-0 border-b border-b-[#eef1f5]",
  "cursor-default bg-white hover:bg-[#f7f9fc]",
].join(" ");
const processCellClassName = [
  "flex min-w-0 items-center overflow-hidden px-[8px]",
  "text-ellipsis whitespace-nowrap text-[#303642]",
].join(" ");
const processFirstColumnClassName = "pl-[1rem]";
const processPidCellClassName = `${processCellClassName} font-mono text-[#475467]`;
const processMetaCellClassName = `${processCellClassName} text-[#667085]`;
const processNameClassName =
  "min-w-0 overflow-hidden text-ellipsis whitespace-nowrap";
const processSocketEmptyCellClassName = [
  "col-start-1 col-end-[-1] flex min-h-0 min-w-0 flex-col",
  "items-center justify-center gap-1 px-[1rem] py-[0.5rem] text-center",
  "text-[#303642]",
].join(" ");
const processesFooterClassName = [
  "flex h-[2rem] min-h-[2rem] items-center justify-end border-t border-t-[#d8dde7]",
  "bg-[#fbfcfe] px-[8px] leading-[1.6] text-[#667085]",
].join(" ");
const processDetailScrollClassName = "min-h-0 flex-1 overflow-auto";
const processDetailBodyClassName =
  "grid min-w-0 content-start gap-[14px] px-[18px] py-[16px]";
const processDetailNoteClassName = "text-[13px] text-[#667085]";
const processDetailFooterClassName = [
  "flex h-[2rem] min-h-[2rem] items-center justify-end border-t border-t-[#d8dde7]",
  "bg-[#fbfcfe] px-[8px] leading-[1.6] text-[#667085]",
].join(" ");
const processDetailActionsClassName =
  "flex min-w-0 flex-wrap items-center justify-start gap-[0.5rem]";
const processKillConfirmClassName = [
  "flex min-w-0 flex-wrap items-center gap-[0.5rem] rounded-[6px]",
  "border border-[var(--rieul-danger-border)] bg-[var(--rieul-danger-soft)]",
  "px-[0.75rem] py-[0.5rem]",
].join(" ");
const processKillMessageClassName =
  "mr-auto text-[1rem] text-[var(--rieul-danger)]";
const processKillErrorClassName = "text-[1rem] text-[var(--rieul-danger)]";
const processResourceDetailPanelClassName = [
  "relative max-h-[40%] min-h-[9rem] overflow-auto border-t border-t-[#d8dde7]",
  "bg-[#fbfcfe] px-[18px] py-[16px] pr-[3rem]",
].join(" ");
const processResourceDetailCloseButtonClassName = [
  "absolute right-[0.75rem] top-[0.75rem]",
  "grid h-[1.6rem] w-[1.6rem] place-items-center rounded-[0.25rem]",
  "border border-transparent bg-transparent p-0 text-[#667085]",
  "cursor-pointer [font-family:inherit]",
  "hover:bg-[#eef3fb] hover:text-[#344054]",
].join(" ");
export function ProcessesTool() {
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
  const selectedPid = createMemo(() => tab()?.processDetailPid);
  const selectedPage = createMemo(() =>
    selectedPid() === undefined ? undefined : (tab()?.processPage ?? "detail"),
  );
  const processDetailSupported = createMemo(
    () =>
      daemonInfo().phase === "ready" &&
      readyDaemonInfo()!.supportedProcIds.includes(
        ProcId.SubscribeProcessDetail,
      ),
  );
  const killProcessSupported = createMemo(
    () =>
      daemonInfo().phase === "ready" &&
      readyDaemonInfo()!.supportedProcIds.includes(ProcId.KillProcess),
  );
  const processResourcesInUseSupported = createMemo(
    () =>
      daemonInfo().phase === "ready" &&
      readyDaemonInfo()!.supportedProcIds.includes(
        ProcId.SubscribeProcessResourcesInUse,
      ),
  );
  const processSocketsInUseSupported = createMemo(
    () =>
      daemonInfo().phase === "ready" &&
      readyDaemonInfo()!.supportedProcIds.includes(
        ProcId.SubscribeProcessSocketsInUse,
      ),
  );
  const processModulesSupported = createMemo(
    () =>
      daemonInfo().phase === "ready" &&
      readyDaemonInfo()!.supportedProcIds.includes(
        ProcId.SubscribeProcessModules,
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
          <section class={processesToolClassName}>
            <ProcessesBreadcrumb
              selectedPage={selectedPage()}
              selectedPid={selectedPid()}
              onOpenRoot={() => tabState().setProcessDetailPid(undefined)}
              onOpenProcess={() => tabState().setProcessPage("detail")}
            />
            {selectedPid() === undefined ? (
              <ProcessListView
                onOpenProcess={(process) =>
                  paneState().addProcessesTab({
                    processDetailPid: process.pid,
                    title: process.name || `PID ${process.pid}`,
                  })
                }
              />
            ) : selectedPage() === "heldResources" ? (
              <ProcessResourcesInUseView
                daemonInfoPhase={daemonInfo().phase}
                machineId={machine()!.id}
                onOpenPathResource={(resource) => {
                  const tabId = paneState().addFilesTab();
                  writeProcessResourceFilesNavigationState(
                    machine()!.id,
                    tabId,
                    resource,
                  );
                }}
                pid={selectedPid()!}
                rpcSession={rpcSession()}
                supported={processResourcesInUseSupported()}
              />
            ) : selectedPage() === "heldSockets" ? (
              <ProcessSocketsInUseView
                daemonInfoPhase={daemonInfo().phase}
                machineId={machine()!.id}
                pid={selectedPid()!}
                rpcSession={rpcSession()}
                supported={processSocketsInUseSupported()}
              />
            ) : selectedPage() === "modules" ? (
              <ProcessModulesView
                daemonInfoPhase={daemonInfo().phase}
                machineId={machine()!.id}
                onOpenModulePath={(module) => {
                  const tabId = paneState().addFilesTab();
                  writeProcessModuleFilesNavigationState(
                    machine()!.id,
                    tabId,
                    module,
                  );
                }}
                pid={selectedPid()!}
                rpcSession={rpcSession()}
                supported={processModulesSupported()}
              />
            ) : selectedPage() === "children" ? (
              <ProcessChildrenView
                onOpenProcess={(process) =>
                  paneState().addProcessesTab({
                    processDetailPid: process.pid,
                    title: process.name || `PID ${process.pid}`,
                  })
                }
                pid={selectedPid()!}
              />
            ) : (
              <ProcessDetailView
                daemonInfoPhase={daemonInfo().phase}
                machineId={machine()!.id}
                onShowChildren={() =>
                  paneState().addProcessesTab({
                    processDetailPid: selectedPid(),
                    processPage: "children",
                    title: tab()?.title ?? `PID ${selectedPid()}`,
                  })
                }
                onShowResourcesInUse={() =>
                  paneState().addProcessesTab({
                    processDetailPid: selectedPid(),
                    processPage: "heldResources",
                    title: tab()?.title ?? `PID ${selectedPid()}`,
                  })
                }
                onShowSocketsInUse={() =>
                  paneState().addProcessesTab({
                    processDetailPid: selectedPid(),
                    processPage: "heldSockets",
                    title: tab()?.title ?? `PID ${selectedPid()}`,
                  })
                }
                onShowModules={() =>
                  paneState().addProcessesTab({
                    processDetailPid: selectedPid(),
                    processPage: "modules",
                    title: tab()?.title ?? `PID ${selectedPid()}`,
                  })
                }
                pid={selectedPid()!}
                rpcSession={rpcSession()}
                modulesSupported={processModulesSupported()}
                killSupported={killProcessSupported()}
                resourcesSupported={processResourcesInUseSupported()}
                socketsSupported={processSocketsInUseSupported()}
                supported={processDetailSupported()}
              />
            )}
          </section>
        );
      })()}
    </>
  );
}
interface ProcessesBreadcrumbProps {
  selectedPage?: WorkbenchProcessPage;
  selectedPid?: number;
  onOpenProcess: () => void;
  onOpenRoot: () => void;
}
function ProcessesBreadcrumb(props: ProcessesBreadcrumbProps) {
  return (
    <>
      {(() => {
        const items: BreadcrumbItem[] = [
          {
            label: "Processes",
            onClick:
              props.selectedPid === undefined ? undefined : props.onOpenRoot,
          },
        ];
        if (props.selectedPid === undefined) {
          items.push({
            label: "Overview",
          });
        } else {
          items.push({
            label: `PID ${props.selectedPid}`,
            onClick:
              props.selectedPage === "children" ||
              props.selectedPage === "heldResources" ||
              props.selectedPage === "heldSockets" ||
              props.selectedPage === "modules"
                ? props.onOpenProcess
                : undefined,
          });
          if (props.selectedPage === "children") {
            items.push({
              label: "Process tree",
            });
          } else if (props.selectedPage === "heldResources") {
            items.push({
              label: "Resources in use",
            });
          } else if (props.selectedPage === "heldSockets") {
            items.push({
              label: "Sockets in use",
            });
          } else if (props.selectedPage === "modules") {
            items.push({
              label: "Modules",
            });
          }
        }
        return (
          <Breadcrumb
            ariaLabel="Process location"
            className="flex-[0_0_auto] border-b border-b-[#d8dde7] bg-[#fbfcfe] px-[0.5rem]"
            items={items.map((item, index) => ({
              ...item,
              muted: index === items.length - 1,
            }))}
          />
        );
      })()}
    </>
  );
}
interface ProcessListViewProps {
  onOpenProcess: (process: ProcessInfo) => void;
}
function ProcessListView(props: ProcessListViewProps) {
  const _model = useBunja(processesBunja);
  const state = useAtomValue(() => _model().stateAtom);
  return (
    <>
      {(() => {
        if (state().phase === "loading") {
          return (
            <section class={emptyWorkspaceClassName}>
              <Loader2 size={24} className="animate-spin" />
              <h2>Loading processes</h2>
            </section>
          );
        }
        if (state().phase === "unsupported" || state().phase === "error") {
          return (
            <section class={emptyWorkspaceClassName}>
              <Activity size={28} />
              <h2>
                {state().phase === "unsupported"
                  ? "Processes unavailable"
                  : "Failed to load processes"}
              </h2>
              {state().message ? <p>{state().message}</p> : null}
            </section>
          );
        }
        return (
          <div class={processesContentClassName}>
            <div
              class={processTableClassName}
              role="grid"
              aria-label="Processes"
            >
              <div
                class={`${processHeadClassName} ${processFirstColumnClassName}`}
                role="columnheader"
              >
                PID
              </div>
              <div class={processHeadClassName} role="columnheader">
                PPID
              </div>
              <div class={processHeadClassName} role="columnheader">
                Name
              </div>
              <div class={processHeadClassName} role="columnheader">
                Status
              </div>
              {state().rows.length === 0 ? (
                <div class={`${processCellClassName} [grid-column:1/-1]`}>
                  No processes
                </div>
              ) : (
                state().rows.map((process) => (
                  <div
                    class={`${processRowClassName} !cursor-pointer`}
                    role="row"
                    onDblClick={() => props.onOpenProcess(process)}
                  >
                    <span
                      class={`${processPidCellClassName} ${processFirstColumnClassName}`}
                    >
                      {process.pid}
                    </span>
                    <span class={processPidCellClassName}>
                      {process.ppid ?? ""}
                    </span>
                    <span class={processCellClassName}>
                      <span class={processNameClassName}>
                        {process.name || "(unnamed)"}
                      </span>
                    </span>
                    <span class={processMetaCellClassName}>
                      {processStatusLabel(process.status)}
                    </span>
                  </div>
                ))
              )}
            </div>
            <footer class={processesFooterClassName}>
              {state().rows.length}{" "}
              {state().rows.length === 1 ? "process" : "processes"}
            </footer>
          </div>
        );
      })()}
    </>
  );
}
interface ProcessChildrenViewProps {
  onOpenProcess: (process: ProcessInfo) => void;
  pid: number;
}
function ProcessChildrenView(props: ProcessChildrenViewProps) {
  const _model2 = useBunja(processesBunja);
  const state = useAtomValue(() => _model2().stateAtom);
  const tree = createMemo(() => buildProcessTreeNodes(state().rows, props.pid));
  return (
    <>
      {(() => {
        if (state().phase === "loading") {
          return (
            <section class={emptyWorkspaceClassName}>
              <Loader2 size={24} className="animate-spin" />
              <h2>Loading child processes</h2>
            </section>
          );
        }
        if (state().phase === "unsupported" || state().phase === "error") {
          return (
            <section class={emptyWorkspaceClassName}>
              <Activity size={28} />
              <h2>
                {state().phase === "unsupported"
                  ? "Process tree unavailable"
                  : "Failed to load process tree"}
              </h2>
              {state().message ? <p>{state().message}</p> : null}
            </section>
          );
        }
        return (
          <div class={processesContentClassName}>
            <div
              class={processTreeTableClassName}
              role="grid"
              aria-label="Child process tree"
            >
              <div
                class={`${processHeadClassName} ${processFirstColumnClassName}`}
                role="columnheader"
              >
                Name
              </div>
              <div class={processHeadClassName} role="columnheader">
                PID
              </div>
              <div class={processHeadClassName} role="columnheader">
                PPID
              </div>
              <div class={processHeadClassName} role="columnheader">
                Status
              </div>
              {tree().length === 0 ? (
                <div class={`${processCellClassName} [grid-column:1/-1]`}>
                  No child processes
                </div>
              ) : (
                tree().map(({ depth, process }) => (
                  <div
                    class={`${processRowClassName} !cursor-pointer`}
                    role="row"
                    onDblClick={() => props.onOpenProcess(process)}
                  >
                    <span
                      class={processCellClassName}
                      style={{
                        "padding-left": `calc(1rem + ${depth * 1.25}rem)`,
                      }}
                    >
                      <span class={processNameClassName}>
                        {process.name || "(unnamed)"}
                      </span>
                    </span>
                    <span class={processPidCellClassName}>{process.pid}</span>
                    <span class={processPidCellClassName}>
                      {process.ppid ?? ""}
                    </span>
                    <span class={processMetaCellClassName}>
                      {processStatusLabel(process.status)}
                    </span>
                  </div>
                ))
              )}
            </div>
            <footer class={processesFooterClassName}>
              {tree().length} {tree().length === 1 ? "process" : "processes"}
            </footer>
          </div>
        );
      })()}
    </>
  );
}
interface ProcessDetailViewProps {
  daemonInfoPhase: string;
  killSupported: boolean;
  machineId: string;
  onShowChildren: () => void;
  onShowModules: () => void;
  onShowResourcesInUse: () => void;
  onShowSocketsInUse: () => void;
  pid: number;
  rpcSession: ProcessesRpcSession;
  modulesSupported: boolean;
  resourcesSupported: boolean;
  socketsSupported: boolean;
  supported: boolean;
}
function ProcessDetailView(props: ProcessDetailViewProps) {
  const [state, setState] = createSignal<ProcessDetailState>({
    phase: "idle",
  });
  const [killPhase, setKillPhase] = createSignal<
    "idle" | "confirming" | "killing" | "error"
  >("idle");
  const [killError, setKillError] = createSignal<string>();
  async function killSelectedProcess() {
    setKillPhase("killing");
    setKillError(undefined);
    try {
      await killProcess(await props.rpcSession.webTransport(), {
        pid: props.pid,
      });
    } catch (err) {
      setKillError(err instanceof Error ? err.message : String(err));
      setKillPhase("error");
    }
  }
  createEffect(
    createMemo(
      () =>
        [
          props.daemonInfoPhase,
          props.machineId,
          props.pid,
          props.rpcSession,
          props.supported,
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
      snapshotPid,
      snapshotRpcSession,
      snapshotSupported,
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
          message: "This daemon does not support process detail subscriptions.",
          phase: "unsupported",
        });
        return;
      }
      let cancelled = false;
      let iterator: AsyncGenerator<ProcessDetailEvent> | undefined;
      setState({
        phase: "loading",
      });
      void (async () => {
        try {
          const transport = await snapshotRpcSession.webTransport();
          if (cancelled) return;
          iterator = subscribeProcessDetail(transport, {
            pid: snapshotPid,
          });
          for await (const event of iterator) {
            if (cancelled) return;
            if (event.type === "exited") {
              setState((current) => ({
                ...current,
                phase: "exited",
              }));
              setKillPhase("idle");
              return;
            }
            setState((current) => applyProcessDetailEvent(current, event));
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
  createEffect(
    createMemo(() => [props.machineId, props.pid] as const, {
      equals: (a, b) =>
        a.length === b.length &&
        a.every((value, index) => Object.is(value, b[index])),
    }),
    () => {
      setKillPhase("idle");
      setKillError(undefined);
    },
  );
  return (
    <>
      {(() => {
        if (state().phase === "loading" || props.daemonInfoPhase !== "ready") {
          return (
            <section class={emptyWorkspaceClassName}>
              <Loader2 size={24} className="animate-spin" />
              <h2>Loading process</h2>
            </section>
          );
        }
        if (state().phase === "unsupported" || state().phase === "error") {
          return (
            <section class={emptyWorkspaceClassName}>
              <Activity size={28} />
              <h2>
                {state().phase === "unsupported"
                  ? "Process detail unavailable"
                  : "Failed to load process"}
              </h2>
              {state().message ? <p>{state().message}</p> : null}
            </section>
          );
        }
        if (!state().detail) {
          return (
            <section class={emptyWorkspaceClassName}>
              <Activity size={28} />
              <h2>No process detail</h2>
            </section>
          );
        }
        return (
          <div class={processesContentClassName}>
            <ProcessDetailSummary
              detail={state().detail!}
              exited={state().phase === "exited"}
              killError={killError()}
              killPhase={killPhase()}
              killSupported={props.killSupported}
              onCancelKill={() => setKillPhase("idle")}
              onConfirmKill={killSelectedProcess}
              onRequestKill={() => setKillPhase("confirming")}
              onShowChildren={props.onShowChildren}
              onShowModules={props.onShowModules}
              onShowResourcesInUse={props.onShowResourcesInUse}
              onShowSocketsInUse={props.onShowSocketsInUse}
              modulesSupported={props.modulesSupported}
              resourcesSupported={props.resourcesSupported}
              socketsSupported={props.socketsSupported}
            />
            <footer class={processDetailFooterClassName}>
              {state().phase === "exited"
                ? "Process exited"
                : `PID ${state().detail!.info.pid}`}
            </footer>
          </div>
        );
      })()}
    </>
  );
}
interface ProcessDetailSummaryProps {
  detail: ProcessDetail;
  exited: boolean;
  killError?: string;
  killPhase: "idle" | "confirming" | "killing" | "error";
  killSupported: boolean;
  onCancelKill: () => void;
  onConfirmKill: () => void;
  onRequestKill: () => void;
  onShowChildren: () => void;
  onShowModules: () => void;
  onShowResourcesInUse: () => void;
  onShowSocketsInUse: () => void;
  modulesSupported: boolean;
  resourcesSupported: boolean;
  socketsSupported: boolean;
}
function ProcessDetailSummary(props: ProcessDetailSummaryProps) {
  const now = useBunja(nowBunja);
  const nowMs = useAtomValue(() => now().nowEverySecondAtom);
  const _value = createMemo(() => props.detail);
  return (
    <>
      {(() => {
        return (
          <div class={processDetailScrollClassName}>
            <div class={processDetailBodyClassName}>
              <PropertyList>
                <ProcessDetailItem
                  label="Name"
                  value={_value().info.name || "(unnamed)"}
                />
                <ProcessDetailItem
                  label="PID"
                  value={String(_value().info.pid)}
                />
                <ProcessDetailItem
                  label="PPID"
                  value={
                    _value().info.ppid === undefined
                      ? "None"
                      : String(_value().info.ppid)
                  }
                />
                <ProcessDetailItem
                  label="Status"
                  value={processStatusLabel(_value().info.status)}
                />
                <ProcessDetailItem
                  label="Started"
                  note={`Uptime ${formatProcessUptime(_value().metadata.startTimeUnix, nowMs())}`}
                  value={formatUnixTimestamp(_value().metadata.startTimeUnix)}
                />
                <ProcessDetailItem
                  label="Command"
                  value={
                    _value().metadata.command.length === 0
                      ? "Unknown"
                      : _value().metadata.command.join(" ")
                  }
                />
                <ProcessDetailItem
                  label="Executable"
                  value={_value().metadata.executablePath ?? "Unknown"}
                />
                <ProcessDetailItem
                  label="CWD"
                  value={_value().metadata.cwd ?? "Unknown"}
                />
              </PropertyList>
              <div class={processDetailActionsClassName}>
                <Button
                  onClick={props.onShowChildren}
                  title="Show process tree rooted at this process"
                >
                  <ExternalLink size={14} />
                  Process tree
                </Button>
                <Button
                  disabled={!props.resourcesSupported}
                  onClick={props.onShowResourcesInUse}
                  title={
                    props.resourcesSupported
                      ? "Show resources currently in use by this process"
                      : "This daemon does not support resource usage subscriptions"
                  }
                >
                  <ExternalLink size={14} />
                  Resources in use
                </Button>
                <Button
                  disabled={!props.socketsSupported}
                  onClick={props.onShowSocketsInUse}
                  title={
                    props.socketsSupported
                      ? "Show sockets currently in use by this process"
                      : "This daemon does not support socket usage subscriptions"
                  }
                >
                  <ExternalLink size={14} />
                  Sockets in use
                </Button>
                <Button
                  disabled={!props.modulesSupported}
                  onClick={props.onShowModules}
                  title={
                    props.modulesSupported
                      ? "Show executable images and dynamic libraries loaded by this process"
                      : "This daemon does not support module subscriptions"
                  }
                >
                  <ExternalLink size={14} />
                  Modules
                </Button>
                <Button
                  disabled={
                    !props.killSupported ||
                    props.exited ||
                    props.killPhase === "killing"
                  }
                  onClick={props.onRequestKill}
                  title={
                    props.killSupported
                      ? "Forcefully terminate this process"
                      : "This daemon does not support process termination"
                  }
                  tone="danger"
                  variant="outline"
                >
                  <CircleStop size={14} />
                  Kill process
                </Button>
              </div>
              {props.killPhase === "confirming" ||
              props.killPhase === "killing" ? (
                <div class={processKillConfirmClassName}>
                  <span class={processKillMessageClassName}>
                    Forcefully terminate PID {_value().info.pid}?
                  </span>
                  <Button
                    disabled={props.killPhase === "killing"}
                    onClick={props.onCancelKill}
                    size="sm"
                    variant="ghost"
                  >
                    Cancel
                  </Button>
                  <Button
                    disabled={props.killPhase === "killing"}
                    onClick={props.onConfirmKill}
                    size="sm"
                    tone="danger"
                    variant="solid"
                  >
                    <CircleStop size={14} />
                    {props.killPhase === "killing" ? "Killing" : "Kill process"}
                  </Button>
                </div>
              ) : props.killPhase === "error" ? (
                <span class={processKillErrorClassName}>{props.killError}</span>
              ) : null}
              <ProcessResourceUsageTable usage={_value().usage} />
            </div>
          </div>
        );
      })()}
    </>
  );
}
interface ProcessResourcesInUseViewProps {
  daemonInfoPhase: string;
  machineId: string;
  onOpenPathResource: (resource: ProcessResourceInUseInfo) => void;
  pid: number;
  rpcSession: ProcessesRpcSession;
  supported: boolean;
}
function ProcessResourcesInUseView(props: ProcessResourcesInUseViewProps) {
  const rowsRef = {
    current: [] as ProcessResourceInUseInfo[],
  };
  const [state, setState] = createSignal<ProcessResourcesInUseState>({
    phase: "idle",
    rows: [],
  });
  const [selectedResourceId, setSelectedResourceId] = createSignal<string>();
  const selectedResource = createMemo(() =>
    selectedResourceId() === undefined
      ? undefined
      : state().rows.find(
          (resource) => resource.resourceId === selectedResourceId(),
        ),
  );
  createEffect(
    createMemo(
      () =>
        [
          props.daemonInfoPhase,
          props.machineId,
          props.pid,
          props.rpcSession,
          props.supported,
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
      snapshotPid,
      snapshotRpcSession,
      snapshotSupported,
    ]) => {
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
          message:
            "This daemon does not support process resource usage subscriptions.",
          phase: "unsupported",
          rows: [],
        });
        return;
      }
      let cancelled = false;
      let iterator: AsyncGenerator<ProcessResourcesInUseTableEvent> | undefined;
      setState((current) => ({
        ...current,
        phase: "loading",
      }));
      void (async () => {
        try {
          const transport = await snapshotRpcSession.webTransport();
          if (cancelled) return;
          iterator = subscribeProcessResourcesInUse(transport, {
            pid: snapshotPid,
          });
          for await (const event of iterator) {
            if (cancelled) return;
            if (event.type === "exited") {
              setState((current) => ({
                ...current,
                phase: "exited",
              }));
              return;
            }
            const rows = applyProcessResourcesInUseEvent(
              rowsRef.current,
              event,
            );
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
  createEffect(
    createMemo(() => [selectedResourceId(), state().rows] as const, {
      equals: (a, b) =>
        a.length === b.length &&
        a.every((value, index) => Object.is(value, b[index])),
    }),
    ([snapshotSelectedResourceId, snapshotStateRows]) => {
      if (snapshotSelectedResourceId === undefined) return;
      if (
        snapshotStateRows.some(
          (resource) => resource.resourceId === snapshotSelectedResourceId,
        )
      ) {
        return;
      }
      setSelectedResourceId(undefined);
    },
  );
  return (
    <>
      {(() => {
        if (state().phase === "loading" || props.daemonInfoPhase !== "ready") {
          return (
            <section class={emptyWorkspaceClassName}>
              <Loader2 size={24} className="animate-spin" />
              <h2>Loading resources in use</h2>
            </section>
          );
        }
        if (state().phase === "unsupported" || state().phase === "error") {
          return (
            <section class={emptyWorkspaceClassName}>
              <Activity size={28} />
              <h2>
                {state().phase === "unsupported"
                  ? "Resources in use unavailable"
                  : "Failed to load resources in use"}
              </h2>
              {state().message ? <p>{state().message}</p> : null}
            </section>
          );
        }
        return (
          <div class={processesContentClassName}>
            <div
              class={processResourceTableClassName}
              role="grid"
              aria-label="Process resources in use"
            >
              <div
                class={`${processHeadClassName} ${processFirstColumnClassName}`}
                role="columnheader"
              >
                Name
              </div>
              <div class={processHeadClassName} role="columnheader">
                Kind
              </div>
              <div class={processHeadClassName} role="columnheader">
                Access
              </div>
              <div class={processHeadClassName} role="columnheader">
                ID
              </div>
              {state().rows.length === 0 ? (
                <div class={`${processCellClassName} [grid-column:1/-1]`}>
                  No resources in use
                </div>
              ) : (
                state().rows.map((resource) => {
                  const canOpen = isPathProcessResource(resource);
                  const selected = resource.resourceId === selectedResourceId();
                  return (
                    <div
                      class={`${processRowClassName} ${canOpen ? "!cursor-pointer" : ""} ${selected ? "!bg-[#eef4ff] hover:!bg-[#e7f0ff]" : ""}`}
                      role="row"
                      title={resource.name ?? resource.resourceId}
                      onClick={() =>
                        setSelectedResourceId((current) =>
                          current === resource.resourceId
                            ? undefined
                            : resource.resourceId,
                        )
                      }
                      onDblClick={
                        canOpen
                          ? () => props.onOpenPathResource(resource)
                          : undefined
                      }
                    >
                      <span
                        class={`${processCellClassName} ${processFirstColumnClassName}`}
                      >
                        <span class={processNameClassName}>
                          {resource.name ?? resource.resourceId}
                        </span>
                      </span>
                      <span class={processMetaCellClassName}>
                        {processResourceInUseKindLabel(resource.kind)}
                      </span>
                      <span class={processMetaCellClassName}>
                        {processResourceInUseAccessLabel(resource)}
                      </span>
                      <span class={processMetaCellClassName}>
                        {resource.resourceId}
                      </span>
                    </div>
                  );
                })
              )}
            </div>
            {selectedResource() ? (
              <ProcessResourceInUseDetail
                resource={selectedResource()!}
                onClose={() => setSelectedResourceId(undefined)}
              />
            ) : null}
            <footer class={processesFooterClassName}>
              {state().phase === "exited"
                ? "Process exited"
                : `${state().rows.length} ${state().rows.length === 1 ? "resource" : "resources"}`}
            </footer>
          </div>
        );
      })()}
    </>
  );
}
interface ProcessSocketsInUseViewProps {
  daemonInfoPhase: string;
  machineId: string;
  pid: number;
  rpcSession: ProcessesRpcSession;
  supported: boolean;
}
function ProcessSocketsInUseView(props: ProcessSocketsInUseViewProps) {
  const rowsRef = {
    current: [] as ProcessSocketInUseInfo[],
  };
  const [state, setState] = createSignal<ProcessSocketsInUseState>({
    phase: "idle",
    rows: [],
  });
  createEffect(
    createMemo(
      () =>
        [
          props.daemonInfoPhase,
          props.machineId,
          props.pid,
          props.rpcSession,
          props.supported,
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
      snapshotPid,
      snapshotRpcSession,
      snapshotSupported,
    ]) => {
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
          message:
            "This daemon does not support process socket usage subscriptions.",
          phase: "unsupported",
          rows: [],
        });
        return;
      }
      let cancelled = false;
      let iterator: AsyncGenerator<ProcessSocketsInUseTableEvent> | undefined;
      setState((current) => ({
        ...current,
        phase: "loading",
      }));
      void (async () => {
        try {
          const transport = await snapshotRpcSession.webTransport();
          if (cancelled) return;
          iterator = subscribeProcessSocketsInUse(transport, {
            pid: snapshotPid,
          });
          for await (const event of iterator) {
            if (cancelled) return;
            if (event.type === "exited") {
              setState((current) => ({
                ...current,
                phase: "exited",
              }));
              return;
            }
            const rows = applyProcessSocketsInUseEvent(rowsRef.current, event);
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
              <h2>Loading sockets in use</h2>
            </section>
          );
        }
        if (state().phase === "unsupported" || state().phase === "error") {
          return (
            <section class={emptyWorkspaceClassName}>
              <Activity size={28} />
              <h2>
                {state().phase === "unsupported"
                  ? "Sockets in use unavailable"
                  : "Failed to load sockets in use"}
              </h2>
              {state().message ? <p>{state().message}</p> : null}
            </section>
          );
        }
        return (
          <div class={processesContentClassName}>
            <div
              class={
                state().rows.length === 0
                  ? processSocketTableEmptyClassName
                  : processSocketTableClassName
              }
              role="grid"
              aria-label="Process sockets in use"
            >
              <div
                class={`${processHeadClassName} ${processFirstColumnClassName}`}
                role="columnheader"
              >
                Kind
              </div>
              <div class={processHeadClassName} role="columnheader">
                Local
              </div>
              <div class={processHeadClassName} role="columnheader">
                Remote
              </div>
              <div class={processHeadClassName} role="columnheader">
                Listening
              </div>
              {state().rows.length === 0 ? (
                <div class={processSocketEmptyCellClassName}>
                  <span>No sockets in use by PID {props.pid}</span>
                  <span class="text-slate-500">
                    Multi-process apps may keep sockets in a separate network
                    service process.
                  </span>
                </div>
              ) : (
                state().rows.map((socket) => (
                  <div
                    class={processRowClassName}
                    role="row"
                    title={socket.socketId}
                  >
                    <span
                      class={`${processMetaCellClassName} ${processFirstColumnClassName}`}
                    >
                      {processSocketInUseKindLabel(socket.kind)}
                    </span>
                    <span class={processCellClassName}>
                      <span class={processNameClassName}>
                        {socketEndpointLabel(socket.localEndpoint)}
                      </span>
                    </span>
                    <span class={processCellClassName}>
                      <span class={processNameClassName}>
                        {socketEndpointLabel(socket.remoteEndpoint)}
                      </span>
                    </span>
                    <span class={processMetaCellClassName}>
                      {socketListeningLabel(socket.listening)}
                    </span>
                  </div>
                ))
              )}
            </div>
            <footer class={processesFooterClassName}>
              {state().phase === "exited"
                ? "Process exited"
                : `${state().rows.length} ${state().rows.length === 1 ? "socket" : "sockets"}`}
            </footer>
          </div>
        );
      })()}
    </>
  );
}
interface ProcessModulesViewProps {
  daemonInfoPhase: string;
  machineId: string;
  onOpenModulePath: (module: ProcessModuleInfo) => void;
  pid: number;
  rpcSession: ProcessesRpcSession;
  supported: boolean;
}
function ProcessModulesView(props: ProcessModulesViewProps) {
  const rowsRef = {
    current: [] as ProcessModuleInfo[],
  };
  const [state, setState] = createSignal<ProcessModulesState>({
    phase: "idle",
    rows: [],
  });
  createEffect(
    createMemo(
      () =>
        [
          props.daemonInfoPhase,
          props.machineId,
          props.pid,
          props.rpcSession,
          props.supported,
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
      snapshotPid,
      snapshotRpcSession,
      snapshotSupported,
    ]) => {
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
          message: "This daemon does not support process module subscriptions.",
          phase: "unsupported",
          rows: [],
        });
        return;
      }
      let cancelled = false;
      let iterator: AsyncGenerator<ProcessModulesTableEvent> | undefined;
      setState((current) => ({
        ...current,
        phase: "loading",
      }));
      void (async () => {
        try {
          const transport = await snapshotRpcSession.webTransport();
          if (cancelled) return;
          iterator = subscribeProcessModules(transport, {
            pid: snapshotPid,
          });
          for await (const event of iterator) {
            if (cancelled) return;
            if (event.type === "exited") {
              setState((current) => ({
                ...current,
                phase: "exited",
              }));
              return;
            }
            const rows = applyProcessModulesEvent(rowsRef.current, event);
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
              <h2>Loading modules</h2>
            </section>
          );
        }
        if (state().phase === "unsupported" || state().phase === "error") {
          return (
            <section class={emptyWorkspaceClassName}>
              <Activity size={28} />
              <h2>
                {state().phase === "unsupported"
                  ? "Modules unavailable"
                  : "Failed to load modules"}
              </h2>
              {state().message ? <p>{state().message}</p> : null}
            </section>
          );
        }
        return (
          <div class={processesContentClassName}>
            <div
              class={processModuleTableClassName}
              role="grid"
              aria-label="Process modules"
            >
              <div
                class={`${processHeadClassName} ${processFirstColumnClassName}`}
                role="columnheader"
              >
                Name
              </div>
              <div class={processHeadClassName} role="columnheader">
                Kind
              </div>
              <div class={processHeadClassName} role="columnheader">
                Base address
              </div>
              <div class={processHeadClassName} role="columnheader">
                Size
              </div>
              <div class={processHeadClassName} role="columnheader">
                Path
              </div>
              {state().rows.length === 0 ? (
                <div class={`${processCellClassName} [grid-column:1/-1]`}>
                  No modules
                </div>
              ) : (
                state().rows.map((module) => {
                  const canOpen =
                    module.path !== undefined && module.path.length > 0;
                  return (
                    <div
                      class={`${processRowClassName} ${canOpen ? "!cursor-pointer" : ""}`}
                      role="row"
                      title={module.path ?? module.name}
                      onDblClick={
                        canOpen
                          ? () => props.onOpenModulePath(module)
                          : undefined
                      }
                    >
                      <span
                        class={`${processCellClassName} ${processFirstColumnClassName}`}
                      >
                        <span class={processNameClassName}>{module.name}</span>
                      </span>
                      <span class={processMetaCellClassName}>
                        {processModuleKindLabel(module.kind)}
                      </span>
                      <span class={processMetaCellClassName}>
                        {module.baseAddress ?? ""}
                      </span>
                      <span class={processMetaCellClassName}>
                        {module.sizeBytes === undefined
                          ? ""
                          : formatBytes(module.sizeBytes)}
                      </span>
                      <span class={processCellClassName}>
                        <span class={processNameClassName}>
                          {module.path ?? ""}
                        </span>
                      </span>
                    </div>
                  );
                })
              )}
            </div>
            <footer class={processesFooterClassName}>
              {state().phase === "exited"
                ? "Process exited"
                : `${state().rows.length} ${state().rows.length === 1 ? "module" : "modules"}`}
            </footer>
          </div>
        );
      })()}
    </>
  );
}
interface ProcessResourceInUseDetailProps {
  onClose: () => void;
  resource: ProcessResourceInUseInfo;
}
function ProcessResourceInUseDetail(props: ProcessResourceInUseDetailProps) {
  return (
    <>
      {(() => {
        return (
          <div class={processResourceDetailPanelClassName}>
            <button
              type="button"
              class={processResourceDetailCloseButtonClassName}
              onClick={props.onClose}
              title="Close resource detail"
            >
              <X size={14} />
            </button>
            <PropertyList>
              <ProcessDetailItem
                label="Name"
                value={props.resource.name ?? "Unknown"}
              />
              <ProcessDetailItem
                label="Kind"
                value={processResourceInUseKindLabel(props.resource.kind)}
              />
              <ProcessDetailItem
                label="Access"
                value={
                  processResourceInUseAccessLabel(props.resource) || "Unknown"
                }
              />
              <ProcessDetailItem
                label="State"
                value={props.resource.deleted ? "Deleted" : "Active"}
              />
              <ProcessDetailItem
                label="Resource ID"
                value={props.resource.resourceId}
              />
            </PropertyList>
          </div>
        );
      })()}
    </>
  );
}
interface ProcessResourceUsageTableProps {
  usage: ProcessDetail["usage"];
}
function ProcessResourceUsageTable(props: ProcessResourceUsageTableProps) {
  return (
    <>
      {(() => {
        return (
          <PropertyList>
            <ProcessDetailItem
              label="CPU"
              note={`Accumulated CPU time ${formatDurationMs(props.usage.accumulatedCpuTimeMs)}`}
              value={formatCpuUsagePercent(props.usage.cpuUsagePercent)}
            />
            <ProcessDetailItem
              label="Memory"
              note={`Virtual ${formatBytes(props.usage.virtualMemoryBytes)}`}
              value={formatBytes(props.usage.memoryBytes)}
            />
            <ProcessDetailItem
              label="IO read"
              note={`Total ${formatBytes(props.usage.ioUsage.totalReadBytes)}`}
              value={`${formatBytes(props.usage.ioUsage.readBytes)}/s`}
            />
            <ProcessDetailItem
              label="IO written"
              note={`Total ${formatBytes(props.usage.ioUsage.totalWrittenBytes)}`}
              value={`${formatBytes(props.usage.ioUsage.writtenBytes)}/s`}
            />
          </PropertyList>
        );
      })()}
    </>
  );
}
interface ProcessDetailItemProps {
  label: string;
  note?: string;
  value: string;
}
function ProcessDetailItem(props: ProcessDetailItemProps) {
  return (
    <>
      {(() => {
        return (
          <PropertyListItem label={props.label}>
            <PropertyValue>{props.value}</PropertyValue>
            {props.note ? (
              <span class={processDetailNoteClassName}>{props.note}</span>
            ) : null}
          </PropertyListItem>
        );
      })()}
    </>
  );
}
function applyProcessDetailEvent(
  current: ProcessDetailState,
  event: ProcessDetailEvent,
): ProcessDetailState {
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
            phase: current.phase === "exited" ? "exited" : "ready",
          }
        : current;
    case "metadataChanged":
      return current.detail
        ? {
            detail: {
              ...current.detail,
              metadata: event.metadata,
            },
            phase: current.phase === "exited" ? "exited" : "ready",
          }
        : current;
    case "usageChanged":
      return current.detail
        ? {
            detail: {
              ...current.detail,
              usage: event.usage,
            },
            phase: current.phase === "exited" ? "exited" : "ready",
          }
        : current;
    case "exited":
      return {
        ...current,
        phase: "exited",
      };
  }
}
function applyProcessResourcesInUseEvent(
  currentRows: ProcessResourceInUseInfo[],
  event: ProcessResourcesInUseTableEvent,
): ProcessResourceInUseInfo[] {
  if (event.type === "snapshot") {
    return sortedProcessResourcesInUse(event.rows);
  }
  if (event.type === "exited") {
    return currentRows;
  }
  const rowsById = new Map(currentRows.map((row) => [row.resourceId, row]));
  for (const resourceId of event.removes) {
    rowsById.delete(resourceId);
  }
  for (const row of event.upserts) {
    rowsById.set(row.resourceId, row);
  }
  return sortedProcessResourcesInUse([...rowsById.values()]);
}
function applyProcessSocketsInUseEvent(
  currentRows: ProcessSocketInUseInfo[],
  event: ProcessSocketsInUseTableEvent,
): ProcessSocketInUseInfo[] {
  if (event.type === "snapshot") {
    return sortedProcessSocketsInUse(event.rows);
  }
  if (event.type === "exited") {
    return currentRows;
  }
  const rowsById = new Map(currentRows.map((row) => [row.socketId, row]));
  for (const socketId of event.removes) {
    rowsById.delete(socketId);
  }
  for (const row of event.upserts) {
    rowsById.set(row.socketId, row);
  }
  return sortedProcessSocketsInUse([...rowsById.values()]);
}
function applyProcessModulesEvent(
  currentRows: ProcessModuleInfo[],
  event: ProcessModulesTableEvent,
): ProcessModuleInfo[] {
  if (event.type === "snapshot") {
    return sortedProcessModules(event.rows);
  }
  if (event.type === "exited") {
    return currentRows;
  }
  const rowsById = new Map(currentRows.map((row) => [row.moduleId, row]));
  for (const moduleId of event.removes) {
    rowsById.delete(moduleId);
  }
  for (const row of event.upserts) {
    rowsById.set(row.moduleId, row);
  }
  return sortedProcessModules([...rowsById.values()]);
}
function buildProcessTreeNodes(
  rows: ProcessInfo[],
  rootPid: number,
): ProcessTreeNode[] {
  const childrenByParent = new Map<number, ProcessInfo[]>();
  for (const row of rows) {
    if (row.ppid === undefined) continue;
    const children = childrenByParent.get(row.ppid);
    if (children === undefined) {
      childrenByParent.set(row.ppid, [row]);
    } else {
      children.push(row);
    }
  }
  for (const children of childrenByParent.values()) {
    children.sort(
      (a, b) => (a.name || "").localeCompare(b.name || "") || a.pid - b.pid,
    );
  }
  const tree: ProcessTreeNode[] = [];
  const visited = new Set<number>();
  const appendChildren = (parentPid: number, depth: number) => {
    const children = childrenByParent.get(parentPid) ?? [];
    for (const process of children) {
      if (visited.has(process.pid)) continue;
      visited.add(process.pid);
      tree.push({
        depth,
        process,
      });
      appendChildren(process.pid, depth + 1);
    }
  };
  appendChildren(rootPid, 0);
  return tree;
}
function sortedProcessResourcesInUse(
  rows: ProcessResourceInUseInfo[],
): ProcessResourceInUseInfo[] {
  return [...rows].sort(
    (a, b) =>
      processResourceInUseKindLabel(a.kind).localeCompare(
        processResourceInUseKindLabel(b.kind),
      ) ||
      (a.name ?? "").localeCompare(b.name ?? "") ||
      a.resourceId.localeCompare(b.resourceId),
  );
}
function sortedProcessSocketsInUse(
  rows: ProcessSocketInUseInfo[],
): ProcessSocketInUseInfo[] {
  return [...rows].sort(
    (a, b) =>
      processSocketInUseKindLabel(a.kind).localeCompare(
        processSocketInUseKindLabel(b.kind),
      ) ||
      socketEndpointLabel(a.localEndpoint).localeCompare(
        socketEndpointLabel(b.localEndpoint),
      ) ||
      socketEndpointLabel(a.remoteEndpoint).localeCompare(
        socketEndpointLabel(b.remoteEndpoint),
      ) ||
      a.socketId.localeCompare(b.socketId),
  );
}
function sortedProcessModules(rows: ProcessModuleInfo[]): ProcessModuleInfo[] {
  return [...rows].sort(
    (a, b) =>
      processModuleKindSortKey(a.kind) - processModuleKindSortKey(b.kind) ||
      a.name.localeCompare(b.name) ||
      (a.path ?? "").localeCompare(b.path ?? "") ||
      a.moduleId.localeCompare(b.moduleId),
  );
}
function isPathProcessResource(resource: ProcessResourceInUseInfo): boolean {
  if (!resource.name || resource.deleted) return false;
  return (
    resource.kind === ProcessResourceInUseKind.File ||
    resource.kind === ProcessResourceInUseKind.Directory
  );
}
function writeProcessResourceFilesNavigationState(
  machineId: string | undefined,
  tabId: string,
  resource: ProcessResourceInUseInfo,
) {
  if (!resource.name) return;
  if (resource.kind === ProcessResourceInUseKind.Directory) {
    writeExplorerDirectoryNavigationState(machineId, tabId, resource.name);
    return;
  }
  if (resource.kind !== ProcessResourceInUseKind.File) return;
  writeExplorerFileNavigationState(
    machineId,
    tabId,
    parentPath(resource.name),
    processPathFileEntry(resource.name),
  );
}
function writeProcessModuleFilesNavigationState(
  machineId: string | undefined,
  tabId: string,
  module: ProcessModuleInfo,
) {
  if (!module.path) return;
  writeExplorerFileNavigationState(
    machineId,
    tabId,
    parentPath(module.path),
    processPathFileEntry(module.path),
  );
}
function processPathFileEntry(path: string): FsEntry {
  return {
    kind: FsEntryKind.File,
    name: pathBaseName(path),
    path,
    readonly: false,
  };
}
function pathBaseName(path: string): string {
  const trimmed = path.replace(/[\\/]+$/g, "");
  return (
    trimmed
      .split(/[\\/]+/)
      .filter(Boolean)
      .pop() ?? path
  );
}
function processStatusLabel(status: ProcessStatus): string {
  switch (status.type) {
    case "idle":
      return "Idle";
    case "run":
      return "Run";
    case "sleep":
      return "Sleep";
    case "stop":
      return "Stop";
    case "zombie":
      return "Zombie";
    case "tracing":
      return "Tracing";
    case "dead":
      return "Dead";
    case "wakekill":
      return "Wakekill";
    case "waking":
      return "Waking";
    case "parked":
      return "Parked";
    case "lockBlocked":
      return "Lock blocked";
    case "uninterruptibleDiskSleep":
      return "Disk sleep";
    case "suspended":
      return "Suspended";
    case "unknown":
      return `Unknown (${status.code})`;
  }
}
function processResourceInUseKindLabel(kind: ProcessResourceInUseKind): string {
  switch (kind) {
    case ProcessResourceInUseKind.File:
      return "File";
    case ProcessResourceInUseKind.Directory:
      return "Directory";
    case ProcessResourceInUseKind.Device:
      return "Device";
    case ProcessResourceInUseKind.NamedPipe:
      return "Named pipe";
    case ProcessResourceInUseKind.AnonymousPipe:
      return "Anonymous pipe";
    case ProcessResourceInUseKind.Other:
      return "Other";
  }
}
function processSocketInUseKindLabel(
  kind: ProcessSocketInUseInfo["kind"],
): string {
  switch (kind.type) {
    case "tcp":
      return "TCP";
    case "udp":
      return "UDP";
    case "unix":
      return "Unix";
    case "raw":
      return "Raw";
    case "unknown":
      return "Unknown";
  }
}
function socketEndpointLabel(endpoint: SocketEndpoint | undefined): string {
  if (!endpoint) return "";
  switch (endpoint.type) {
    case "ip":
      return endpoint.port === undefined
        ? endpoint.address
        : `${endpoint.address}:${endpoint.port}`;
    case "unix":
      return endpoint.path ?? endpoint.name ?? "";
  }
}
function socketListeningLabel(listening: boolean | undefined): string {
  if (listening === undefined) return "Unknown";
  return listening ? "Yes" : "No";
}
function processModuleKindLabel(kind: ProcessModuleKind): string {
  switch (kind) {
    case ProcessModuleKind.Executable:
      return "Executable";
    case ProcessModuleKind.DynamicLibrary:
      return "Dynamic library";
    case ProcessModuleKind.Unknown:
      return "Unknown";
  }
}
function processModuleKindSortKey(kind: ProcessModuleKind): number {
  switch (kind) {
    case ProcessModuleKind.Executable:
      return 0;
    case ProcessModuleKind.DynamicLibrary:
      return 1;
    case ProcessModuleKind.Unknown:
      return 2;
  }
}
function processResourceInUseAccessLabel(
  resource: ProcessResourceInUseInfo,
): string {
  const access = resource.access;
  if (!access) return "";
  const parts = [
    access.read ? "read" : undefined,
    access.write ? "write" : undefined,
    access.execute ? "execute" : undefined,
  ].filter((part): part is string => part !== undefined);
  return parts.join(", ");
}
function formatCpuUsagePercent(value: number): string {
  if (!Number.isFinite(value) || value < 0) return "Unknown";
  return `${value.toFixed(2)}%`;
}
function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return "Unknown";
  const units = ["B", "KB", "MB", "GB", "TB"];
  let value = bytes;
  let unitIndex = 0;
  while (value >= 1024 && unitIndex < units.length - 1) {
    value /= 1024;
    unitIndex += 1;
  }
  const digits = unitIndex === 0 || value >= 10 ? 0 : 1;
  return `${value.toFixed(digits)} ${units[unitIndex]}`;
}
function formatUnixTimestamp(timeUnix: number): string {
  return new Date(timeUnix * 1000).toLocaleString();
}
function formatProcessUptime(startTimeUnix: number, nowMs: number): string {
  const elapsedSeconds = Math.max(0, Math.floor(nowMs / 1000) - startTimeUnix);
  return formatDurationSeconds(elapsedSeconds);
}
function formatDurationMs(durationMs: number): string {
  if (!Number.isFinite(durationMs) || durationMs < 0) return "Unknown";
  if (durationMs < 1000) return `${durationMs} ms`;
  const milliseconds = Math.floor(durationMs % 1000)
    .toString()
    .padStart(3, "0");
  const totalSeconds = Math.floor(durationMs / 1000);
  const seconds = (totalSeconds % 60).toString().padStart(2, "0");
  const minutes = Math.floor(totalSeconds / 60) % 60;
  const hours = Math.floor(totalSeconds / 3600);
  if (hours > 0) {
    return `${hours}h ${minutes.toString().padStart(2, "0")}m ${seconds}.${milliseconds}s`;
  }
  if (minutes > 0) {
    return `${minutes}m ${seconds}.${milliseconds}s`;
  }
  return `${totalSeconds}.${milliseconds}s`;
}
function formatDurationSeconds(totalSeconds: number): string {
  if (!Number.isFinite(totalSeconds) || totalSeconds < 0) return "Unknown";
  const days = Math.floor(totalSeconds / 86_400);
  const hours = Math.floor((totalSeconds % 86_400) / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = Math.floor(totalSeconds % 60);
  const parts: string[] = [];
  if (days > 0) parts.push(`${days}d`);
  if (hours > 0 || parts.length > 0) parts.push(`${hours}h`);
  if (minutes > 0 || parts.length > 0) parts.push(`${minutes}m`);
  parts.push(`${seconds}s`);
  return parts.join(" ");
}
