import { KeyRound, RefreshCw, Settings, Trash2, Unlink } from "lucide-react";
import type { Machine } from "../../state/machines.ts";

const machineContextMenuClassName = [
  "fixed z-[30] grid gap-[2px] w-[176px] border border-[#d8dde7]",
  "rounded-[8px] bg-white [box-shadow:0_18px_48px_rgb(32_36_45_/_24%)] p-[6px]",
  "[&_button]:justify-start [&_button]:w-full [&_button]:min-h-[34px]",
  "[&_button]:border-0 [&_button]:rounded-[6px] [&_button]:bg-transparent",
  "[&_button]:px-[10px] [&_button]:text-[#20242d]",
  "[&_button:hover]:bg-[#f2f6ff]",
  "[&_button.danger]:text-[#b42318]",
  "[&_button.danger:hover]:bg-[#fff2f0]",
].join(" ");

export interface MachineMenuPosition {
  x: number;
  y: number;
}

interface MachineContextMenuProps {
  machine: Machine;
  menu: MachineMenuPosition;
  onConfigure: (machine: Machine) => void;
  onDelete: (machine: Machine) => void;
  onPair: (machine: Machine) => void;
  onReconnect: () => void;
  onUnpair: (machine: Machine) => void;
}

export function MachineContextMenu(
  {
    machine,
    menu,
    onConfigure,
    onDelete,
    onPair,
    onReconnect,
    onUnpair,
  }: MachineContextMenuProps,
) {
  const isPaired = Boolean(machine.clientId && machine.clientSecret);

  return (
    <div
      className={machineContextMenuClassName}
      style={{ left: menu.x, top: menu.y }}
      role="menu"
      onMouseDown={(event) => event.stopPropagation()}
    >
      <button
        type="button"
        role="menuitem"
        onClick={onReconnect}
      >
        <RefreshCw size={15} />
        Reconnect
      </button>
      <button
        type="button"
        role="menuitem"
        onClick={() => onConfigure(machine)}
      >
        <Settings size={15} />
        Configure
      </button>
      {!isPaired
        ? (
          <button
            type="button"
            role="menuitem"
            onClick={() => onPair(machine)}
          >
            <KeyRound size={15} />
            Pair
          </button>
        )
        : (
          <button
            type="button"
            role="menuitem"
            onClick={() => onUnpair(machine)}
          >
            <Unlink size={15} />
            Unpair
          </button>
        )}
      <button
        type="button"
        role="menuitem"
        className="danger"
        onClick={() => onDelete(machine)}
      >
        <Trash2 size={15} />
        Delete
      </button>
    </div>
  );
}
