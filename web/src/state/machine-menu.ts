import { createSignal, createMemo } from "solid-js";
import { bunja } from "bunja";
import { machineStoreBunja } from "./machine-store.ts";
import { MachineMenuState } from "./types.ts";
export const machineMenuBunja = bunja(() => {
  const machines = bunja.use(machineStoreBunja);
  const [machineMenu, setMachineMenu] = createSignal<
    MachineMenuState | undefined
  >(undefined);
  const menuMachine = createMemo(() =>
    machines
      .machines()
      .find((machine) => machine.id === machineMenu()?.machineId),
  );
  function openMachineMenu(machineId: string, x: number, y: number) {
    machines.selectMachine(machineId);
    setMachineMenu({
      machineId,
      x: Math.max(8, Math.min(x, globalThis.innerWidth - 190)),
      y: Math.max(8, Math.min(y, globalThis.innerHeight - 150)),
    });
  }
  function closeMachineMenu() {
    setMachineMenu(undefined);
  }
  function selectMachine(machineId: string) {
    setMachineMenu(undefined);
    machines.selectMachine(machineId);
  }
  return {
    machineMenu,
    menuMachine,
    openMachineMenu,
    closeMachineMenu,
    selectMachine,
  };
});
