import { createMemo } from "solid-js";

import { ChevronDown, Loader2, Wifi, WifiOff } from "../../solid/icons.tsx";
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
    event: MouseEvent & { currentTarget: HTMLButtonElement },
    machine: Machine,
  ) => void;
  onResizeKeyDown: (
    event: KeyboardEvent & { currentTarget: HTMLDivElement },
  ) => void;
  onResizePointerDown: (
    event: PointerEvent & { currentTarget: HTMLDivElement },
  ) => void;
}

const machinePanelClassName = [
  "machine-panel relative [grid-column:2] [grid-row:1] grid",
  "[grid-template-rows:auto_minmax(0,1fr)] min-w-0 min-h-0 overflow-hidden",
  "border-r border-r-rieul-border bg-[rgba(242,242,243,0.74)] backdrop-blur-xl",
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
  "grid h-[54px] min-h-[54px] border-b border-b-rieul-border px-[10px]",
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
  "cursor-pointer border border-transparent rounded-rieul-sm bg-transparent text-rieul-text",
  "px-[6px] text-[14px] font-700 leading-none tracking-[0] [font-family:inherit]",
  "hover:bg-white/28 active:bg-rieul-active [&_svg]:flex-[0_0_auto]",
].join(" ");
const machineTitleTextClassName = [
  "machine-title-text block flex-[1_1_auto] min-w-0 overflow-hidden",
  "leading-[1.25] text-ellipsis whitespace-nowrap",
].join(" ");
const machineTitleStatusIconClassName = "flex-[0_0_auto] [stroke-width:2.4]";
const machineConnectionLineClassName = [
  "ml-[6px] flex min-w-0 items-center gap-[6px]",
  "text-[12px] font-650 text-rieul-text-3",
].join(" ");
const machineConnectionDotClassName = ["h-[6px] w-[6px] rounded-full"].join(
  " ",
);
const machineContextClassName = [
  "grid content-start gap-[10px] px-[10px] py-[12px]",
  "text-[12px] text-rieul-text-3",
  "max-[680px]:hidden",
].join(" ");
const machineContextRowClassName = [
  "grid min-h-[30px] grid-cols-[72px_minmax(0,1fr)] items-center gap-[8px]",
  "border-b border-b-white/26 px-[6px]",
].join(" ");
const machineContextLabelClassName = "font-650 text-rieul-text-3";
const machineContextValueClassName =
  "min-w-0 overflow-hidden text-right text-ellipsis whitespace-nowrap font-700 text-rieul-text-2";
const machinePanelResizerClassName = [
  "absolute top-0 right-[-4px] bottom-0 z-[8] w-[8px] cursor-col-resize touch-none",
  "after:content-[''] after:absolute after:top-0 after:bottom-0 after:left-[3px]",
  "after:w-[1px] after:bg-transparent",
  "hover:after:w-[2px] hover:after:bg-rieul-accent",
  "focus-visible:after:w-[2px] focus-visible:after:bg-rieul-accent focus-visible:outline-0",
  "max-[680px]:hidden",
].join(" ");

export function MachinePanel(componentProps: MachinePanelProps) {
  return (
    <aside
      class={machinePanelClassName}
      aria-label="Machine workspace"
      aria-hidden={componentProps.machinePanelCollapsed ? "true" : "false"}
      inert={componentProps.machinePanelCollapsed ? true : undefined}
    >
      <div class={machinePanelInnerClassName}>
        <section class={machinePanelSummaryClassName}>
          <div class={machineTitleClassName}>
            <h1>
              {componentProps.machine ? (
                <button
                  type="button"
                  class={[
                    machineTitleButtonClassName,
                    componentProps.connection.phase === "idle"
                      ? "checking"
                      : "",
                  ]
                    .filter(Boolean)
                    .join(" ")}
                  onMouseDown={(event) => event.stopPropagation()}
                  onClick={(event) =>
                    componentProps.onOpenMachineMenu(
                      event,
                      componentProps.machine!,
                    )
                  }
                  title="Machine actions"
                  aria-label={`${componentProps.machine.name} machine actions`}
                  tabindex={
                    componentProps.machinePanelCollapsed ? -1 : undefined
                  }
                >
                  <span class={machineTitleTextClassName}>
                    {componentProps.machine.name}
                  </span>
                  <MachineTitleStatus connection={componentProps.connection} />
                  <ChevronDown size={16} />
                </button>
              ) : (
                "No machine"
              )}
            </h1>
            <MachineConnectionLine
              connection={componentProps.connection}
              machine={componentProps.machine}
            />
          </div>
        </section>

        <MachineContext
          machine={componentProps.machine}
          connection={componentProps.connection}
        />
      </div>
      <div
        class={machinePanelResizerClassName}
        role="separator"
        aria-label="Resize machine panel"
        aria-orientation="vertical"
        aria-valuemin={componentProps.machinePanelMinWidth}
        aria-valuemax={componentProps.machinePanelMaxWidth}
        aria-valuenow={componentProps.machinePanelWidth}
        tabindex={componentProps.machinePanelCollapsed ? -1 : 0}
        onPointerDown={(event) => componentProps.onResizePointerDown(event)}
        onKeyDown={(event) => componentProps.onResizeKeyDown(event)}
      />
    </aside>
  );
}

function MachineContext(
  componentProps: MachineTitleStatusProps & { machine?: Machine },
) {
  return (
    <div class={machineContextClassName} aria-label="Machine context">
      <ContextRow
        label="Target"
        value={componentProps.machine?.name ?? "No machine"}
      />
      <ContextRow
        label="Transport"
        value={connectionTransport(componentProps.connection)}
      />
      <ContextRow
        label="Endpoint"
        value={
          componentProps.machine?.baseUrl.replace(/^https?:\/\//, "") ?? "-"
        }
      />
    </div>
  );
}

function ContextRow(componentProps: { label: string; value: string }) {
  return (
    <div class={machineContextRowClassName}>
      <span class={machineContextLabelClassName}>{componentProps.label}</span>
      <span class={machineContextValueClassName}>{componentProps.value}</span>
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
  componentProps: MachineTitleStatusProps & { machine?: Machine },
) {
  const text = createMemo(() =>
    !componentProps.machine
      ? "No target"
      : componentProps.connection.phase === "reachable"
        ? "Connected"
        : componentProps.connection.phase === "idle"
          ? "Connecting"
          : "Offline",
  );
  const tone = createMemo(() =>
    !componentProps.machine
      ? "bg-rieul-muted"
      : componentProps.connection.phase === "reachable"
        ? "bg-rieul-success"
        : componentProps.connection.phase === "idle"
          ? "bg-rieul-warning"
          : "bg-rieul-danger",
  );
  return (
    <div class={machineConnectionLineClassName}>
      <span class={`${machineConnectionDotClassName} ${tone()}`} />
      <span>{text()}</span>
    </div>
  );
}

interface MachineTitleStatusProps {
  connection: ConnectionState;
}

function MachineTitleStatus(props: MachineTitleStatusProps) {
  return (
    <>
      {props.connection.phase === "reachable" ? (
        <Wifi
          size={14}
          className={`${machineTitleStatusIconClassName} text-rieul-success`}
          aria-label="Connected"
        />
      ) : props.connection.phase === "idle" ? (
        <Loader2
          size={14}
          className={`${machineTitleStatusIconClassName} animate-spin text-rieul-warning`}
          aria-label="Connecting"
        />
      ) : (
        <WifiOff
          size={14}
          className={`${machineTitleStatusIconClassName} text-rieul-danger`}
          aria-label="Unconnected"
        />
      )}
    </>
  );
}
