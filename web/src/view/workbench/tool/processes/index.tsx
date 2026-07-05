import { useEffect, useRef, useState } from "react";
import { useAtomValue } from "jotai";
import { useBunja } from "bunja/react";
import { nowBunja } from "unsaturated/now";
import {
  Activity,
  ExternalLink,
  HardDrive,
  KeyRound,
  Loader2,
  X,
} from "lucide-react";
import {
  subscribeProcessDetail,
  subscribeProcesses,
  subscribeProcessModules,
  subscribeProcessResourcesInUse,
  subscribeProcessSocketsInUse,
} from "../../../../protocol/generated/client.ts";
import {
  type FsEntry,
  FsEntryKind,
  type ProcessDetail,
  type ProcessDetailEvent,
  type ProcessesTableEvent,
  type ProcessInfo,
  type ProcessModuleInfo,
  ProcessModuleKind,
  type ProcessModulesTableEvent,
  type ProcessResourceInUseInfo,
  ProcessResourceInUseKind,
  type ProcessResourcesInUseTableEvent,
  type ProcessSocketInUseInfo,
  type ProcessSocketsInUseTableEvent,
  ProcessStatus,
  ProcId,
  type SocketEndpoint,
} from "../../../../protocol/generated/rpc.ts";
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
  type WorkbenchProcessPage,
  workbenchTabBunja,
} from "../../../../state/workbench.ts";
import { Button } from "../../../ui/button.tsx";
import { Breadcrumb, type BreadcrumbItem } from "../../../ui/breadcrumb.tsx";
import {
  PropertyList,
  PropertyListItem,
  PropertyValue,
} from "../../../ui/property-list.tsx";

interface ProcessesState {
  message?: string;
  phase: "idle" | "loading" | "ready" | "error" | "unsupported";
  rows: ProcessInfo[];
}

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
const processPidCellClassName =
  `${processCellClassName} font-mono text-[#475467]`;
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
const processDetailNoteClassName = "text-[12px] text-[#667085]";
const processDetailFooterClassName = [
  "flex h-[2rem] min-h-[2rem] items-center justify-end border-t border-t-[#d8dde7]",
  "bg-[#fbfcfe] px-[8px] leading-[1.6] text-[#667085]",
].join(" ");
const processDetailActionsClassName =
  "flex min-w-0 items-center justify-start gap-[0.5rem]";
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
  const machine = useAtomValue(machineStore.selectedAtom);
  const isPaired = useAtomValue(machineStore.selectedIsPairedAtom);
  const daemonInfo = useAtomValue(rpcSession.daemonInfoAtom);
  const tab = useAtomValue(tabState.tabAtom);
  const selectedPid = tab?.processDetailPid;
  const selectedPage = selectedPid === undefined
    ? undefined
    : tab?.processPage ?? "detail";

  const processListSupported = daemonInfo.phase === "ready" &&
    daemonInfo.daemonInfo.supportedProcIds.includes(ProcId.SubscribeProcesses);
  const processDetailSupported = daemonInfo.phase === "ready" &&
    daemonInfo.daemonInfo.supportedProcIds.includes(
      ProcId.SubscribeProcessDetail,
    );
  const processResourcesInUseSupported = daemonInfo.phase === "ready" &&
    daemonInfo.daemonInfo.supportedProcIds.includes(
      ProcId.SubscribeProcessResourcesInUse,
    );
  const processSocketsInUseSupported = daemonInfo.phase === "ready" &&
    daemonInfo.daemonInfo.supportedProcIds.includes(
      ProcId.SubscribeProcessSocketsInUse,
    );
  const processModulesSupported = daemonInfo.phase === "ready" &&
    daemonInfo.daemonInfo.supportedProcIds.includes(
      ProcId.SubscribeProcessModules,
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
    <section className={processesToolClassName}>
      <ProcessesBreadcrumb
        selectedPage={selectedPage}
        selectedPid={selectedPid}
        onOpenRoot={() => tabState.setProcessDetailPid(undefined)}
        onOpenProcess={() => tabState.setProcessPage("detail")}
      />
      {selectedPid === undefined
        ? (
          <ProcessListView
            daemonInfoPhase={daemonInfo.phase}
            machineId={machine.id}
            rpcSession={rpcSession}
            supported={processListSupported}
            onOpenProcess={(process) =>
              paneState.addProcessesTab({
                processDetailPid: process.pid,
                title: process.name || `PID ${process.pid}`,
              })}
          />
        )
        : selectedPage === "heldResources"
        ? (
          <ProcessResourcesInUseView
            daemonInfoPhase={daemonInfo.phase}
            machineId={machine.id}
            onOpenPathResource={(resource) => {
              const tabId = paneState.addFilesTab();
              writeProcessResourceFilesNavigationState(
                machine.id,
                tabId,
                resource,
              );
            }}
            pid={selectedPid}
            rpcSession={rpcSession}
            supported={processResourcesInUseSupported}
          />
        )
        : selectedPage === "heldSockets"
        ? (
          <ProcessSocketsInUseView
            daemonInfoPhase={daemonInfo.phase}
            machineId={machine.id}
            pid={selectedPid}
            rpcSession={rpcSession}
            supported={processSocketsInUseSupported}
          />
        )
        : selectedPage === "modules"
        ? (
          <ProcessModulesView
            daemonInfoPhase={daemonInfo.phase}
            machineId={machine.id}
            onOpenModulePath={(module) => {
              const tabId = paneState.addFilesTab();
              writeProcessModuleFilesNavigationState(
                machine.id,
                tabId,
                module,
              );
            }}
            pid={selectedPid}
            rpcSession={rpcSession}
            supported={processModulesSupported}
          />
        )
        : selectedPage === "children"
        ? (
          <ProcessChildrenView
            daemonInfoPhase={daemonInfo.phase}
            machineId={machine.id}
            onOpenProcess={(process) =>
              paneState.addProcessesTab({
                processDetailPid: process.pid,
                title: process.name || `PID ${process.pid}`,
              })}
            pid={selectedPid}
            rpcSession={rpcSession}
            supported={processListSupported}
          />
        )
        : (
          <ProcessDetailView
            daemonInfoPhase={daemonInfo.phase}
            machineId={machine.id}
            onShowChildren={() =>
              paneState.addProcessesTab({
                processDetailPid: selectedPid,
                processPage: "children",
                title: tab?.title ?? `PID ${selectedPid}`,
              })}
            onShowResourcesInUse={() =>
              paneState.addProcessesTab({
                processDetailPid: selectedPid,
                processPage: "heldResources",
                title: tab?.title ?? `PID ${selectedPid}`,
              })}
            onShowSocketsInUse={() =>
              paneState.addProcessesTab({
                processDetailPid: selectedPid,
                processPage: "heldSockets",
                title: tab?.title ?? `PID ${selectedPid}`,
              })}
            onShowModules={() =>
              paneState.addProcessesTab({
                processDetailPid: selectedPid,
                processPage: "modules",
                title: tab?.title ?? `PID ${selectedPid}`,
              })}
            pid={selectedPid}
            rpcSession={rpcSession}
            modulesSupported={processModulesSupported}
            resourcesSupported={processResourcesInUseSupported}
            socketsSupported={processSocketsInUseSupported}
            supported={processDetailSupported}
          />
        )}
    </section>
  );
}

