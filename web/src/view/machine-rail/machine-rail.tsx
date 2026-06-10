import React from "react";
import { Plus } from "lucide-react";
import type { Machine } from "../../state/machines.ts";

export interface RailTooltip {
  name: string;
  x: number;
  y: number;
}

interface MachineRailProps {
  machines: Machine[];
  projectLogoUrl: string;
  railTooltip?: RailTooltip;
  selectedId?: string;
  onAddMachine: () => void;
  onContextMenu: (
    event: React.MouseEvent<HTMLButtonElement>,
    machine: Machine,
  ) => void;
  onHideTooltip: () => void;
  onSelectMachine: (machineId: string) => void;
  onShowTooltip: (target: HTMLElement, name: string) => void;
}

export function MachineRail(
  {
    machines,
    projectLogoUrl,
    railTooltip,
    selectedId,
    onAddMachine,
    onContextMenu,
    onHideTooltip,
    onSelectMachine,
    onShowTooltip,
  }: MachineRailProps,
) {
  return (
    <>
      <aside className="machine-rail" aria-label="Machine switcher">
        <div className="rail-brand" title="wgo">
          <img src={projectLogoUrl} alt="wgo" />
        </div>

        <nav className="rail-list" aria-label="Machines">
          {machines.map((machine) => (
            <button
              type="button"
              key={machine.id}
              className={machine.id === selectedId
                ? "rail-machine active"
                : "rail-machine"}
              onClick={() => onSelectMachine(machine.id)}
              onMouseEnter={(event) =>
                onShowTooltip(event.currentTarget, machine.name)}
              onMouseLeave={onHideTooltip}
              onFocus={(event) =>
                onShowTooltip(event.currentTarget, machine.name)}
              onBlur={onHideTooltip}
              onContextMenu={(event) => onContextMenu(event, machine)}
              aria-label={machine.name}
            >
              <span className="rail-indicator" />
              <span className="machine-avatar">
                {machineInitials(machine.name)}
              </span>
            </button>
          ))}
        </nav>

        <button
          type="button"
          className="rail-action"
          onClick={onAddMachine}
          title="Add machine"
          aria-label="Add machine"
        >
          <Plus size={22} />
        </button>
      </aside>

      {railTooltip
        ? (
          <div
            className="rail-tooltip"
            style={{ left: railTooltip.x, top: railTooltip.y }}
            role="tooltip"
          >
            {railTooltip.name}
          </div>
        )
        : null}
    </>
  );
}

function machineInitials(name: string): string {
  const letters = name
    .split(/[\s._-]+/)
    .map((part) => part.trim()[0])
    .filter(Boolean)
    .join("")
    .slice(0, 2)
    .toUpperCase();
  return letters || "PC";
}
