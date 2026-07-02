import React from "react";
import { Plus } from "lucide-react";
import type { Machine } from "../../state/machines.ts";
import { className } from "../class-name.ts";

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

const machineRailClassName = [
  "[grid-column:1] [grid-row:2] grid [grid-template-rows:48px_minmax(0,1fr)_auto]",
  "justify-items-center gap-0 min-h-0 overflow-hidden bg-[#242832] p-0",
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
  "cursor-pointer border-0 rounded-full bg-[#343946] text-[#d8dde7] p-0",
  "[font-family:inherit]",
  "[transition:border-radius_140ms_ease,background_140ms_ease,color_140ms_ease]",
  "hover:rounded-[13px] hover:bg-[#343946] hover:text-[#d8dde7]",
  "[&.active]:rounded-[13px] [&.active]:bg-[#4f8cff] [&.active]:text-white",
  "[&:hover_.rail-indicator]:h-[18px]",
  "[&.active_.rail-indicator]:h-[28px]",
].join(" ");
const railIndicatorClassName = [
  "rail-indicator absolute left-[-6px] w-[3px] h-0 rounded-[0_999px_999px_0]",
  "bg-white [transition:height_140ms_ease]",
].join(" ");
const machineAvatarClassName = "text-[12px] font-750 tracking-[0]";
const railActionClassName = [
  "relative inline-flex appearance-none items-center justify-center w-[36px] min-w-[36px] h-[36px] min-h-[36px]",
  "cursor-pointer border-0 rounded-full bg-[#343946] text-[#38b86f] p-0",
  "[font-family:inherit]",
  "[transition:border-radius_140ms_ease,background_140ms_ease,color_140ms_ease]",
  "hover:rounded-[13px] hover:bg-[#4f8cff] hover:text-white",
].join(" ");
const railActionFrameClassName = "grid h-[48px] w-full place-items-center";
const railTooltipClassName = [
  "fixed z-[40] translate-y-[-50%] rounded-[6px] bg-[#101828] text-white",
  "[box-shadow:0_12px_32px_rgb(16_24_40_/_24%)]",
  "px-[9px] py-[6px] text-[12px] font-650 leading-none whitespace-nowrap pointer-events-none",
  "before:content-[''] before:absolute before:top-1/2 before:left-[-5px]",
  "before:w-[10px] before:h-[10px] before:bg-[#101828]",
  "before:[transform:translateY(-50%)_rotate(45deg)]",
].join(" ");

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
      <aside className={machineRailClassName} aria-label="Machine switcher">
        <div className={railBrandClassName} title="wgo">
          <img src={projectLogoUrl} alt="wgo" />
        </div>

        <nav className={railListClassName} aria-label="Machines">
          {machines.map((machine) => (
            <div key={machine.id} className={railItemFrameClassName}>
              <button
                type="button"
                className={className(
                  railMachineClassName,
                  machine.id === selectedId && "active",
                )}
                onClick={() =>
                  onSelectMachine(machine.id)}
                onMouseEnter={(event) =>
                  onShowTooltip(event.currentTarget, machine.name)}
                onMouseLeave={onHideTooltip}
                onFocus={(event) =>
                  onShowTooltip(event.currentTarget, machine.name)}
                onBlur={onHideTooltip}
                onContextMenu={(event) =>
                  onContextMenu(event, machine)}
                aria-label={machine.name}
              >
                <span className={railIndicatorClassName} />
                <span className={machineAvatarClassName}>
                  {machineInitials(machine.name)}
                </span>
              </button>
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

      {railTooltip
        ? (
          <div
            className={railTooltipClassName}
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