interface ProcessesBreadcrumbProps {
  selectedPage?: WorkbenchProcessPage;
  selectedPid?: number;
  onOpenProcess: () => void;
  onOpenRoot: () => void;
}

function ProcessesBreadcrumb(
  {
    selectedPage,
    selectedPid,
    onOpenProcess,
    onOpenRoot,
  }: ProcessesBreadcrumbProps,
) {
  const items: BreadcrumbItem[] = [
    {
      label: "Processes",
      onClick: selectedPid === undefined ? undefined : onOpenRoot,
    },
  ];
  if (selectedPid === undefined) {
    items.push({ label: "Overview" });
  } else {
    items.push({
      label: `PID ${selectedPid}`,
      onClick:
        selectedPage === "children" || selectedPage === "heldResources" ||
          selectedPage === "heldSockets" || selectedPage === "modules"
          ? onOpenProcess
          : undefined,
    });
    if (selectedPage === "children") {
      items.push({ label: "Process tree" });
    } else if (selectedPage === "heldResources") {
      items.push({ label: "Resources in use" });
    } else if (selectedPage === "heldSockets") {
      items.push({ label: "Sockets in use" });
    } else if (selectedPage === "modules") {
      items.push({ label: "Modules" });
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
}

interface ProcessListViewProps {
  daemonInfoPhase: string;
  machineId: string;
  rpcSession: ProcessesRpcSession;
  supported: boolean;
  onOpenProcess: (process: ProcessInfo) => void;
}

function ProcessListView(
  {
    daemonInfoPhase,
    machineId,
    rpcSession,
    supported,
    onOpenProcess,
  }: ProcessListViewProps,
) {
  const rowsRef = useRef<ProcessInfo[]>([]);
  const [state, setState] = useState<ProcessesState>({
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
        message: "This daemon does not support process subscriptions.",
        phase: "unsupported",
        rows: [],
      });
      return;
    }

    let cancelled = false;
    let iterator: AsyncGenerator<ProcessesTableEvent> | undefined;
    setState((current) => ({ ...current, phase: "loading" }));

    void (async () => {
      try {
        const transport = await rpcSession.webTransport();
        if (cancelled) return;
        iterator = subscribeProcesses(transport);
        for await (const event of iterator) {
          if (cancelled) return;
          const rows = applyProcessesEvent(rowsRef.current, event);
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
        <h2>Loading processes</h2>
      </section>
    );
  }

  if (state.phase === "unsupported" || state.phase === "error") {
    return (
      <section className={emptyWorkspaceClassName}>
        <Activity size={28} />
        <h2>
          {state.phase === "unsupported"
            ? "Processes unavailable"
            : "Failed to load processes"}
        </h2>
        {state.message ? <p>{state.message}</p> : null}
      </section>
    );
  }

  return (
    <div className={processesContentClassName}>
      <div
        className={processTableClassName}
        role="grid"
        aria-label="Processes"
      >
        <div
          className={`${processHeadClassName} ${processFirstColumnClassName}`}
          role="columnheader"
        >
          PID
        </div>
        <div className={processHeadClassName} role="columnheader">
          PPID
        </div>
        <div className={processHeadClassName} role="columnheader">
          Name
        </div>
        <div className={processHeadClassName} role="columnheader">
          Status
        </div>
        {state.rows.length === 0
          ? (
            <div className={`${processCellClassName} [grid-column:1/-1]`}>
              No processes
            </div>
          )
          : state.rows.map((process) => (
            <div
              key={process.pid}
              className={`${processRowClassName} !cursor-pointer`}
              role="row"
              onDoubleClick={() => onOpenProcess(process)}
            >
              <span
                className={`${processPidCellClassName} ${processFirstColumnClassName}`}
              >
                {process.pid}
              </span>
              <span className={processPidCellClassName}>
                {process.ppid ?? ""}
              </span>
              <span className={processCellClassName}>
                <span className={processNameClassName}>
                  {process.name || "(unnamed)"}
                </span>
              </span>
              <span className={processMetaCellClassName}>
                {processStatusLabel(process.status)}
              </span>
            </div>
          ))}
      </div>
      <footer className={processesFooterClassName}>
        {state.rows.length} {state.rows.length === 1 ? "process" : "processes"}
      </footer>
    </div>
  );
}

interface ProcessChildrenViewProps {
  daemonInfoPhase: string;
  machineId: string;
  onOpenProcess: (process: ProcessInfo) => void;
  pid: number;
  rpcSession: ProcessesRpcSession;
  supported: boolean;
}

function ProcessChildrenView(
  {
    daemonInfoPhase,
    machineId,
    onOpenProcess,
    pid,
    rpcSession,
    supported,
  }: ProcessChildrenViewProps,
) {
  const rowsRef = useRef<ProcessInfo[]>([]);
  const [state, setState] = useState<ProcessesState>({
    phase: "idle",
    rows: [],
  });
  const tree = buildProcessTreeNodes(state.rows, pid);

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
        message: "This daemon does not support process subscriptions.",
        phase: "unsupported",
        rows: [],
      });
      return;
    }

    let cancelled = false;
    let iterator: AsyncGenerator<ProcessesTableEvent> | undefined;
    setState((current) => ({ ...current, phase: "loading" }));

    void (async () => {
      try {
        const transport = await rpcSession.webTransport();
        if (cancelled) return;
        iterator = subscribeProcesses(transport);
        for await (const event of iterator) {
          if (cancelled) return;
          const rows = applyProcessesEvent(rowsRef.current, event);
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
  }, [daemonInfoPhase, machineId, pid, rpcSession, supported]);

  if (state.phase === "loading" || daemonInfoPhase !== "ready") {
    return (
      <section className={emptyWorkspaceClassName}>
        <Loader2 size={24} className="animate-spin" />
        <h2>Loading child processes</h2>
      </section>
    );
  }

  if (state.phase === "unsupported" || state.phase === "error") {
    return (
      <section className={emptyWorkspaceClassName}>
        <Activity size={28} />
        <h2>
          {state.phase === "unsupported"
            ? "Process tree unavailable"
            : "Failed to load process tree"}
        </h2>
        {state.message ? <p>{state.message}</p> : null}
      </section>
    );
  }

  return (
    <div className={processesContentClassName}>
      <div
        className={processTreeTableClassName}
        role="grid"
        aria-label="Child process tree"
      >
        <div
          className={`${processHeadClassName} ${processFirstColumnClassName}`}
          role="columnheader"
        >
          Name
        </div>
        <div className={processHeadClassName} role="columnheader">
          PID
        </div>
        <div className={processHeadClassName} role="columnheader">
          PPID
        </div>
        <div className={processHeadClassName} role="columnheader">
          Status
        </div>
        {tree.length === 0
          ? (
            <div className={`${processCellClassName} [grid-column:1/-1]`}>
              No child processes
            </div>
          )
          : tree.map(({ depth, process }) => (
            <div
              key={process.pid}
              className={`${processRowClassName} !cursor-pointer`}
              role="row"
              onDoubleClick={() => onOpenProcess(process)}
            >
              <span
                className={processCellClassName}
                style={{ paddingLeft: `calc(1rem + ${depth * 1.25}rem)` }}
              >
                <span className={processNameClassName}>
                  {process.name || "(unnamed)"}
                </span>
              </span>
              <span className={processPidCellClassName}>
                {process.pid}
              </span>
              <span className={processPidCellClassName}>
                {process.ppid ?? ""}
              </span>
              <span className={processMetaCellClassName}>
                {processStatusLabel(process.status)}
              </span>
            </div>
          ))}
      </div>
      <footer className={processesFooterClassName}>
        {tree.length} {tree.length === 1 ? "process" : "processes"}
      </footer>
    </div>
  );
}

interface ProcessDetailViewProps {
  daemonInfoPhase: string;
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

function ProcessDetailView(
  {
    daemonInfoPhase,
    machineId,
    onShowChildren,
    onShowModules,
    onShowResourcesInUse,
    onShowSocketsInUse,
    pid,
    rpcSession,
    modulesSupported,
    resourcesSupported,
    socketsSupported,
    supported,
  }: ProcessDetailViewProps,
) {
  const [state, setState] = useState<ProcessDetailState>({
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
        message: "This daemon does not support process detail subscriptions.",
        phase: "unsupported",
      });
      return;
    }

    let cancelled = false;
    let iterator: AsyncGenerator<ProcessDetailEvent> | undefined;
    setState({ phase: "loading" });

    void (async () => {
      try {
        const transport = await rpcSession.webTransport();
        if (cancelled) return;
        iterator = subscribeProcessDetail(transport, { pid });
        for await (const event of iterator) {
          if (cancelled) return;
          if (event.type === "exited") {
            setState((current) => ({ ...current, phase: "exited" }));
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
  }, [daemonInfoPhase, machineId, pid, rpcSession, supported]);

  if (state.phase === "loading" || daemonInfoPhase !== "ready") {
    return (
      <section className={emptyWorkspaceClassName}>
        <Loader2 size={24} className="animate-spin" />
        <h2>Loading process</h2>
      </section>
    );
  }

  if (state.phase === "unsupported" || state.phase === "error") {
    return (
      <section className={emptyWorkspaceClassName}>
        <Activity size={28} />
        <h2>
          {state.phase === "unsupported"
            ? "Process detail unavailable"
            : "Failed to load process"}
        </h2>
        {state.message ? <p>{state.message}</p> : null}
      </section>
    );
  }

  if (!state.detail) {
    return (
      <section className={emptyWorkspaceClassName}>
        <Activity size={28} />
        <h2>No process detail</h2>
      </section>
    );
  }

  return (
    <div className={processesContentClassName}>
      <ProcessDetailSummary
        detail={state.detail}
        onShowChildren={onShowChildren}
        onShowModules={onShowModules}
        onShowResourcesInUse={onShowResourcesInUse}
        onShowSocketsInUse={onShowSocketsInUse}
        modulesSupported={modulesSupported}
        resourcesSupported={resourcesSupported}
        socketsSupported={socketsSupported}
      />
      <footer className={processDetailFooterClassName}>
        {state.phase === "exited"
          ? "Process exited"
          : `PID ${state.detail.info.pid}`}
      </footer>
    </div>
  );
}

interface ProcessDetailSummaryProps {
  detail: ProcessDetail;
  onShowChildren: () => void;
  onShowModules: () => void;
  onShowResourcesInUse: () => void;
  onShowSocketsInUse: () => void;
  modulesSupported: boolean;
  resourcesSupported: boolean;
  socketsSupported: boolean;
}

function ProcessDetailSummary(
  {
    detail,
    onShowChildren,
    onShowModules,
    onShowResourcesInUse,
    onShowSocketsInUse,
    modulesSupported,
    resourcesSupported,
    socketsSupported,
  }: ProcessDetailSummaryProps,
) {
  const now = useBunja(nowBunja);
  const nowMs = useAtomValue(now.nowEverySecondAtom);
  const { info, metadata, usage } = detail;
  return (
    <div className={processDetailScrollClassName}>
      <div className={processDetailBodyClassName}>
        <PropertyList>
          <ProcessDetailItem label="Name" value={info.name || "(unnamed)"} />
          <ProcessDetailItem label="PID" value={String(info.pid)} />
          <ProcessDetailItem
            label="PPID"
            value={info.ppid === undefined ? "None" : String(info.ppid)}
          />
          <ProcessDetailItem
            label="Status"
            value={processStatusLabel(info.status)}
          />
          <ProcessDetailItem
            label="Started"
            note={`Uptime ${
              formatProcessUptime(metadata.startTimeUnix, nowMs)
            }`}
            value={formatUnixTimestamp(metadata.startTimeUnix)}
          />
          <ProcessDetailItem
            label="Command"
            value={metadata.command.length === 0
              ? "Unknown"
              : metadata.command.join(" ")}
          />
          <ProcessDetailItem
            label="Executable"
            value={metadata.executablePath ?? "Unknown"}
          />
          <ProcessDetailItem label="CWD" value={metadata.cwd ?? "Unknown"} />
        </PropertyList>
        <div className={processDetailActionsClassName}>
          <Button
            onClick={onShowChildren}
            title="Show process tree rooted at this process"
          >
            <ExternalLink size={14} />
            Process tree
          </Button>
          <Button
            disabled={!resourcesSupported}
            onClick={onShowResourcesInUse}
            title={resourcesSupported
              ? "Show resources currently in use by this process"
              : "This daemon does not support resource usage subscriptions"}
          >
            <ExternalLink size={14} />
            Resources in use
          </Button>
          <Button
            disabled={!socketsSupported}
            onClick={onShowSocketsInUse}
            title={socketsSupported
              ? "Show sockets currently in use by this process"
              : "This daemon does not support socket usage subscriptions"}
          >
            <ExternalLink size={14} />
            Sockets in use
          </Button>
          <Button
            disabled={!modulesSupported}
            onClick={onShowModules}
            title={modulesSupported
              ? "Show executable images and dynamic libraries loaded by this process"
              : "This daemon does not support module subscriptions"}
          >
            <ExternalLink size={14} />
            Modules
          </Button>
        </div>
        <ProcessResourceUsageTable usage={usage} />
      </div>
    </div>
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

function ProcessResourcesInUseView(
  {
    daemonInfoPhase,
    machineId,
    onOpenPathResource,
    pid,
    rpcSession,
    supported,
  }: ProcessResourcesInUseViewProps,
) {
  const rowsRef = useRef<ProcessResourceInUseInfo[]>([]);
  const [state, setState] = useState<ProcessResourcesInUseState>({
    phase: "idle",
    rows: [],
  });
  const [selectedResourceId, setSelectedResourceId] = useState<string>();
  const selectedResource = selectedResourceId === undefined
    ? undefined
    : state.rows.find((resource) => resource.resourceId === selectedResourceId);

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
        message:
          "This daemon does not support process resource usage subscriptions.",
        phase: "unsupported",
        rows: [],
      });
      return;
    }

    let cancelled = false;
    let iterator: AsyncGenerator<ProcessResourcesInUseTableEvent> | undefined;
    setState((current) => ({ ...current, phase: "loading" }));

    void (async () => {
      try {
        const transport = await rpcSession.webTransport();
        if (cancelled) return;
        iterator = subscribeProcessResourcesInUse(transport, { pid });
        for await (const event of iterator) {
          if (cancelled) return;
          if (event.type === "exited") {
            setState((current) => ({ ...current, phase: "exited" }));
            return;
          }
          const rows = applyProcessResourcesInUseEvent(rowsRef.current, event);
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
  }, [daemonInfoPhase, machineId, pid, rpcSession, supported]);

  useEffect(() => {
    if (selectedResourceId === undefined) return;
    if (
      state.rows.some((resource) => resource.resourceId === selectedResourceId)
    ) {
      return;
    }
    setSelectedResourceId(undefined);
  }, [selectedResourceId, state.rows]);

  if (state.phase === "loading" || daemonInfoPhase !== "ready") {
    return (
      <section className={emptyWorkspaceClassName}>
        <Loader2 size={24} className="animate-spin" />
        <h2>Loading resources in use</h2>
      </section>
    );
  }

  if (state.phase === "unsupported" || state.phase === "error") {
    return (
      <section className={emptyWorkspaceClassName}>
        <Activity size={28} />
        <h2>
          {state.phase === "unsupported"
            ? "Resources in use unavailable"
            : "Failed to load resources in use"}
        </h2>
        {state.message ? <p>{state.message}</p> : null}
      </section>
    );
  }

  return (
    <div className={processesContentClassName}>
      <div
        className={processResourceTableClassName}
        role="grid"
        aria-label="Process resources in use"
      >
        <div
          className={`${processHeadClassName} ${processFirstColumnClassName}`}
          role="columnheader"
        >
          Name
        </div>
        <div className={processHeadClassName} role="columnheader">
          Kind
        </div>
        <div className={processHeadClassName} role="columnheader">
          Access
        </div>
        <div className={processHeadClassName} role="columnheader">
          ID
        </div>
        {state.rows.length === 0
          ? (
            <div className={`${processCellClassName} [grid-column:1/-1]`}>
              No resources in use
            </div>
          )
          : state.rows.map((resource) => {
            const canOpen = isPathProcessResource(resource);
            const selected = resource.resourceId === selectedResourceId;
            return (
              <div
                key={resource.resourceId}
                className={`${processRowClassName} ${
                  canOpen ? "!cursor-pointer" : ""
                } ${selected ? "!bg-[#eef4ff] hover:!bg-[#e7f0ff]" : ""}`}
                role="row"
                title={resource.name ?? resource.resourceId}
                onClick={() =>
                  setSelectedResourceId((current) =>
                    current === resource.resourceId
                      ? undefined
                      : resource.resourceId
                  )}
                onDoubleClick={canOpen
                  ? () => onOpenPathResource(resource)
                  : undefined}
              >
                <span
                  className={`${processCellClassName} ${processFirstColumnClassName}`}
                >
                  <span className={processNameClassName}>
                    {resource.name ?? resource.resourceId}
                  </span>
                </span>
                <span className={processMetaCellClassName}>
                  {processResourceInUseKindLabel(resource.kind)}
                </span>
                <span className={processMetaCellClassName}>
                  {processResourceInUseAccessLabel(resource)}
                </span>
                <span className={processMetaCellClassName}>
                  {resource.resourceId}
                </span>
              </div>
            );
          })}
      </div>
      {selectedResource
        ? (
          <ProcessResourceInUseDetail
            resource={selectedResource}
            onClose={() => setSelectedResourceId(undefined)}
          />
        )
        : null}
      <footer className={processesFooterClassName}>
        {state.phase === "exited"
          ? "Process exited"
          : `${state.rows.length} ${
            state.rows.length === 1 ? "resource" : "resources"
          }`}
      </footer>
    </div>
  );
}

interface ProcessSocketsInUseViewProps {
  daemonInfoPhase: string;
  machineId: string;
  pid: number;
  rpcSession: ProcessesRpcSession;
  supported: boolean;
}

function ProcessSocketsInUseView(
  {
    daemonInfoPhase,
    machineId,
    pid,
    rpcSession,
    supported,
  }: ProcessSocketsInUseViewProps,
) {
  const rowsRef = useRef<ProcessSocketInUseInfo[]>([]);
  const [state, setState] = useState<ProcessSocketsInUseState>({
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
        message:
          "This daemon does not support process socket usage subscriptions.",
        phase: "unsupported",
        rows: [],
      });
      return;
    }

    let cancelled = false;
    let iterator: AsyncGenerator<ProcessSocketsInUseTableEvent> | undefined;
    setState((current) => ({ ...current, phase: "loading" }));

    void (async () => {
      try {
        const transport = await rpcSession.webTransport();
        if (cancelled) return;
        iterator = subscribeProcessSocketsInUse(transport, { pid });
        for await (const event of iterator) {
          if (cancelled) return;
          if (event.type === "exited") {
            setState((current) => ({ ...current, phase: "exited" }));
            return;
          }
          const rows = applyProcessSocketsInUseEvent(rowsRef.current, event);
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
  }, [daemonInfoPhase, machineId, pid, rpcSession, supported]);

  if (state.phase === "loading" || daemonInfoPhase !== "ready") {
    return (
      <section className={emptyWorkspaceClassName}>
        <Loader2 size={24} className="animate-spin" />
        <h2>Loading sockets in use</h2>
      </section>
    );
  }

  if (state.phase === "unsupported" || state.phase === "error") {
    return (
      <section className={emptyWorkspaceClassName}>
        <Activity size={28} />
        <h2>
          {state.phase === "unsupported"
            ? "Sockets in use unavailable"
            : "Failed to load sockets in use"}
        </h2>
        {state.message ? <p>{state.message}</p> : null}
      </section>
    );
  }

  return (
    <div className={processesContentClassName}>
      <div
        className={state.rows.length === 0
          ? processSocketTableEmptyClassName
          : processSocketTableClassName}
        role="grid"
        aria-label="Process sockets in use"
      >
        <div
          className={`${processHeadClassName} ${processFirstColumnClassName}`}
          role="columnheader"
        >
          Kind
        </div>
        <div className={processHeadClassName} role="columnheader">
          Local
        </div>
        <div className={processHeadClassName} role="columnheader">
          Remote
        </div>
        <div className={processHeadClassName} role="columnheader">
          Listening
        </div>
        {state.rows.length === 0
          ? (
            <div className={processSocketEmptyCellClassName}>
              <span>No sockets in use by PID {pid}</span>
              <span className="text-slate-500">
                Multi-process apps may keep sockets in a separate network
                service process.
              </span>
            </div>
          )
          : state.rows.map((socket) => (
            <div
              key={socket.socketId}
              className={processRowClassName}
              role="row"
              title={socket.socketId}
            >
              <span
                className={`${processMetaCellClassName} ${processFirstColumnClassName}`}
              >
                {processSocketInUseKindLabel(socket.kind)}
              </span>
              <span className={processCellClassName}>
                <span className={processNameClassName}>
                  {socketEndpointLabel(socket.localEndpoint)}
                </span>
              </span>
              <span className={processCellClassName}>
                <span className={processNameClassName}>
                  {socketEndpointLabel(socket.remoteEndpoint)}
                </span>
              </span>
              <span className={processMetaCellClassName}>
                {socketListeningLabel(socket.listening)}
              </span>
            </div>
          ))}
      </div>
      <footer className={processesFooterClassName}>
        {state.phase === "exited"
          ? "Process exited"
          : `${state.rows.length} ${
            state.rows.length === 1 ? "socket" : "sockets"
          }`}
      </footer>
    </div>
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

function ProcessModulesView(
  {
    daemonInfoPhase,
    machineId,
    onOpenModulePath,
    pid,
    rpcSession,
    supported,
  }: ProcessModulesViewProps,
) {
  const rowsRef = useRef<ProcessModuleInfo[]>([]);
  const [state, setState] = useState<ProcessModulesState>({
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
        message: "This daemon does not support process module subscriptions.",
        phase: "unsupported",
        rows: [],
      });
      return;
    }

    let cancelled = false;
    let iterator: AsyncGenerator<ProcessModulesTableEvent> | undefined;
    setState((current) => ({ ...current, phase: "loading" }));

    void (async () => {
      try {
        const transport = await rpcSession.webTransport();
        if (cancelled) return;
        iterator = subscribeProcessModules(transport, { pid });
        for await (const event of iterator) {
          if (cancelled) return;
          if (event.type === "exited") {
            setState((current) => ({ ...current, phase: "exited" }));
            return;
          }
          const rows = applyProcessModulesEvent(rowsRef.current, event);
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
  }, [daemonInfoPhase, machineId, pid, rpcSession, supported]);

  if (state.phase === "loading" || daemonInfoPhase !== "ready") {
    return (
      <section className={emptyWorkspaceClassName}>
        <Loader2 size={24} className="animate-spin" />
        <h2>Loading modules</h2>
      </section>
    );
  }

  if (state.phase === "unsupported" || state.phase === "error") {
    return (
      <section className={emptyWorkspaceClassName}>
        <Activity size={28} />
        <h2>
          {state.phase === "unsupported"
            ? "Modules unavailable"
            : "Failed to load modules"}
        </h2>
        {state.message ? <p>{state.message}</p> : null}
      </section>
    );
  }

  return (
    <div className={processesContentClassName}>
      <div
        className={processModuleTableClassName}
        role="grid"
        aria-label="Process modules"
      >
        <div
          className={`${processHeadClassName} ${processFirstColumnClassName}`}
          role="columnheader"
        >
          Name
        </div>
        <div className={processHeadClassName} role="columnheader">
          Kind
        </div>
        <div className={processHeadClassName} role="columnheader">
          Base address
        </div>
        <div className={processHeadClassName} role="columnheader">
          Size
        </div>
        <div className={processHeadClassName} role="columnheader">
          Path
        </div>
        {state.rows.length === 0
          ? (
            <div className={`${processCellClassName} [grid-column:1/-1]`}>
              No modules
            </div>
          )
          : state.rows.map((module) => {
            const canOpen = module.path !== undefined && module.path.length > 0;
            return (
              <div
                key={module.moduleId}
                className={`${processRowClassName} ${
                  canOpen ? "!cursor-pointer" : ""
                }`}
                role="row"
                title={module.path ?? module.name}
                onDoubleClick={canOpen
                  ? () => onOpenModulePath(module)
                  : undefined}
              >
                <span
                  className={`${processCellClassName} ${processFirstColumnClassName}`}
                >
                  <span className={processNameClassName}>
                    {module.name}
                  </span>
                </span>
                <span className={processMetaCellClassName}>
                  {processModuleKindLabel(module.kind)}
                </span>
                <span className={processMetaCellClassName}>
                  {module.baseAddress ?? ""}
                </span>
                <span className={processMetaCellClassName}>
                  {module.sizeBytes === undefined
                    ? ""
                    : formatBytes(module.sizeBytes)}
                </span>
                <span className={processCellClassName}>
                  <span className={processNameClassName}>
                    {module.path ?? ""}
                  </span>
                </span>
              </div>
            );
          })}
      </div>
      <footer className={processesFooterClassName}>
        {state.phase === "exited"
          ? "Process exited"
          : `${state.rows.length} ${
            state.rows.length === 1 ? "module" : "modules"
          }`}
      </footer>
    </div>
  );
}

interface ProcessResourceInUseDetailProps {
  onClose: () => void;
  resource: ProcessResourceInUseInfo;
}

function ProcessResourceInUseDetail(
  { onClose, resource }: ProcessResourceInUseDetailProps,
) {
  return (
    <div className={processResourceDetailPanelClassName}>
      <button
        type="button"
        className={processResourceDetailCloseButtonClassName}
        onClick={onClose}
        title="Close resource detail"
      >
        <X size={14} />
      </button>
      <PropertyList>
        <ProcessDetailItem
          label="Name"
          value={resource.name ?? "Unknown"}
        />
        <ProcessDetailItem
          label="Kind"
          value={processResourceInUseKindLabel(resource.kind)}
        />
        <ProcessDetailItem
          label="Access"
          value={processResourceInUseAccessLabel(resource) || "Unknown"}
        />
        <ProcessDetailItem
          label="State"
          value={resource.deleted ? "Deleted" : "Active"}
        />
        <ProcessDetailItem label="Resource ID" value={resource.resourceId} />
      </PropertyList>
    </div>
  );
}

interface ProcessResourceUsageTableProps {
  usage: ProcessDetail["usage"];
}

function ProcessResourceUsageTable({ usage }: ProcessResourceUsageTableProps) {
  return (
    <PropertyList>
      <ProcessDetailItem
        label="CPU"
        note={`Accumulated CPU time ${
          formatDurationMs(usage.accumulatedCpuTimeMs)
        }`}
        value={formatCpuUsagePercent(usage.cpuUsagePercent)}
      />
      <ProcessDetailItem
        label="Memory"
        note={`Virtual ${formatBytes(usage.virtualMemoryBytes)}`}
        value={formatBytes(usage.memoryBytes)}
      />
      <ProcessDetailItem
        label="IO read"
        note={`Total ${formatBytes(usage.ioUsage.totalReadBytes)}`}
        value={`${formatBytes(usage.ioUsage.readBytes)}/s`}
      />
      <ProcessDetailItem
        label="IO written"
        note={`Total ${formatBytes(usage.ioUsage.totalWrittenBytes)}`}
        value={`${formatBytes(usage.ioUsage.writtenBytes)}/s`}
      />
    </PropertyList>
  );
}

interface ProcessDetailItemProps {
  label: string;
  note?: string;
  value: string;
}

function ProcessDetailItem({ label, note, value }: ProcessDetailItemProps) {
  return (
    <PropertyListItem label={label}>
      <PropertyValue>{value}</PropertyValue>
      {note ? <span className={processDetailNoteClassName}>{note}</span> : null}
    </PropertyListItem>
  );
}

function applyProcessDetailEvent(
  current: ProcessDetailState,
  event: ProcessDetailEvent,
): ProcessDetailState {
  switch (event.type) {
    case "snapshot":
      return { detail: event.detail, phase: "ready" };
    case "infoChanged":
      return current.detail
        ? {
          detail: { ...current.detail, info: event.info },
          phase: current.phase === "exited" ? "exited" : "ready",
        }
        : current;
    case "metadataChanged":
      return current.detail
        ? {
          detail: { ...current.detail, metadata: event.metadata },
          phase: current.phase === "exited" ? "exited" : "ready",
        }
        : current;
    case "usageChanged":
      return current.detail
        ? {
          detail: { ...current.detail, usage: event.usage },
          phase: current.phase === "exited" ? "exited" : "ready",
        }
        : current;
    case "exited":
      return { ...current, phase: "exited" };
  }
}

function applyProcessesEvent(
  currentRows: ProcessInfo[],
  event: ProcessesTableEvent,
): ProcessInfo[] {
  if (event.type === "snapshot") {
    return sortedProcesses(event.rows);
  }

  const rowsByPid = new Map(currentRows.map((row) => [row.pid, row]));
  for (const pid of event.removePids) {
    rowsByPid.delete(pid);
  }
  for (const row of event.upserts) {
    rowsByPid.set(row.pid, row);
  }
  return sortedProcesses([...rowsByPid.values()]);
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

function sortedProcesses(rows: ProcessInfo[]): ProcessInfo[] {
  return [...rows].sort((a, b) => a.pid - b.pid);
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
    children.sort((a, b) =>
      (a.name || "").localeCompare(b.name || "") || a.pid - b.pid
    );
  }

  const tree: ProcessTreeNode[] = [];
  const visited = new Set<number>();
  const appendChildren = (parentPid: number, depth: number) => {
    const children = childrenByParent.get(parentPid) ?? [];
    for (const process of children) {
      if (visited.has(process.pid)) continue;
      visited.add(process.pid);
      tree.push({ depth, process });
      appendChildren(process.pid, depth + 1);
    }
  };
  appendChildren(rootPid, 0);
  return tree;
}

function sortedProcessResourcesInUse(
  rows: ProcessResourceInUseInfo[],
): ProcessResourceInUseInfo[] {
  return [...rows].sort((a, b) =>
    processResourceInUseKindLabel(a.kind).localeCompare(
      processResourceInUseKindLabel(b.kind),
    ) || (a.name ?? "").localeCompare(b.name ?? "") ||
    a.resourceId.localeCompare(b.resourceId)
  );
}

function sortedProcessSocketsInUse(
  rows: ProcessSocketInUseInfo[],
): ProcessSocketInUseInfo[] {
  return [...rows].sort((a, b) =>
    processSocketInUseKindLabel(a.kind).localeCompare(
      processSocketInUseKindLabel(b.kind),
    ) || socketEndpointLabel(a.localEndpoint).localeCompare(
      socketEndpointLabel(b.localEndpoint),
    ) ||
    socketEndpointLabel(a.remoteEndpoint).localeCompare(
      socketEndpointLabel(b.remoteEndpoint),
    ) ||
    a.socketId.localeCompare(b.socketId)
  );
}

function sortedProcessModules(rows: ProcessModuleInfo[]): ProcessModuleInfo[] {
  return [...rows].sort((a, b) =>
    processModuleKindSortKey(a.kind) - processModuleKindSortKey(b.kind) ||
    a.name.localeCompare(b.name) ||
    (a.path ?? "").localeCompare(b.path ?? "") ||
    a.moduleId.localeCompare(b.moduleId)
  );
}

function isPathProcessResource(resource: ProcessResourceInUseInfo): boolean {
  if (!resource.name || resource.deleted) return false;
  return resource.kind === ProcessResourceInUseKind.File ||
    resource.kind === ProcessResourceInUseKind.Directory;
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
  return trimmed.split(/[\\/]+/).filter(Boolean).pop() ?? path;
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
  const milliseconds = Math.floor(durationMs % 1000).toString().padStart(
    3,
    "0",
  );
  const totalSeconds = Math.floor(durationMs / 1000);
  const seconds = (totalSeconds % 60).toString().padStart(2, "0");
  const minutes = Math.floor(totalSeconds / 60) % 60;
  const hours = Math.floor(totalSeconds / 3600);
  if (hours > 0) {
    return `${hours}h ${
      minutes.toString().padStart(2, "0")
    }m ${seconds}.${milliseconds}s`;
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
