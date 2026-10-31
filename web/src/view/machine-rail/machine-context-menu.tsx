import { createMemo } from "solid-js";
import {
  KeyRound,
  RefreshCw,
  Settings,
  Trash2,
  Unlink,
} from "../../solid/icons.tsx";
import type { Machine } from "../../state/machines.ts";
import { FloatingMenu, FloatingMenuItem } from "../ui/floating-menu.tsx";

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

export function MachineContextMenu(componentProps: MachineContextMenuProps) {
  const isPaired = createMemo(() =>
    Boolean(
      componentProps.machine.clientId && componentProps.machine.clientSecret,
    ),
  );

  return (
    <FloatingMenu
      className="z-[30] w-[176px]"
      position={{ left: componentProps.menu.x, top: componentProps.menu.y }}
    >
      <FloatingMenuItem onClick={() => componentProps.onReconnect()}>
        <RefreshCw size={15} />
        Reconnect
      </FloatingMenuItem>
      <FloatingMenuItem
        onClick={() => componentProps.onConfigure(componentProps.machine)}
      >
        <Settings size={15} />
        Configure
      </FloatingMenuItem>
      {!isPaired() ? (
        <FloatingMenuItem
          onClick={() => componentProps.onPair(componentProps.machine)}
        >
          <KeyRound size={15} />
          Pair
        </FloatingMenuItem>
      ) : (
        <FloatingMenuItem
          onClick={() => componentProps.onUnpair(componentProps.machine)}
        >
          <Unlink size={15} />
          Unpair
        </FloatingMenuItem>
      )}
      <FloatingMenuItem
        tone="danger"
        onClick={() => componentProps.onDelete(componentProps.machine)}
      >
        <Trash2 size={15} />
        Delete
      </FloatingMenuItem>
    </FloatingMenu>
  );
}
