import { Show, createEffect, createMemo, createSignal } from "solid-js";

import { useBunja } from "../../solid/bunja.tsx";
import { useAtomValue, useSetAtom } from "../../solid/jotai.tsx";
import { machineModalBunja } from "../../state/machine-modal.ts";
import { machineStoreBunja } from "../../state/machine-store.ts";
import { normalizeMachineUrl } from "../../state/machines.ts";
import { AddMachineForm } from "./add-machine-form.tsx";
import { MachineModal } from "./machine-modal.tsx";
import { MachinePanel } from "./machine-panel.tsx";
import { machinePanelBunja } from "./state.ts";

interface MachineAddFormContainerProps {
  showCancel: boolean;
}

export function MachinePanelRegion() {
  const machinePanel = useBunja(machinePanelBunja);
  const selected = useAtomValue(() => machinePanel().machineAtom);
  const connection = useAtomValue(() => machinePanel().connectionAtom);
  const machinePanelCollapsed = useAtomValue(
    () => machinePanel().machinePanelCollapsedAtom,
  );
  const machinePanelWidth = useAtomValue(
    () => machinePanel().machinePanelWidthAtom,
  );

  return (
    <MachinePanel
      connection={connection()}
      machine={selected()}
      machinePanelCollapsed={machinePanelCollapsed()}
      machinePanelMaxWidth={machinePanel().machinePanelMaxWidth}
      machinePanelMinWidth={machinePanel().machinePanelMinWidth}
      machinePanelWidth={machinePanelWidth()}
      onOpenMachineMenu={(event, machine) =>
        machinePanel().openMachineTitleMenu(event, machine)
      }
      onResizeKeyDown={(event) =>
        machinePanel().resizeMachinePanelWithKeyboard(event)
      }
      onResizePointerDown={(event) =>
        machinePanel().startMachinePanelResize(event)
      }
    />
  );
}

export function MachineAddFormContainer(
  componentProps: MachineAddFormContainerProps,
) {
  const machineModal = useBunja(machineModalBunja);
  const machineStore = useBunja(machineStoreBunja);
  const machineName = useAtomValue(() => machineModal().machineNameAtom);
  const baseUrl = useAtomValue(() => machineModal().baseUrlAtom);
  const machineFormError = useAtomValue(
    () => machineModal().machineFormErrorAtom,
  );
  const machineModalMode = useAtomValue(
    () => machineModal().machineModalModeAtom,
  );
  const machines = useAtomValue(() => machineStore().machinesAtom);
  const machineNameInputRef = { current: null as HTMLInputElement | null };

  createEffect(
    () => ({
      machinesSnapshot: machines(),
      machineModalModeSnapshot: machineModalMode(),
    }),
    ({ machinesSnapshot, machineModalModeSnapshot }) => {
      if (globalThis.matchMedia("(max-width: 680px)").matches) return;
      if (machinesSnapshot.length === 0 && !machineModalModeSnapshot) {
        machineNameInputRef.current?.focus();
      }
    },
  );

  function addMachine(event: SubmitEvent & { currentTarget: HTMLFormElement }) {
    event.preventDefault();
    machineModal().addMachine();
  }

  return (
    <AddMachineForm
      baseUrl={baseUrl()}
      error={machineFormError()}
      machineName={machineName()}
      machineNameInputRef={machineNameInputRef}
      showCancel={componentProps.showCancel}
      onBaseUrlChange={(event) => machineModal().updateBaseUrlDraft(event)}
      onCancel={() => machineModal().closeMachineModal()}
      onMachineNameChange={(event) =>
        machineModal().updateMachineNameDraft(event)
      }
      onSubmit={addMachine}
    />
  );
}

