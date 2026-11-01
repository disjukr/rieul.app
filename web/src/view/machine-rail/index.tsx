import { createEffect, flush } from "solid-js";

import { useBunja } from "bunja/solid";

import { machineMenuBunja } from "../../state/machine-menu.ts";
import { machineModalBunja } from "../../state/machine-modal.ts";
import { machineStoreBunja } from "../../state/machine-store.ts";
import {
  MachineBaseUrlContext,
  MachineIdContext,
} from "../../state/machine.tsx";
import type { Machine } from "../../state/machines.ts";
import { rpcSessionBunja } from "../../state/rpc-session.ts";
import type { MachineMenuState } from "../../state/types.ts";
import { MachineContextMenu } from "./machine-context-menu.tsx";
import { MachineRail } from "./machine-rail.tsx";

const projectLogoUrl = new URL("../../assets/rieul.svg", import.meta.url).href;

export function MachineRailRegion() {
  const machineStore = useBunja(machineStoreBunja);
  const machineMenuState = useBunja(machineMenuBunja);
  const machineModal = useBunja(machineModalBunja);
  const machines = () => machineStore().machines();
  const selectedId = () => machineStore().selectedId();
  const machineMenu = () => machineMenuState().machineMenu();
  const menuMachine = () => machineMenuState().menuMachine();

  createEffect(
    () => ({
      machineMenuSnapshot: machineMenu(),
      machineMenuStateSnapshot: machineMenuState(),
    }),
    ({ machineMenuSnapshot, machineMenuStateSnapshot }) => {
      if (!machineMenuSnapshot) return;

      function closeMenu() {
        machineMenuStateSnapshot.closeMachineMenu();
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
    },
  );

  function openAddMachineModal() {
    machineModal().openAddMachineModal();
  }

  function openMachineContextMenu(
    event: MouseEvent & { currentTarget: HTMLButtonElement },
    machine: Machine,
  ) {
    event.preventDefault();
    event.stopPropagation();
    machineMenuState().openMachineMenu(
      machine.id,
      event.clientX,
      event.clientY,
    );
  }

  function openConfigMachineModal(machine: Machine) {
    machineModal().openConfigMachineModal(machine.id);
  }

  function openPairMachineModal(machine: Machine) {
    machineModal().openPairMachineModal(machine.id);
  }

  function openDeleteMachineModal(machine: Machine) {
    machineModal().openDeleteMachineModal(machine.id);
  }

  return (
    <>
      <MachineRail
        machines={machines()}
        projectLogoUrl={projectLogoUrl}
        selectedId={selectedId()}
        onAddMachine={openAddMachineModal}
        onContextMenu={openMachineContextMenu}
        onSelectMachine={(event) => machineMenuState().selectMachine(event)}
      />

      {machineMenu() && menuMachine() ? (
        <MachineIdContext value={() => menuMachine()!.id}>
          <MachineBaseUrlContext value={() => menuMachine()!.baseUrl}>
            <MachineContextMenuHost
              machine={menuMachine()!}
              menu={machineMenu()!}
              onConfigure={openConfigMachineModal}
              onDelete={openDeleteMachineModal}
              onPair={openPairMachineModal}
            />
          </MachineBaseUrlContext>
        </MachineIdContext>
      ) : null}
    </>
  );
}

interface MachineContextMenuHostProps {
  machine: Machine;
  menu: MachineMenuState;
  onConfigure: (machine: Machine) => void;
  onDelete: (machine: Machine) => void;
  onPair: (machine: Machine) => void;
}

function MachineContextMenuHost(componentProps: MachineContextMenuHostProps) {
  const machineMenuState = useBunja(machineMenuBunja);
  const machineStore = useBunja(machineStoreBunja);
  const rpcSession = useBunja(rpcSessionBunja);

  function reconnectMachine() {
    const session = rpcSession();
    machineMenuState().closeMachineMenu();
    machineStore().selectMachine(componentProps.machine.id);
    // Closing the menu releases its owner; keep its already scoped session.
    flush();
    void session.reconnect();
  }

  function unpairMachine() {
    const session = rpcSession();
    machineMenuState().closeMachineMenu();
    machineStore().clearMachineCredentials(componentProps.machine.id);
    machineStore().selectMachine(componentProps.machine.id);
    flush();
    session.resetController();
  }

  return (
    <MachineContextMenu
      machine={componentProps.machine}
      menu={componentProps.menu}
      onConfigure={(event) => componentProps.onConfigure(event)}
      onDelete={(event) => componentProps.onDelete(event)}
      onPair={(event) => componentProps.onPair(event)}
      onReconnect={reconnectMachine}
      onUnpair={unpairMachine}
    />
  );
}
