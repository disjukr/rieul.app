import React from "react";
import { ChevronDown, WifiOff } from "lucide-react";
import type { Machine } from "../../state/machines.ts";
import type { ConnectionState } from "../../state/types.ts";
import type { WorkbenchTool } from "../../state/workbench.ts";
import { ToolMenu } from "./tool-menu.tsx";

interface MachinePanelProps {
  activeTool: WorkbenchTool;
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
  onSelectTool: (tool: WorkbenchTool) => void;
}

export function MachinePanel(
  {
    activeTool,
    connection,
    machine,
    machinePanelCollapsed,
    machinePanelMaxWidth,
    machinePanelMinWidth,
    machinePanelWidth,
    onOpenMachineMenu,
    onResizeKeyDown,
    onResizePointerDown,
    onSelectTool,
  }: MachinePanelProps,
) {
  return (
    <aside
      className="machine-panel"
      aria-label="Machine workspace"
      aria-hidden={machinePanelCollapsed}
    >
      {!machinePanelCollapsed
        ? (
          <>
            <section className="machine-panel-summary">
              <div className="machine-title">
                <h1>
                  {machine
                    ? (
                      <button
                        type="button"
                        className={[
                          "machine-title-button",
                          connection.phase === "checking" ? "checking" : "",
                        ].filter(Boolean).join(" ")}
                        onMouseDown={(event) => event.stopPropagation()}
                        onClick={(event) => onOpenMachineMenu(event, machine)}
                        title="Machine actions"
                        aria-label={`${machine.name} machine actions`}
                      >
                        <span className="machine-title-text">
                          {machine.name}
                        </span>
                        {connection.phase === "offline"
                          ? (
                            <WifiOff
                              size={14}
                              className="machine-title-connection-indicator"
                              aria-hidden="true"
                            />
                          )
                          : null}
                        <ChevronDown size={16} />
                      </button>
                    )
                    : "No machine"}
                </h1>
              </div>
            </section>

            <ToolMenu
              activeTool={activeTool}
              onSelect={onSelectTool}
            />
            <div
              className="machine-panel-resizer"
              role="separator"
              aria-label="Resize machine panel"
              aria-orientation="vertical"
              aria-valuemin={machinePanelMinWidth}
              aria-valuemax={machinePanelMaxWidth}
              aria-valuenow={machinePanelWidth}
              tabIndex={0}
              onPointerDown={onResizePointerDown}
              onKeyDown={onResizeKeyDown}
            />
          </>
        )
        : null}
    </aside>
  );
}