export function MachineModalHost() {
  const machineStore = useBunja(machineStoreBunja);
  const machineModal = useBunja(machineModalBunja);
  const machines = useAtomValue(() => machineStore().machinesAtom);
  const pendingPairMachineId = useAtomValue(
    () => machineStore().pendingPairMachineIdAtom,
  );
  const selected = useAtomValue(() => machineStore().selectedAtom);
  const machineName = useAtomValue(() => machineModal().machineNameAtom);
  const baseUrl = useAtomValue(() => machineModal().baseUrlAtom);
  const configNameDraft = useAtomValue(
    () => machineModal().configNameDraftAtom,
  );
  const configUrlDraft = useAtomValue(() => machineModal().configUrlDraftAtom);
  const machineModalMode = useAtomValue(
    () => machineModal().machineModalModeAtom,
  );
  const machineFormError = useAtomValue(
    () => machineModal().machineFormErrorAtom,
  );
  const pairingCode = useAtomValue(() => machineModal().pairingCodeAtom);
  const pairingConfirmationCode = useAtomValue(
    () => machineModal().pairingConfirmationCodeAtom,
  );
  const pairingCodeExpiresAtUnix = useAtomValue(
    () => machineModal().pairingCodeExpiresAtUnixAtom,
  );
  const isRequestingPairingCode = useAtomValue(
    () => machineModal().isRequestingPairingCodeAtom,
  );
  const isPairing = useAtomValue(() => machineModal().isPairingAtom);
  const modalTitle = useAtomValue(() => machineModal().modalTitleAtom);
  const setConfigNameDraft = useSetAtom(
    () => machineModal().configNameDraftAtom,
  );
  const setConfigUrlDraft = useSetAtom(() => machineModal().configUrlDraftAtom);
  const setPairingCode = useSetAtom(() => machineModal().pairingCodeAtom);
  const machineNameInputRef = { current: null as HTMLInputElement | null };
  const configNameInputRef = { current: null as HTMLInputElement | null };
  const pairingCodeInputRef = { current: null as HTMLInputElement | null };
  const daemonUrlQueryHandledRef = { current: false as boolean };
  const [nowMs, setNowMs] = createSignal((() => Date.now())());

  createEffect(
    () => ({
      machineModalSnapshot: machineModal(),
      machinesSnapshot: machines(),
      machineStoreSnapshot: machineStore(),
    }),
    ({ machineModalSnapshot, machinesSnapshot, machineStoreSnapshot }) => {
      if (daemonUrlQueryHandledRef.current) return;
      daemonUrlQueryHandledRef.current = true;

      const currentUrl = new URL(globalThis.location.href);
      const daemonUrl = currentUrl.searchParams.get("daemonUrl")?.trim();
      if (!daemonUrl) return;

      currentUrl.searchParams.delete("daemonUrl");
      globalThis.history.replaceState(globalThis.history.state, "", currentUrl);

      let normalizedDaemonUrl: string;
      try {
        normalizedDaemonUrl = normalizeMachineUrl(daemonUrl);
      } catch {
        machineModalSnapshot.openAddMachineModalFromUrl(daemonUrl);
        return;
      }

      const existingMachine = machinesSnapshot.find(
        (machine) => machine.baseUrl === normalizedDaemonUrl,
      );
      if (existingMachine) {
        machineStoreSnapshot.selectMachine(existingMachine.id);
        return;
      }
      machineModalSnapshot.openAddMachineModalFromUrl(normalizedDaemonUrl);
    },
  );

  createEffect(
    () => ({
      pendingPairMachineIdSnapshot: pendingPairMachineId(),
      machineStoreSnapshot: machineStore(),
      machineModalSnapshot: machineModal(),
    }),
    ({
      pendingPairMachineIdSnapshot,
      machineStoreSnapshot,
      machineModalSnapshot,
    }) => {
      if (!pendingPairMachineIdSnapshot) return;
      machineStoreSnapshot.clearPendingPairMachine(
        pendingPairMachineIdSnapshot!,
      );
      machineModalSnapshot.openPairMachineModal(pendingPairMachineIdSnapshot!);
    },
  );

  createEffect(
    () => ({
      machineModalModeSnapshot: machineModalMode(),
      pairingCodeExpiresAtUnixSnapshot: pairingCodeExpiresAtUnix(),
    }),
    ({ machineModalModeSnapshot, pairingCodeExpiresAtUnixSnapshot }) => {
      if (machineModalModeSnapshot === "add") {
        machineNameInputRef.current?.focus();
        return;
      }
      if (machineModalModeSnapshot === "pair") {
        if (pairingCodeExpiresAtUnixSnapshot !== undefined) {
          pairingCodeInputRef.current?.focus();
        }
        return;
      }
      if (machineModalModeSnapshot === "config") {
        configNameInputRef.current?.focus();
        configNameInputRef.current?.select();
      }
    },
  );

  createEffect(
    () => ({
      machineModalModeSnapshot: machineModalMode(),
      machinesSnapshot: machines(),
      machineModalSnapshot: machineModal(),
    }),
    ({ machineModalModeSnapshot, machinesSnapshot, machineModalSnapshot }) => {
      if (!machineModalModeSnapshot || machinesSnapshot.length === 0) return;

      function closeOnEscape(event: KeyboardEvent) {
        if (event.key === "Escape") {
          machineModalSnapshot.closeMachineModal();
        }
      }

      globalThis.addEventListener("keydown", closeOnEscape);
      return () => globalThis.removeEventListener("keydown", closeOnEscape);
    },
  );

  createEffect(
    () => ({ machineModalModeSnapshot: machineModalMode() }),
    ({ machineModalModeSnapshot }) => {
      if (machineModalModeSnapshot !== "pair") return;
      setNowMs(Date.now());
      const interval = globalThis.setInterval(() => {
        setNowMs(Date.now());
      }, 1_000);
      return () => globalThis.clearInterval(interval);
    },
  );

  createEffect(
    () => ({
      machineModalModeSnapshot: machineModalMode(),
      selectedSnapshot: selected(),
      isPairingSnapshot: isPairing(),
      pairingCodeExpiresAtUnixSnapshot: pairingCodeExpiresAtUnix(),
      machineModalSnapshot: machineModal(),
    }),
    ({
      machineModalModeSnapshot,
      selectedSnapshot,
      isPairingSnapshot,
      pairingCodeExpiresAtUnixSnapshot,
      machineModalSnapshot,
    }) => {
      if (
        machineModalModeSnapshot !== "pair" ||
        !selectedSnapshot ||
        isPairingSnapshot ||
        !pairingCodeExpiresAtUnixSnapshot
      ) {
        return;
      }
      const expiresAtMs = pairingCodeExpiresAtUnixSnapshot! * 1_000;
      const delayMs = Math.max(0, expiresAtMs - Date.now() + 250);
      const timeout = globalThis.setTimeout(() => {
        machineModalSnapshot.requestSelectedPairingCode();
      }, delayMs);
      return () => globalThis.clearTimeout(timeout);
    },
  );

  function addMachine(event: SubmitEvent & { currentTarget: HTMLFormElement }) {
    event.preventDefault();
    machineModal().addMachine();
  }

  function saveMachineConfig(
    event: SubmitEvent & { currentTarget: HTMLFormElement },
  ) {
    event.preventDefault();
    machineModal().saveMachineConfig();
  }

  async function pairSelected(
    event: SubmitEvent & { currentTarget: HTMLFormElement },
  ) {
    event.preventDefault();
    await machineModal().pairSelected();
  }

  const pairingCodeExpiresInSeconds = createMemo(() =>
    pairingCodeExpiresAtUnix() === undefined
      ? undefined
      : Math.max(
          0,
          Math.ceil((pairingCodeExpiresAtUnix()! * 1_000 - nowMs()) / 1_000),
        ),
  );

  return (
    <Show when={machineModalMode()}>
      {(mode) => (
        <MachineModal
          baseUrl={baseUrl()}
          configNameDraft={configNameDraft()}
          configNameInputRef={configNameInputRef}
          configUrlDraft={configUrlDraft()}
          isRequestingPairingCode={isRequestingPairingCode()}
          isPairing={isPairing()}
          machineCount={machines().length}
          machineFormError={machineFormError()}
          machineName={machineName()}
          machineNameInputRef={machineNameInputRef}
          mode={mode()}
          modalTitle={modalTitle()}
          pairingCode={pairingCode()}
          pairingConfirmationCode={pairingConfirmationCode()}
          pairingCodeExpiresInSeconds={pairingCodeExpiresInSeconds()}
          pairingCodeInputRef={pairingCodeInputRef}
          selected={selected()}
          onAddMachine={addMachine}
          onBaseUrlChange={(event) => machineModal().updateBaseUrlDraft(event)}
          onClose={() => machineModal().closeMachineModal()}
          onConfigNameChange={setConfigNameDraft}
          onConfigUrlChange={setConfigUrlDraft}
          onDeleteSelectedMachine={() => machineModal().deleteSelectedMachine()}
          onMachineNameChange={(event) =>
            machineModal().updateMachineNameDraft(event)
          }
          onPairingCodeChange={setPairingCode}
          onPairSelected={pairSelected}
          onRequestPairingCode={() =>
            machineModal().requestSelectedPairingCode()
          }
          onSaveMachineConfig={saveMachineConfig}
        />
      )}
    </Show>
  );
}
