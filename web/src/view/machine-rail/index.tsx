import React, { useEffect } from "react";
import { useAtomValue } from "jotai";
import { useBunja } from "bunja/react";
import { connectionBunja } from "../../state/connection.ts";
import { machineMenuBunja } from "../../state/machine-menu.ts";
import { machineModalBunja } from "../../state/machine-modal.ts";
import { machineStoreBunja } from "../../state/machine-store.ts";
import type { Machine } from "../../state/machines.ts";
import { MachineContextMenu } from "./machine-context-menu.tsx";
import { MachineRail } from "./machine-rail.tsx";

const projectLogoUrl = new URL(
  "../../assets/wgo.svg",
  import.meta.url,
).href;

export function MachineRailRegion() {
  const machineStore = useBunja(machineStoreBunja);
  const machineMenuState = useBunja(machineMenuBunja);
  const machineModal = useBunja(machineModalBunja);
  const connectionState = useBunja(connectionBunja);
  const machines = useAtomValue(machineStore.machinesAtom);
  const selectedId = useAtomValue(machineStore.selectedIdAtom);
  const machineMenu = useAtomValue(machineMenuState.machineMenuAtom);
  const menuMachine = useAtomValue(machineMenuState.menuMachineAtom);
  const railTooltip = useAtomValue(machineMenuState.railTooltipAtom);

  useEffect(() => {
    if (!machineMenu) return;

    function closeMenu() {
      machineMenuState.closeMachineMenu();
    }

    function closeMenuOnEscape(event: KeyboardEvent) {
      if (event.key === "Escape") closeMenu();
    }

    globalThis.addEventListener("mousedown", closeMenu);
    globalThis.addEventListener("keydown", closeMenuOnEscape);
    return () => {
      globalThis.removeEventListener("mousedown", closeMenu);
      globalThis.removeEventListener("keydown", closeMenuOnEscape);
    };
  }, [machineMenuState, machineMenu]);

  function openAddMachineModal() {
    machineModal.openAddMachineModal();
  }

  function openMachineContextMenu(
    event: React.MouseEvent<HTMLButtonElement>,
    machine: Machine,
  ) {
    event.preventDefault();
    event.stopPropagation();
    machineMenuState.openMachineMenu(machine.id, event.clientX, event.clientY);
  }

  function showRailTooltip(target: HTMLElement, name: string) {
    const rect = target.getBoundingClientRect();
    machineMenuState.showRailTooltip(
      name,
      rect.right + 12,
      rect.top + rect.height / 2,
    );
  }

  function openConfigMachineModal(machine: Machine) {
    machineModal.openConfigMachineModal(machine.id);
  }

  function openPairMachineModal(machine: Machine) {
    machineModal.openPairMachineModal(machine.id);
  }

  function openDeleteMachineModal(machine: Machine) {
    machineModal.openDeleteMachineModal(machine.id);
  }

  function reconnectSelectedMachine() {
    machineMenuState.closeMachineMenu();
    void connectionState.checkSelected();
  }

  return (
    <>
      <MachineRail
        machines={machines}
        projectLogoUrl={projectLogoUrl}
        railTooltip={railTooltip}
        selectedId={selectedId}
        onAddMachine={openAddMachineModal}
        onContextMenu={openMachineContextMenu}
        onHideTooltip={machineMenuState.hideRailTooltip}
        onSelectMachine={machineMenuState.selectMachine}
        onShowTooltip={showRailTooltip}
      />

      {machineMenu && menuMachine
        ? (
          <MachineContextMenu
            machine={menuMachine}
            menu={machineMenu}
            onConfigure={openConfigMachineModal}
            onDelete={openDeleteMachineModal}
            onPair={openPairMachineModal}
            onReconnect={reconnectSelectedMachine}
          />
        )
        : null}
    </>
  );
}
