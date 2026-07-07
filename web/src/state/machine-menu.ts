import { bunja } from "bunja";
import { atom } from "jotai";
import { JotaiStoreScope } from "unsaturated/store";
import { machineStoreBunja } from "./machine-store.ts";
import { MachineMenuState } from "./types.ts";

export const machineMenuBunja = bunja(() => {
  const store = bunja.use(JotaiStoreScope);
  const machines = bunja.use(machineStoreBunja);

  const machineMenuAtom = atom<MachineMenuState | undefined>(undefined);
  const menuMachineAtom = atom((get) =>
    get(machines.machinesAtom).find((machine) =>
      machine.id === get(machineMenuAtom)?.machineId
    )
  );

  function openMachineMenu(machineId: string, x: number, y: number) {
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
    store.set(machineMenuAtom, undefined);
    machines.selectMachine(machineId);
  }

  return {
    machineMenuAtom,
    menuMachineAtom,
    openMachineMenu,
    closeMachineMenu,
    selectMachine,
  };
});
