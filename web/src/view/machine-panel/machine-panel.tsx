import React from "react";
import { ChevronDown, Loader2, Wifi, WifiOff } from "lucide-react";
import type { Machine } from "../../state/machines.ts";
import type { ConnectionState } from "../../state/types.ts";

interface MachinePanelProps {
  connection: ConnectionState;
  machine?: Machine;
  machinePanelCollapsed: boolean;
  machinePanelMaxWidth: number;
  machinePanelMinWidth: number;
  machinePanelWidth: number;
  onOpenMachineMenu: (
    event: React.MouseEvent<HTMLButtonElement>,
    machine: Machine,
  ) => void;
  onResizeKeyDown: (event: React.KeyboardEvent<HTMLDivElement>) => void;
  onResizePointerDown: (event: React.PointerEvent<HTMLDivElement>) => void;
}

const machinePanelClassName = [
  "machine-panel relative [grid-column:2] [grid-row:1] grid",
  "[grid-template-rows:auto_minmax(0,1fr)] min-w-0 min-h-0 overflow-hidden",
  "border-r border-r-wgo-border bg-[rgba(242,242,243,0.74)] backdrop-blur-xl",
  "shadow-[inset_-1px_0_0_rgba(255,255,255,0.54)] transition-[border-color,border-radius] duration-150 ease-out",
  "max-[680px]:hidden",
].join(" ");
const machinePanelInnerClassName = [
  "grid h-full min-h-0 w-[var(--machine-panel-open-width,264px)]",
  "min-w-[var(--machine-panel-open-width,264px)]",
  "[grid-template-rows:auto_minmax(0,1fr)]",
  "max-[680px]:w-full max-[680px]:min-w-0 max-[680px]:[grid-template-rows:minmax(0,1fr)]",
].join(" ");
const machinePanelSummaryClassName = [
  "grid h-[54px] min-h-[54px] border-b border-b-wgo-border px-[10px]",
  "bg-[rgba(255,255,255,0.24)]",
  "max-[680px]:hidden",
].join(" ");
const machineTitleClassName = [
  "grid content-center min-w-0 gap-[3px]",
  "[&_h1]:flex [&_h1]:items-center [&_h1]:m-0 [&_h1]:min-w-0",
].join(" ");
const machineTitleButtonClassName = [
  "machine-title-button inline-flex appearance-none items-center justify-start gap-[0.5rem]",
  "h-[28px] max-w-full min-h-[28px] overflow-visible",
  "cursor-pointer border border-transparent rounded-wgo-sm bg-transparent text-wgo-text",
  "px-[6px] text-[14px] font-700 leading-none tracking-[0] [font-family:inherit]",
  "hover:bg-white/28 active:bg-wgo-active [&_svg]:flex-[0_0_auto]",
].join(" ");
const machineTitleTextClassName = [
  "machine-title-text block flex-[1_1_auto] min-w-0 overflow-hidden",
  "leading-[1.25] text-ellipsis whitespace-nowrap",
].join(" ");
const machineTitleStatusIconClassName = "flex-[0_0_auto] [stroke-width:2.4]";
const machineConnectionLineClassName = [
  "ml-[6px] flex min-w-0 items-center gap-[6px]",
  "text-[12px] font-650 text-wgo-text-3",
].join(" ");
const machineConnectionDotClassName = [
  "h-[6px] w-[6px] rounded-full",
].join(" ");
const machineContextClassName = [
  "grid content-start gap-[10px] px-[10px] py-[12px]",
  "text-[12px] text-wgo-text-3",
  "max-[680px]:hidden",
].join(" ");
const machineContextRowClassName = [
  "grid min-h-[30px] grid-cols-[72px_minmax(0,1fr)] items-center gap-[8px]",
  "border-b border-b-white/26 px-[6px]",
].join(" ");
const machineContextLabelClassName = "font-650 text-wgo-text-3";
const machineContextValueClassName =
  "min-w-0 overflow-hidden text-right text-ellipsis whitespace-nowrap font-700 text-wgo-text-2";
const machinePanelResizerClassName = [
  "absolute top-0 right-[-4px] bottom-0 z-[8] w-[8px] cursor-col-resize touch-none",
  "after:content-[''] after:absolute after:top-0 after:bottom-0 after:left-[3px]",
  "after:w-[1px] after:bg-transparent",
  "hover:after:w-[2px] hover:after:bg-wgo-accent",
  "focus-visible:after:w-[2px] focus-visible:after:bg-wgo-accent focus-visible:outline-0",
  "max-[680px]:hidden",
].join(" ");

