import React from "react";
import { Plus } from "lucide-react";
import type { Machine } from "../../state/machines.ts";
import { className } from "../class-name.ts";
import { AppTooltip } from "../ui/tooltip.tsx";

interface MachineRailProps {
  machines: Machine[];
  projectLogoUrl: string;
  selectedId?: string;
  onAddMachine: () => void;
  onContextMenu: (
    event: React.MouseEvent<HTMLButtonElement>,
    machine: Machine,
  ) => void;
  onSelectMachine: (machineId: string) => void;
}

const machineRailClassName = [
  "[grid-column:1] [grid-row:2] grid [grid-template-rows:48px_minmax(0,1fr)_auto]",
  "justify-items-center gap-0 min-h-0 overflow-hidden bg-[var(--wgo-shell-bg)] p-0",
].join(" ");
const railBrandClassName = [
  "flex items-center justify-center w-[48px] h-[48px] overflow-visible",
  "[&_img]:block [&_img]:w-[48px] [&_img]:h-[48px] [&_img]:object-contain",
].join(" ");
const railListClassName = [
  "grid content-start justify-items-center gap-0",
  "w-full min-h-0 overflow-auto",
].join(" ");
const railItemFrameClassName = "grid h-[48px] w-full place-items-center";
const railMachineClassName = [
  "relative inline-flex appearance-none items-center justify-center w-[36px] min-w-[36px] h-[36px] min-h-[36px]",
  "cursor-pointer border-0 rounded-full bg-[var(--wgo-shell-item-bg)] text-[var(--wgo-shell-text)] p-0",
  "[font-family:inherit]",
  "[transition:border-radius_140ms_ease,background_140ms_ease,color_140ms_ease]",
  "hover:rounded-[13px] hover:bg-[var(--wgo-shell-item-bg)] hover:text-[var(--wgo-shell-text)]",
  "[&.active]:rounded-[13px] [&.active]:bg-[var(--wgo-accent)] [&.active]:text-[var(--wgo-text-inverse)]",
  "[&:hover_.rail-indicator]:h-[18px]",
  "[&.active_.rail-indicator]:h-[28px]",
].join(" ");
const railIndicatorClassName = [
  "rail-indicator absolute left-[-6px] w-[3px] h-0 rounded-[0_999px_999px_0]",
  "bg-[var(--wgo-bg-primary)] [transition:height_140ms_ease]",
].join(" ");
const machineAvatarClassName = "text-[12px] font-750 tracking-[0]";
const railActionClassName = [
  "relative inline-flex appearance-none items-center justify-center w-[36px] min-w-[36px] h-[36px] min-h-[36px]",
  "cursor-pointer border-0 rounded-full bg-[var(--wgo-shell-item-bg)] text-[var(--wgo-shell-success)] p-0",
  "[font-family:inherit]",
  "[transition:border-radius_140ms_ease,background_140ms_ease,color_140ms_ease]",
  "hover:rounded-[13px] hover:bg-[var(--wgo-accent)] hover:text-[var(--wgo-text-inverse)]",
].join(" ");
const railActionFrameClassName = "grid h-[48px] w-full place-items-center";
export function MachineRail(
  {
    machines,
    projectLogoUrl,
    selectedId,
    onAddMachine,
    onContextMenu,
    onSelectMachine,
  }: MachineRailProps,
) {
  return (
    <>
      <aside className={machineRailClassName} aria-label="Machine switcher">
        <div className={railBrandClassName} title="wgo">
          <img src={projectLogoUrl} alt="wgo" />
        </div>

        <nav className={railListClassName} aria-label="Machines">
          {machines.map((machine) => (
            <div key={machine.id} className={railItemFrameClassName}>
              <AppTooltip label={machine.name}>
                <button
                  type="button"
                  className={className(
                    railMachineClassName,
                    machine.id === selectedId && "active",
                  )}
                  onClick={() =>
                    onSelectMachine(machine.id)}
                  onContextMenu={(event) =>
                    onContextMenu(event, machine)}
                  aria-label={machine.name}
                >
                  <span className={railIndicatorClassName} />
                  <span className={machineAvatarClassName}>
                    {machineInitials(machine.name)}
                  </span>
                </button>
              </AppTooltip>
            </div>
          ))}
        </nav>

        <div className={railActionFrameClassName}>
          <button
            type="button"
            className={railActionClassName}
            onClick={onAddMachine}
            title="Add machine"
            aria-label="Add machine"
          >
            <Plus size={18} />
          </button>
        </div>
      </aside>
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
