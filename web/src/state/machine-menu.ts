import { bunja } from "bunja";
import { atom } from "jotai";
import { JotaiStoreScope } from "./jotai-store.ts";
import { machineStoreBunja } from "./machine-store.ts";
import { MachineMenuState, RailTooltipState } from "./types.ts";

export const machineMenuBunja = bunja(() => {
  const store = bunja.use(JotaiStoreScope);
  const machines = bunja.use(machineStoreBunja);

  const machineMenuAtom = atom<MachineMenuState | undefined>(undefined);
  const railTooltipAtom = atom<RailTooltipState | undefined>(undefined);
  const menuMachineAtom = atom((get) =>
    get(machines.machinesAtom).find((machine) =>
      machine.id === get(machineMenuAtom)?.machineId
    )
  );

  function openMachineMenu(machineId: string, x: number, y: number) {
    store.set(railTooltipAtom, undefined);
    machines.selectMachine(machineId);
    store.set(machineMenuAtom, {
      machineId,
      x: Math.max(8, Math.min(x, globalThis.innerWidth - 190)),
      y: Math.max(8, Math.min(y, globalThis.innerHeight - 150)),
    });
  }

  function closeMachineMenu() {
    store.set(machineMenuAtom, undefined);
  }

  function selectMachine(machineId: string) {
    store.set(railTooltipAtom, undefined);
    store.set(machineMenuAtom, undefined);
    machines.selectMachine(machineId);
  }

  function showRailTooltip(name: string, x: number, y: number) {
    store.set(railTooltipAtom, { name, x, y });
  }

  function hideRailTooltip() {
    store.set(railTooltipAtom, undefined);
  }

  return {
    machineMenuAtom,
    menuMachineAtom,
    railTooltipAtom,
    openMachineMenu,
    closeMachineMenu,
    selectMachine,
    showRailTooltip,
    hideRailTooltip,
  };
});
