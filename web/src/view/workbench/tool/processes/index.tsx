import { useEffect, useRef, useState } from "react";
import { useAtomValue } from "jotai";
import { useBunja } from "bunja/react";
import { nowBunja } from "unsaturated/now";
import { Activity, HardDrive, KeyRound, Loader2 } from "lucide-react";
import {
  subscribeProcessDetail,
  subscribeProcesses,
} from "../../../../protocol/generated/client.ts";
import {
  type ProcessDetail,
  type ProcessDetailEvent,
  type ProcessesTableEvent,
  type ProcessInfo,
  ProcessStatus,
  ProcId,
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

  const processListSupported = daemonInfo.phase === "ready" &&
    daemonInfo.daemonInfo.supportedProcIds.includes(ProcId.SubscribeProcesses);
  const processDetailSupported = daemonInfo.phase === "ready" &&
    daemonInfo.daemonInfo.supportedProcIds.includes(
      ProcId.SubscribeProcessDetail,
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
        selectedPid={selectedPid}
        onOpenRoot={() => tabState.setProcessDetailPid(undefined)}
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
        : (
          <ProcessDetailView
            daemonInfoPhase={daemonInfo.phase}
            machineId={machine.id}
            pid={selectedPid}
            rpcSession={rpcSession}
            supported={processDetailSupported}
          />
        )}
    </section>
  );
}

interface ProcessesBreadcrumbProps {
  selectedPid?: number;
  onOpenRoot: () => void;
}

function ProcessesBreadcrumb(
  { selectedPid, onOpenRoot }: ProcessesBreadcrumbProps,
) {
  return (
    <Breadcrumb
      ariaLabel="Process location"
      className="flex-[0_0_auto] border-b border-b-[#d8dde7] bg-[#fbfcfe] px-[0.5rem]"
      items={[
        {
          label: "Processes",
          onClick: selectedPid === undefined ? undefined : onOpenRoot,
        },
        {
          label: selectedPid === undefined ? "Overview" : `PID ${selectedPid}`,
          muted: selectedPid === undefined,
        },
      ]}
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
              className={processRowClassName}
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

interface ProcessDetailViewProps {
  daemonInfoPhase: string;
  machineId: string;
  pid: number;
  rpcSession: ProcessesRpcSession;
  supported: boolean;
}

function ProcessDetailView(
  {
    daemonInfoPhase,
    machineId,
    pid,
    rpcSession,
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
      <ProcessDetailSummary detail={state.detail} />
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
}

function ProcessDetailSummary({ detail }: ProcessDetailSummaryProps) {
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
        <ProcessResourceUsageTable usage={usage} />
      </div>
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

function sortedProcesses(rows: ProcessInfo[]): ProcessInfo[] {
  return [...rows].sort((a, b) => a.pid - b.pid);
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
