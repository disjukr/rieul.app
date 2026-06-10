import { FormEvent, useEffect, useRef } from "react";
import { useAtomValue, useSetAtom } from "jotai";
import { useBunja } from "bunja/react";
import { connectionBunja } from "../../state/connection.ts";
import { machineMenuBunja } from "../../state/machine-menu.ts";
import { machineModalBunja } from "../../state/machine-modal.ts";
import { machineStoreBunja } from "../../state/machine-store.ts";
import type { Machine } from "../../state/machines.ts";
import { workbenchBunja } from "../../state/workbench.ts";
import { layoutBunja } from "../state.tsx";
import { AddMachineForm } from "./add-machine-form.tsx";
import { MachineModal } from "./machine-modal.tsx";
import { MachinePanel } from "./machine-panel.tsx";

interface MachineAddFormContainerProps {
  showCancel: boolean;
}

export function MachinePanelRegion() {
  const layout = useBunja(layoutBunja);
  const machineStore = useBunja(machineStoreBunja);
  const machineMenuState = useBunja(machineMenuBunja);
  const connectionState = useBunja(connectionBunja);
  const selected = useAtomValue(machineStore.selectedAtom);
  const machineMenu = useAtomValue(machineMenuState.machineMenuAtom);
  const connection = useAtomValue(connectionState.connectionAtom);
  const workbench = useBunja(workbenchBunja);
  const activeTool = useAtomValue(workbench.activeToolAtom);
  const machinePanelCollapsed = useAtomValue(
    layout.machinePanelCollapsedAtom,
  );
  const machinePanelWidth = useAtomValue(layout.machinePanelWidthAtom);

  function openMachineTitleMenu(
    event: React.MouseEvent<HTMLButtonElement>,
    machine: Machine,
  ) {
    event.preventDefault();
    event.stopPropagation();
    if (machineMenu?.machineId === machine.id) {
      machineMenuState.closeMachineMenu();
      return;
    }
    const rect = event.currentTarget.getBoundingClientRect();
    machineMenuState.openMachineMenu(machine.id, rect.left, rect.bottom + 8);
  }

  return (
    <MachinePanel
      activeTool={activeTool}
      connection={connection}
      machine={selected}
      machinePanelCollapsed={machinePanelCollapsed}
      machinePanelMaxWidth={layout.machinePanelMaxWidth}
      machinePanelMinWidth={layout.machinePanelMinWidth}
      machinePanelWidth={machinePanelWidth}
      onOpenMachineMenu={openMachineTitleMenu}
      onResizeKeyDown={layout.resizeMachinePanelWithKeyboard}
      onResizePointerDown={layout.startMachinePanelResize}
      onSelectTool={workbench.selectTool}
    />
  );
}

export function MachineAddFormContainer(
  { showCancel }: MachineAddFormContainerProps,
) {
  const machineModal = useBunja(machineModalBunja);
  const machineStore = useBunja(machineStoreBunja);
  const machineName = useAtomValue(machineModal.machineNameAtom);
  const baseUrl = useAtomValue(machineModal.baseUrlAtom);
  const machineFormError = useAtomValue(machineModal.machineFormErrorAtom);
  const machineModalMode = useAtomValue(machineModal.machineModalModeAtom);
  const machines = useAtomValue(machineStore.machinesAtom);
  const machineNameInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (machines.length === 0 && !machineModalMode) {
      machineNameInputRef.current?.focus();
    }
  }, [machineModalMode, machines.length]);

  function addMachine(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    machineModal.addMachine();
  }

  return (
    <AddMachineForm
      baseUrl={baseUrl}
      error={machineFormError}
      machineName={machineName}
      machineNameInputRef={machineNameInputRef}
      showCancel={showCancel}
      onBaseUrlChange={machineModal.updateBaseUrlDraft}
      onCancel={machineModal.closeMachineModal}
      onMachineNameChange={machineModal.updateMachineNameDraft}
      onSubmit={addMachine}
    />
  );
}

export function MachineModalHost() {
  const machineStore = useBunja(machineStoreBunja);
  const machineModal = useBunja(machineModalBunja);
  const connectionState = useBunja(connectionBunja);
  const machines = useAtomValue(machineStore.machinesAtom);
  const selected = useAtomValue(machineStore.selectedAtom);
  const machineName = useAtomValue(machineModal.machineNameAtom);
  const baseUrl = useAtomValue(machineModal.baseUrlAtom);
  const configNameDraft = useAtomValue(machineModal.configNameDraftAtom);
  const configUrlDraft = useAtomValue(machineModal.configUrlDraftAtom);
  const machineModalMode = useAtomValue(machineModal.machineModalModeAtom);
  const machineFormError = useAtomValue(machineModal.machineFormErrorAtom);
  const pairingCode = useAtomValue(machineModal.pairingCodeAtom);
  const isPairing = useAtomValue(machineModal.isPairingAtom);
  const connection = useAtomValue(connectionState.connectionAtom);
  const modalTitle = useAtomValue(machineModal.modalTitleAtom);
  const setConfigNameDraft = useSetAtom(machineModal.configNameDraftAtom);
  const setConfigUrlDraft = useSetAtom(machineModal.configUrlDraftAtom);
  const setPairingCode = useSetAtom(machineModal.pairingCodeAtom);
  const machineNameInputRef = useRef<HTMLInputElement>(null);
  const configNameInputRef = useRef<HTMLInputElement>(null);
  const pairingCodeInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (machineModalMode === "add") {
      machineNameInputRef.current?.focus();
      return;
    }
    if (machineModalMode === "pair") {
      pairingCodeInputRef.current?.focus();
      return;
    }
    if (machineModalMode === "config") {
      configNameInputRef.current?.focus();
      configNameInputRef.current?.select();
    }
  }, [machineModalMode]);

  useEffect(() => {
    if (!machineModalMode || machines.length === 0) return;

    function closeOnEscape(event: KeyboardEvent) {
      if (event.key === "Escape") {
        machineModal.closeMachineModal();
      }
    }

    globalThis.addEventListener("keydown", closeOnEscape);
    return () => globalThis.removeEventListener("keydown", closeOnEscape);
  }, [machineModal, machineModalMode, machines.length]);

  if (!machineModalMode) return null;

  function addMachine(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    machineModal.addMachine();
  }

  function saveMachineConfig(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    machineModal.saveMachineConfig();
  }

  async function pairSelected(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    await machineModal.pairSelected(
      `web:${globalThis.location.host || "local"}`,
    );
  }

  return (
    <MachineModal
      baseUrl={baseUrl}
      configNameDraft={configNameDraft}
      configNameInputRef={configNameInputRef}
      configUrlDraft={configUrlDraft}
      connection={connection}
      isPairing={isPairing}
      machineCount={machines.length}
      machineFormError={machineFormError}
      machineName={machineName}
      machineNameInputRef={machineNameInputRef}
      mode={machineModalMode}
      modalTitle={modalTitle}
      pairingCode={pairingCode}
      pairingCodeInputRef={pairingCodeInputRef}
      selected={selected}
      onAddMachine={addMachine}
      onBaseUrlChange={machineModal.updateBaseUrlDraft}
      onClose={machineModal.closeMachineModal}
      onConfigNameChange={setConfigNameDraft}
      onConfigUrlChange={setConfigUrlDraft}
      onDeleteSelectedMachine={machineModal.deleteSelectedMachine}
      onMachineNameChange={machineModal.updateMachineNameDraft}
      onPairingCodeChange={setPairingCode}
      onPairSelected={pairSelected}
      onSaveMachineConfig={saveMachineConfig}
    />
  );
}