export function MachinePanel(
  {
    connection,
    machine,
    machinePanelCollapsed,
    machinePanelMaxWidth,
    machinePanelMinWidth,
    machinePanelWidth,
    onOpenMachineMenu,
    onResizeKeyDown,
    onResizePointerDown,
  }: MachinePanelProps,
) {
  return (
    <aside
      className={machinePanelClassName}
      aria-label="Machine workspace"
      aria-hidden={machinePanelCollapsed}
      inert={machinePanelCollapsed ? true : undefined}
    >
      <div className={machinePanelInnerClassName}>
        <section className={machinePanelSummaryClassName}>
          <div className={machineTitleClassName}>
            <h1>
              {machine
                ? (
                  <button
                    type="button"
                    className={[
                      machineTitleButtonClassName,
                      connection.phase === "idle" ? "checking" : "",
                    ].filter(Boolean).join(" ")}
                    onMouseDown={(event) => event.stopPropagation()}
                    onClick={(event) => onOpenMachineMenu(event, machine)}
                    title="Machine actions"
                    aria-label={`${machine.name} machine actions`}
                    tabIndex={machinePanelCollapsed ? -1 : undefined}
                  >
                    <span className={machineTitleTextClassName}>
                      {machine.name}
                    </span>
                    <MachineTitleStatus connection={connection} />
                    <ChevronDown size={16} />
                  </button>
                )
                : "No machine"}
            </h1>
            <MachineConnectionLine connection={connection} machine={machine} />
          </div>
        </section>

        <MachineContext machine={machine} connection={connection} />
      </div>
      <div
        className={machinePanelResizerClassName}
        role="separator"
        aria-label="Resize machine panel"
        aria-orientation="vertical"
        aria-valuemin={machinePanelMinWidth}
        aria-valuemax={machinePanelMaxWidth}
        aria-valuenow={machinePanelWidth}
        tabIndex={machinePanelCollapsed ? -1 : 0}
        onPointerDown={onResizePointerDown}
        onKeyDown={onResizeKeyDown}
      />
    </aside>
  );
}

function MachineContext(
  { connection, machine }: MachineTitleStatusProps & { machine?: Machine },
) {
  return (
    <div className={machineContextClassName} aria-label="Machine context">
      <ContextRow label="Target" value={machine?.name ?? "No machine"} />
      <ContextRow label="Transport" value={connectionTransport(connection)} />
      <ContextRow
        label="Endpoint"
        value={machine?.baseUrl.replace(/^https?:\/\//, "") ?? "-"}
      />
    </div>
  );
}

function ContextRow({ label, value }: { label: string; value: string }) {
  return (
    <div className={machineContextRowClassName}>
      <span className={machineContextLabelClassName}>{label}</span>
      <span className={machineContextValueClassName}>{value}</span>
    </div>
  );
}

function connectionTransport(connection: ConnectionState): string {
  switch (connection.phase) {
    case "reachable":
      return "WebTransport";
    case "idle":
      return "Checking";
    case "offline":
      return "Unavailable";
  }
}

function MachineConnectionLine(
  { connection, machine }: MachineTitleStatusProps & { machine?: Machine },
) {
  const text = !machine
    ? "No target"
    : connection.phase === "reachable"
    ? "Connected"
    : connection.phase === "idle"
    ? "Connecting"
    : "Offline";
  const tone = !machine
    ? "bg-wgo-muted"
    : connection.phase === "reachable"
    ? "bg-wgo-success"
    : connection.phase === "idle"
    ? "bg-wgo-warning"
    : "bg-wgo-danger";
  return (
    <div className={machineConnectionLineClassName}>
      <span className={`${machineConnectionDotClassName} ${tone}`} />
      <span>{text}</span>
    </div>
  );
}

interface MachineTitleStatusProps {
  connection: ConnectionState;
}

function MachineTitleStatus({ connection }: MachineTitleStatusProps) {
  switch (connection.phase) {
    case "reachable":
      return (
        <Wifi
          size={14}
          className={`${machineTitleStatusIconClassName} text-wgo-success`}
          aria-label="Connected"
        />
      );
    case "idle":
      return (
        <Loader2
          size={14}
          className={`${machineTitleStatusIconClassName} animate-spin text-wgo-warning`}
          aria-label="Connecting"
        />
      );
    case "offline":
      return (
        <WifiOff
          size={14}
          className={`${machineTitleStatusIconClassName} text-wgo-danger`}
          aria-label="Unconnected"
        />
      );
  }
}
