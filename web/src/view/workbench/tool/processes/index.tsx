import { style, theme } from "../../../../zyzz.config.ts";
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

import { useBunja } from "bunja/solid";
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

export function ProcessesTool() {
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
          <section {...styles.processesTool()}>
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
            className={styles.breadcrumb().class}
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
  const state = () => _model().state();
  return (
    <>
      {(() => {
        if (state().phase === "loading") {
          return (
            <section {...styles.emptyWorkspace()}>
              <Loader2 size={24} className={styles.loader2().class} />
              <h2>Loading processes</h2>
            </section>
          );
        }
        if (state().phase === "unsupported" || state().phase === "error") {
          return (
            <section {...styles.emptyWorkspace()}>
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
          <div {...styles.processesContent()}>
            <div {...styles.processTable()} role="grid" aria-label="Processes">
              <div
                class={`${styles.processHead().class} ${styles.processFirstColumn().class}`}
                role="columnheader"
              >
                PID
              </div>
              <div {...styles.processHead()} role="columnheader">
                PPID
              </div>
              <div {...styles.processHead()} role="columnheader">
                Name
              </div>
              <div {...styles.processHead()} role="columnheader">
                Status
              </div>
              {state().rows.length === 0 ? (
                <div
                  class={`${styles.processCell().class} ${styles.fullRow().class}`}
                >
                  No processes
                </div>
              ) : (
                state().rows.map((process) => (
                  <div
                    class={`${styles.processRow().class} ${styles.interactiveRow().class} `}
                    role="row"
                    onDblClick={() => props.onOpenProcess(process)}
                  >
                    <span
                      class={`${`${styles.processCell().class} ${styles.monospaceCell().class} `} ${styles.processFirstColumn().class}`}
                    >
                      {process.pid}
                    </span>
                    <span
                      class={`${styles.processCell().class} ${styles.monospaceCell().class} `}
                    >
                      {process.ppid ?? ""}
                    </span>
                    <span {...styles.processCell()}>
                      <span {...styles.processName()}>
                        {process.name || "(unnamed)"}
                      </span>
                    </span>
                    <span
                      class={`${styles.processCell().class} ${styles.mutedCell().class} `}
                    >
                      {processStatusLabel(process.status)}
                    </span>
                  </div>
                ))
              )}
            </div>
            <footer {...styles.processesFooter()}>
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
  const state = () => _model2().state();
  const tree = createMemo(() => buildProcessTreeNodes(state().rows, props.pid));
  return (
    <>
      {(() => {
        if (state().phase === "loading") {
          return (
            <section {...styles.emptyWorkspace()}>
              <Loader2 size={24} className={styles.loader2().class} />
              <h2>Loading child processes</h2>
            </section>
          );
        }
        if (state().phase === "unsupported" || state().phase === "error") {
          return (
            <section {...styles.emptyWorkspace()}>
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
          <div {...styles.processesContent()}>
            <div
              {...styles.processTreeTable()}
              role="grid"
              aria-label="Child process tree"
            >
              <div
                class={`${styles.processHead().class} ${styles.processFirstColumn().class}`}
                role="columnheader"
              >
                Name
              </div>
              <div {...styles.processHead()} role="columnheader">
                PID
              </div>
              <div {...styles.processHead()} role="columnheader">
                PPID
              </div>
              <div {...styles.processHead()} role="columnheader">
                Status
              </div>
              {tree().length === 0 ? (
                <div
                  class={`${styles.processCell().class} ${styles.fullRow().class}`}
                >
                  No child processes
                </div>
              ) : (
                tree().map(({ depth, process }) => (
                  <div
                    class={`${styles.processRow().class} ${styles.interactiveRow().class} `}
                    role="row"
                    onDblClick={() => props.onOpenProcess(process)}
                  >
                    <span
                      {...styles.processCell()}
                      style={{
                        "padding-left": `calc(1rem + ${depth * 1.25}rem)`,
                      }}
                    >
                      <span {...styles.processName()}>
                        {process.name || "(unnamed)"}
                      </span>
                    </span>
                    <span
                      class={`${styles.processCell().class} ${styles.monospaceCell().class} `}
                    >
                      {process.pid}
                    </span>
                    <span
                      class={`${styles.processCell().class} ${styles.monospaceCell().class} `}
                    >
                      {process.ppid ?? ""}
                    </span>
                    <span
                      class={`${styles.processCell().class} ${styles.mutedCell().class} `}
                    >
                      {processStatusLabel(process.status)}
                    </span>
                  </div>
                ))
              )}
            </div>
            <footer {...styles.processesFooter()}>
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
            <section {...styles.emptyWorkspace()}>
              <Loader2 size={24} className={styles.loader2().class} />
              <h2>Loading process</h2>
            </section>
          );
        }
        if (state().phase === "unsupported" || state().phase === "error") {
          return (
            <section {...styles.emptyWorkspace()}>
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
            <section {...styles.emptyWorkspace()}>
              <Activity size={28} />
              <h2>No process detail</h2>
            </section>
          );
        }
        return (
          <div {...styles.processesContent()}>
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
            <footer {...styles.processesFooter()}>
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
  const nowMs = () => now().nowEverySecond();
  const _value = createMemo(() => props.detail);
  return (
    <>
      {(() => {
        return (
          <div {...styles.processDetailScroll()}>
            <div {...styles.processDetailBody()}>
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
              <div {...styles.processDetailActions()}>
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
                <div {...styles.processKillConfirm()}>
                  <span {...styles.processKillMessage()}>
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
                <span {...styles.processKillError()}>{props.killError}</span>
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
            <section {...styles.emptyWorkspace()}>
              <Loader2 size={24} className={styles.loader2().class} />
              <h2>Loading resources in use</h2>
            </section>
          );
        }
        if (state().phase === "unsupported" || state().phase === "error") {
          return (
            <section {...styles.emptyWorkspace()}>
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
          <div {...styles.processesContent()}>
            <div
              {...styles.processResourceTable()}
              role="grid"
              aria-label="Process resources in use"
            >
              <div
                class={`${styles.processHead().class} ${styles.processFirstColumn().class}`}
                role="columnheader"
              >
                Name
              </div>
              <div {...styles.processHead()} role="columnheader">
                Kind
              </div>
              <div {...styles.processHead()} role="columnheader">
                Access
              </div>
              <div {...styles.processHead()} role="columnheader">
                ID
              </div>
              {state().rows.length === 0 ? (
                <div
                  class={`${styles.processCell().class} ${styles.fullRow().class}`}
                >
                  No resources in use
                </div>
              ) : (
                state().rows.map((resource) => {
                  const canOpen = isPathProcessResource(resource);
                  const selected = resource.resourceId === selectedResourceId();
                  return (
                    <div
                      class={`${styles.processRow().class} ${canOpen ? styles.interactiveRow().class : ""} ${selected ? styles.selectedRow().class : ""}`}
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
                        class={`${styles.processCell().class} ${styles.processFirstColumn().class}`}
                      >
                        <span {...styles.processName()}>
                          {resource.name ?? resource.resourceId}
                        </span>
                      </span>
                      <span
                        class={`${styles.processCell().class} ${styles.mutedCell().class} `}
                      >
                        {processResourceInUseKindLabel(resource.kind)}
                      </span>
                      <span
                        class={`${styles.processCell().class} ${styles.mutedCell().class} `}
                      >
                        {processResourceInUseAccessLabel(resource)}
                      </span>
                      <span
                        class={`${styles.processCell().class} ${styles.mutedCell().class} `}
                      >
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
            <footer {...styles.processesFooter()}>
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
            <section {...styles.emptyWorkspace()}>
              <Loader2 size={24} className={styles.loader2().class} />
              <h2>Loading sockets in use</h2>
            </section>
          );
        }
        if (state().phase === "unsupported" || state().phase === "error") {
          return (
            <section {...styles.emptyWorkspace()}>
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
          <div {...styles.processesContent()}>
            <div
              class={
                state().rows.length === 0
                  ? styles.processSocketTableEmpty().class
                  : styles.processSocketTable().class
              }
              role="grid"
              aria-label="Process sockets in use"
            >
              <div
                class={`${styles.processHead().class} ${styles.processFirstColumn().class}`}
                role="columnheader"
              >
                Kind
              </div>
              <div {...styles.processHead()} role="columnheader">
                Local
              </div>
              <div {...styles.processHead()} role="columnheader">
                Remote
              </div>
              <div {...styles.processHead()} role="columnheader">
                Listening
              </div>
              {state().rows.length === 0 ? (
                <div {...styles.processSocketEmptyCell()}>
                  <span>No sockets in use by PID {props.pid}</span>
                  <span {...styles.span()}>
                    Multi-process apps may keep sockets in a separate network
                    service process.
                  </span>
                </div>
              ) : (
                state().rows.map((socket) => (
                  <div
                    {...styles.processRow()}
                    role="row"
                    title={socket.socketId}
                  >
                    <span
                      class={`${`${styles.processCell().class} ${styles.mutedCell().class} `} ${styles.processFirstColumn().class}`}
                    >
                      {processSocketInUseKindLabel(socket.kind)}
                    </span>
                    <span {...styles.processCell()}>
                      <span {...styles.processName()}>
                        {socketEndpointLabel(socket.localEndpoint)}
                      </span>
                    </span>
                    <span {...styles.processCell()}>
                      <span {...styles.processName()}>
                        {socketEndpointLabel(socket.remoteEndpoint)}
                      </span>
                    </span>
                    <span
                      class={`${styles.processCell().class} ${styles.mutedCell().class} `}
                    >
                      {socketListeningLabel(socket.listening)}
                    </span>
                  </div>
                ))
              )}
            </div>
            <footer {...styles.processesFooter()}>
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
            <section {...styles.emptyWorkspace()}>
              <Loader2 size={24} className={styles.loader2().class} />
              <h2>Loading modules</h2>
            </section>
          );
        }
        if (state().phase === "unsupported" || state().phase === "error") {
          return (
            <section {...styles.emptyWorkspace()}>
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
          <div {...styles.processesContent()}>
            <div
              {...styles.processModuleTable()}
              role="grid"
              aria-label="Process modules"
            >
              <div
                class={`${styles.processHead().class} ${styles.processFirstColumn().class}`}
                role="columnheader"
              >
                Name
              </div>
              <div {...styles.processHead()} role="columnheader">
                Kind
              </div>
              <div {...styles.processHead()} role="columnheader">
                Base address
              </div>
              <div {...styles.processHead()} role="columnheader">
                Size
              </div>
              <div {...styles.processHead()} role="columnheader">
                Path
              </div>
              {state().rows.length === 0 ? (
                <div
                  class={`${styles.processCell().class} ${styles.fullRow().class}`}
                >
                  No modules
                </div>
              ) : (
                state().rows.map((module) => {
                  const canOpen =
                    module.path !== undefined && module.path.length > 0;
                  return (
                    <div
                      class={`${styles.processRow().class} ${canOpen ? styles.interactiveRow().class : ""}`}
                      role="row"
                      title={module.path ?? module.name}
                      onDblClick={
                        canOpen
                          ? () => props.onOpenModulePath(module)
                          : undefined
                      }
                    >
                      <span
                        class={`${styles.processCell().class} ${styles.processFirstColumn().class}`}
                      >
                        <span {...styles.processName()}>{module.name}</span>
                      </span>
                      <span
                        class={`${styles.processCell().class} ${styles.mutedCell().class} `}
                      >
                        {processModuleKindLabel(module.kind)}
                      </span>
                      <span
                        class={`${styles.processCell().class} ${styles.mutedCell().class} `}
                      >
                        {module.baseAddress ?? ""}
                      </span>
                      <span
                        class={`${styles.processCell().class} ${styles.mutedCell().class} `}
                      >
                        {module.sizeBytes === undefined
                          ? ""
                          : formatBytes(module.sizeBytes)}
                      </span>
                      <span {...styles.processCell()}>
                        <span {...styles.processName()}>
                          {module.path ?? ""}
                        </span>
                      </span>
                    </div>
                  );
                })
              )}
            </div>
            <footer {...styles.processesFooter()}>
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
          <div {...styles.processResourceDetailPanel()}>
            <button
              type="button"
              {...styles.processResourceDetailCloseButton()}
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
              <span {...styles.processDetailNote()}>{props.note}</span>
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

namespace styles {
  export const interactiveRow = style({
    cursor: "pointer !important",
  });
  export const monospaceCell = style({
    color: "rgb(71 84 103 / 1)",
    fontFamily:
      'ui-monospace,SFMono-Regular,Menlo,Monaco,Consolas,"Liberation Mono","Courier New",monospace',
  });

  export const mutedCell = style({
    color: "rgb(102 112 133 / 1)",
  });

  export const fullRow = style({
    gridColumn: "1/-1",
  });

  export const selectedRow = style({
    backgroundColor: "rgb(238 244 255 / 1 ) !important",
    selectors: {
      "&:hover": {
        backgroundColor: "rgb(231 240 255 / 1 ) !important",
      },
    },
  });

  export const processesTool = style({
    height: "100%",
    minHeight: "0",
    width: "100%",
    display: "flex",
    flexDirection: "column",
    overflow: "hidden",
    backgroundColor: "rgb(255 255 255 / 1)",
    color: "rgb(32 36 45 / 1)",
  });
  export const processesContent = style({
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
        color: "rgb(48 54 66 / 1)",
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
    backgroundColor: "rgb(255 255 255 / 1)",
    color: "rgb(102 112 133 / 1)",
  });
  export const processTable = style({
    gridTemplateColumns:
      "minmax(72px,96px) minmax(72px,96px) minmax(180px,1fr) minmax(104px,132px)",
    display: "grid",
    gridAutoRows: "2rem",
    minHeight: "0",
    minWidth: "0",
    flex: "1 1 0%",
    overflow: "auto",
    backgroundColor: "rgb(255 255 255 / 1)",
    lineHeight: 1.6,
  });
  export const processTreeTable = style({
    gridTemplateColumns:
      "minmax(240px,1fr) minmax(72px,96px) minmax(72px,96px) minmax(104px,132px)",
    display: "grid",
    gridAutoRows: "2rem",
    minHeight: "0",
    minWidth: "0",
    flex: "1 1 0%",
    overflow: "auto",
    backgroundColor: "rgb(255 255 255 / 1)",
    lineHeight: 1.6,
  });
  export const processResourceTable = style({
    gridTemplateColumns:
      "minmax(180px,1fr) minmax(136px,168px) minmax(96px,120px) minmax(120px,168px)",
    display: "grid",
    gridAutoRows: "2rem",
    minHeight: "0",
    minWidth: "0",
    flex: "1 1 0%",
    overflow: "auto",
    backgroundColor: "rgb(255 255 255 / 1)",
    lineHeight: 1.6,
  });
  export const processSocketTable = style({
    gridTemplateColumns:
      "minmax(96px,120px) minmax(180px,1fr) minmax(180px,1fr) minmax(96px,120px)",
    display: "grid",
    gridAutoRows: "2rem",
    minHeight: "0",
    minWidth: "0",
    flex: "1 1 0%",
    overflow: "auto",
    backgroundColor: "rgb(255 255 255 / 1)",
    lineHeight: 1.6,
  });
  export const processSocketTableEmpty = style({
    gridTemplateColumns:
      "minmax(96px,120px) minmax(180px,1fr) minmax(180px,1fr) minmax(96px,120px)",
    gridTemplateRows: "2rem minmax(0,1fr)",
    display: "grid",
    minHeight: "0",
    minWidth: "0",
    flex: "1 1 0%",
    overflow: "auto",
    backgroundColor: "rgb(255 255 255 / 1)",
    lineHeight: 1.6,
  });
  export const processModuleTable = style({
    gridTemplateColumns:
      "minmax(180px,1fr) minmax(120px,148px) minmax(136px,168px) minmax(96px,120px) minmax(240px,2fr)",
    display: "grid",
    gridAutoRows: "2rem",
    minHeight: "0",
    minWidth: "0",
    flex: "1 1 0%",
    overflow: "auto",
    backgroundColor: "rgb(255 255 255 / 1)",
    lineHeight: 1.6,
  });
  export const processHead = style({
    position: "sticky",
    top: "0",
    zIndex: 1,
    boxSizing: "border-box",
    height: "2rem",
    display: "flex",
    alignItems: "center",
    borderBottomWidth: "1px",
    borderBottomColor: "rgb(216 221 231 / 1)",
    backgroundColor: "rgb(246 248 251 / 1)",
    paddingLeft: "8px",
    paddingRight: "8px",
    color: "rgb(102 112 133 / 1)",
    fontWeight: 700,
  });
  export const processRow = style({
    gridColumn: "1/-1",
    gridTemplateColumns: "subgrid",
    display: "grid",
    boxSizing: "border-box",
    height: "2rem",
    minHeight: "2rem",
    cursor: "default",
    borderWidth: "0px",
    borderBottomWidth: "1px",
    borderBottomColor: "rgb(238 241 245 / 1)",
    backgroundColor: "rgb(255 255 255 / 1)",
    selectors: {
      "&:hover": {
        backgroundColor: "rgb(247 249 252 / 1)",
      },
    },
  });
  export const processCell = style({
    minWidth: "0",
    display: "flex",
    alignItems: "center",
    overflow: "hidden",
    textOverflow: "ellipsis",
    whiteSpace: "nowrap",
    paddingLeft: "8px",
    paddingRight: "8px",
    color: "rgb(48 54 66 / 1)",
  });
  export const processFirstColumn = style({
    paddingLeft: "1rem",
  });
  export const processName = style({
    minWidth: "0",
    overflow: "hidden",
    textOverflow: "ellipsis",
    whiteSpace: "nowrap",
  });
  export const processSocketEmptyCell = style({
    gridColumnStart: "1",
    gridColumnEnd: "-1",
    minHeight: "0",
    minWidth: "0",
    display: "flex",
    flexDirection: "column",
    alignItems: "center",
    justifyContent: "center",
    gap: "0.25rem",
    paddingLeft: "1rem",
    paddingRight: "1rem",
    paddingTop: "0.5rem",
    paddingBottom: "0.5rem",
    textAlign: "center",
    color: "rgb(48 54 66 / 1)",
  });
  export const processesFooter = style({
    height: "2rem",
    minHeight: "2rem",
    display: "flex",
    alignItems: "center",
    justifyContent: "flex-end",
    borderTopWidth: "1px",
    borderTopColor: "rgb(216 221 231 / 1)",
    backgroundColor: "rgb(251 252 254 / 1)",
    paddingLeft: "8px",
    paddingRight: "8px",
    color: "rgb(102 112 133 / 1)",
    lineHeight: 1.6,
  });
  export const processDetailScroll = style({
    minHeight: "0",
    flex: "1 1 0%",
    overflow: "auto",
  });
  export const processDetailBody = style({
    display: "grid",
    minWidth: "0",
    alignContent: "flex-start",
    gap: "14px",
    paddingLeft: "18px",
    paddingRight: "18px",
    paddingTop: "16px",
    paddingBottom: "16px",
  });
  export const processDetailNote = style({
    fontSize: "13px",
    color: "rgb(102 112 133 / 1)",
  });

  export const processDetailActions = style({
    minWidth: "0",
    display: "flex",
    flexWrap: "wrap",
    alignItems: "center",
    justifyContent: "flex-start",
    gap: "0.5rem",
  });
  export const processKillConfirm = style({
    minWidth: "0",
    display: "flex",
    flexWrap: "wrap",
    alignItems: "center",
    gap: "0.5rem",
    borderWidth: "1px",
    borderColor: theme.dangerBorder,
    borderRadius: "6px",
    backgroundColor: theme.dangerSoft,
    paddingLeft: "0.75rem",
    paddingRight: "0.75rem",
    paddingTop: "0.5rem",
    paddingBottom: "0.5rem",
  });
  export const processKillMessage = style({
    marginRight: "auto",
    fontSize: "1rem",
    color: theme.danger,
  });
  export const processKillError = style({
    fontSize: "1rem",
    color: theme.danger,
  });
  export const processResourceDetailPanel = style({
    position: "relative",
    maxHeight: "40%",
    minHeight: "9rem",
    overflow: "auto",
    borderTopWidth: "1px",
    borderTopColor: "rgb(216 221 231 / 1)",
    backgroundColor: "rgb(251 252 254 / 1)",
    paddingLeft: "18px",
    paddingRight: "3rem",
    paddingTop: "16px",
    paddingBottom: "16px",
  });
  export const processResourceDetailCloseButton = style({
    fontFamily: "inherit",
    position: "absolute",
    right: "0.75rem",
    top: "0.75rem",
    display: "grid",
    height: "1.6rem",
    width: "1.6rem",
    cursor: "pointer",
    placeItems: "center",
    borderWidth: "1px",
    borderColor: "transparent",
    borderRadius: "0.25rem",
    backgroundColor: "transparent",
    selectors: {
      "&:hover": {
        backgroundColor: "rgb(238 243 251 / 1)",
        color: "rgb(52 64 84 / 1)",
      },
    },
    padding: "0",
    color: "rgb(102 112 133 / 1)",
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

  export const span = style({
    color: "rgb(100 116 139 / 1)",
  });
}
