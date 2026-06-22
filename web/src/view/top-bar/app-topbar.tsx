import { PanelLeftClose, PanelLeftOpen } from "lucide-react";
import type { Machine } from "../../state/machines.ts";
import type { ConnectionState } from "../../state/types.ts";
import { ConnectionPill } from "./connection-pill.tsx";

const globalTopbarClassName = [
  "[grid-column:2/-1] [grid-row:1] grid",
  "[grid-template-columns:minmax(0,1fr)_auto_minmax(0,1fr)]",
  "items-center gap-[14px] min-w-0 min-h-0 overflow-hidden",
  "bg-[#242832] text-[#d8dde7] px-[12px]",
].join(" ");
const globalTopbarLeftClassName = "flex items-center ml-[-8px] min-w-0";
const globalIconButtonClassName = [
  "inline-flex appearance-none items-center justify-center w-[26px] min-w-[26px] h-[24px] min-h-[24px]",
  "cursor-pointer border-0 rounded-[5px] bg-transparent text-[#cbd3df] p-0",
  "[font-family:inherit]",
  "hover:bg-[#343946] hover:text-white",
].join(" ");
const globalMachineTitleClassName = [
  "flex [grid-column:2] items-center min-w-0 text-[#f2f4f7]",
  "text-[12px] font-700",
  "[&_span]:min-w-0 [&_span]:overflow-hidden [&_span]:leading-[1.25]",
  "[&_span]:text-ellipsis [&_span]:whitespace-nowrap",
].join(" ");

interface AppTopbarProps {
  connection: ConnectionState;
  machine?: Machine;
  machinePanelCollapsed: boolean;
  onRefresh: () => void;
  onToggleMachinePanel: () => void;
}

export function AppTopbar(
  {
    connection,
    machine,
    machinePanelCollapsed,
    onRefresh,
    onToggleMachinePanel,
  }: AppTopbarProps,
) {
  return (
    <header className={globalTopbarClassName}>
      <div className={globalTopbarLeftClassName}>
        <button
          type="button"
          className={globalIconButtonClassName}
          onClick={onToggleMachinePanel}
          title={machinePanelCollapsed
            ? "Expand machine panel"
            : "Collapse machine panel"}
          aria-label={machinePanelCollapsed
            ? "Expand machine panel"
            : "Collapse machine panel"}
          aria-pressed={machinePanelCollapsed}
        >
          {machinePanelCollapsed
            ? <PanelLeftOpen size={14} />
            : <PanelLeftClose size={14} />}
        </button>
      </div>
      <div className={globalMachineTitleClassName}>
        <span>{machine?.name ?? "No machine"}</span>
      </div>
      <ConnectionPill
        machine={machine}
        connection={connection}
        onRefresh={onRefresh}
      />
    </header>
  );
}
