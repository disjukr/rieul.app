import { KeyRound, RefreshCw, Settings, Trash2 } from "lucide-react";
import type { Machine } from "../../state/machines.ts";

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
}

export function MachineContextMenu(
  {
    machine,
    menu,
    onConfigure,
    onDelete,
    onPair,
    onReconnect,
  }: MachineContextMenuProps,
) {
  return (
    <div
      className="machine-context-menu"
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
      {!(machine.clientId && machine.clientSecret)
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
        : null}
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
