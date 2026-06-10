import { PanelLeftClose, PanelLeftOpen } from "lucide-react";
import type { Machine } from "../../state/machines.ts";
import type { ConnectionState } from "../../state/types.ts";
import { ConnectionPill } from "./connection-pill.tsx";

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
    <header className="global-topbar">
      <div className="global-topbar-left">
        <button
          type="button"
          className="global-icon-button"
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
      <div className="global-machine-title">
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
