import {
  createSignal,
  createMemo,
  createEffect,
  createRoot,
  getOwner,
  runWithOwner,
  onFlush,
  latest,
  untrack,
} from "solid-js";
import { bunja } from "bunja";
import { machineMenuBunja } from "./machine-menu.ts";
import { machineBunja, machineStoreBunja } from "./machine-store.ts";
import { Machine, normalizeMachineUrl } from "./machines.ts";
import { rpcSessionBunja } from "./rpc-session.ts";
import { MachineModalMode } from "./types.ts";
export const machineModalBunja = bunja(() => {
  const machines = bunja.use(machineStoreBunja);
  const machineState = bunja.use(machineBunja);
  const menu = bunja.use(machineMenuBunja);
  const rpcSession = bunja.use(rpcSessionBunja);
  const [machineName, setMachineName] = createSignal("");
  const [machineNameEdited, setMachineNameEdited] = createSignal(false);
  const [baseUrl, setBaseUrl] = createSignal("");
  const [configNameDraft, setConfigNameDraft] = createSignal("");
  const [configUrlDraft, setConfigUrlDraft] = createSignal("");
  const [machineModalMode, setMachineModalMode] = createSignal<
    MachineModalMode | undefined
  >(undefined);
  const [machineFormError, setMachineFormError] = createSignal("");
  const [pairingCode, setPairingCode] = createSignal("");
  const [pairingConfirmationCode, setPairingConfirmationCode] = createSignal<
    string | undefined
  >(undefined);
  const [pairingCodeExpiresAtUnix, setPairingCodeExpiresAtUnix] = createSignal<
    number | undefined
  >(undefined);
  const [isRequestingPairingCode, setIsRequestingPairingCode] =
    createSignal(false);
  const [isPairing, setIsPairing] = createSignal(false);
  const modalTitle = createMemo(() => machineModalTitle(machineModalMode()));
  let pairingRequestSerial = 0;
  let active = false;
  let pairingInFlight = false;
  const owner = getOwner();
  bunja.effect(() => {
    active = true;
    function consumePendingPair() {
      if (!active) return;
      const machineId = untrack(() => latest(machines.pendingPairMachineId));
      if (!machineId) return;
      if (!machines.findMachine(machineId)) {
        machines.clearPendingPairMachine(machineId);
        return;
      }
      // Selection changes the UI's scope. An old instance must not start a
      // request on its previous RPC session; the new instance consumes on mount.
      if (untrack(() => latest(machines.selectedId)) !== machineId) {
        machines.selectMachine(machineId);
      }
      if (machineState.machineId !== machineId) return;
      machines.clearPendingPairMachine(machineId);
      openPairMachineModal(machineId);
    }
    const dispose = runWithOwner(owner, () =>
      createRoot((dispose) => {
        createEffect(machines.pendingPairMachineId, () => {
          // Consume a queued command after this reaction, never write its
          // observed source from the effect callback itself.
          onFlush(consumePendingPair);
        });
        return dispose;
      }),
    );
    return () => {
      active = false;
      dispose();
      pairingRequestSerial++;
    };
  });
  function addMachine() {
    setMachineFormError("");
    let normalizedBaseUrl;
    try {
      normalizedBaseUrl = normalizeMachineUrl(untrack(() => latest(baseUrl)));
    } catch (err) {
      setMachineFormError(errorMessage(err));
      return;
    }
    const machine: Machine = {
      id: crypto.randomUUID(),
      name:
        untrack(() => latest(machineName)).trim() ||
        inferMachineNameFromUrl(normalizedBaseUrl),
      baseUrl: normalizedBaseUrl,
    };
    machines.addMachine(machine);
    setMachineName("");
    setMachineNameEdited(false);
    setBaseUrl("");
    resetPairingCode();
    machines.requestPairingForMachine(machine.id);
  }
  function closeMachineModal() {
    if (
      untrack(() => latest(machines.machines)).length === 0 &&
      untrack(() => latest(machineModalMode)) !== "add"
    )
      return;
    setMachineName("");
    setMachineNameEdited(false);
    setBaseUrl("");
    setMachineModalMode(undefined);
    setMachineFormError("");
    cancelPairingRequest();
    resetPairingCode();
  }
  function openAddMachineModal() {
    menu.closeMachineMenu();
    setMachineName("");
    setMachineNameEdited(false);
    setBaseUrl("");
    setMachineFormError("");
    cancelPairingRequest();
    resetPairingCode();
    if (untrack(() => latest(machines.machines)).length === 0) {
      setMachineModalMode(undefined);
      return;
    }
    setMachineModalMode("add");
  }
  function openAddMachineModalFromUrl(daemonUrl: string) {
    menu.closeMachineMenu();
    setMachineName(inferMachineNameFromUrl(daemonUrl));
    setMachineNameEdited(false);
    setBaseUrl(daemonUrl);
    setMachineFormError("");
    cancelPairingRequest();
    resetPairingCode();
    setMachineModalMode("add");
  }
  function openConfigMachineModal(machineId: string) {
    const machine = machines.findMachine(machineId);
    if (!machine) return;
    machines.selectMachine(machine.id);
    setConfigNameDraft(machine.name);
    setConfigUrlDraft(machine.baseUrl);
    setMachineFormError("");
    cancelPairingRequest();
    resetPairingCode();
    menu.closeMachineMenu();
    setMachineModalMode("config");
  }
  function openPairMachineModal(machineId: string) {
    const machine = machines.findMachine(machineId);
    if (!machine) return;
    machines.selectMachine(machine.id);
    cancelPairingRequest();
    resetPairingCode();
    setMachineFormError("");
    menu.closeMachineMenu();
    setMachineModalMode("pair");
    requestPairingCode(machine);
  }
  function openDeleteMachineModal(machineId: string) {
    const machine = machines.findMachine(machineId);
    if (!machine) return;
    machines.selectMachine(machine.id);
    setMachineFormError("");
    cancelPairingRequest();
    resetPairingCode();
    menu.closeMachineMenu();
    setMachineModalMode("delete");
  }
  function saveMachineConfig() {
    const selected = untrack(() => latest(machines.selected));
    if (!selected) return;
    const name = untrack(() => latest(configNameDraft)).trim();
    if (!name) {
      setMachineFormError("Name is required");
      return;
    }
    let normalizedBaseUrl;
    try {
      normalizedBaseUrl = normalizeMachineUrl(
        untrack(() => latest(configUrlDraft)),
      );
    } catch (err) {
      setMachineFormError(errorMessage(err));
      return;
    }
    machines.updateMachine(selected.id, (machine) => ({
      ...machine,
      name,
      baseUrl: normalizedBaseUrl,
    }));
    setMachineFormError("");
    setMachineModalMode(undefined);
  }
  function deleteSelectedMachine() {
    const deleted = machines.deleteSelectedMachine();
    if (!deleted) return;
    setMachineFormError("");
    cancelPairingRequest();
    resetPairingCode();
    setMachineModalMode(undefined);
  }
  async function pairSelected() {
    const selected = untrack(() => latest(machines.selected));
    if (!selected || pairingInFlight) return;
    const code = untrack(() => latest(pairingCode)).trim();
    if (!code) return;
    const serial = pairingRequestSerial;
    pairingInFlight = true;
    setIsPairing(true);
    setMachineFormError("");
    try {
      const credentials = await rpcSession.completePairingSession(code);
      if (!isCurrentPairingRequest(selected, serial)) return;
      machines.setMachineCredentials(selected.id, credentials);
      resetPairingCode();
      setMachineModalMode(undefined);
    } catch (err) {
      if (isCurrentPairingRequest(selected, serial)) {
        setMachineFormError(errorMessage(err));
      }
    } finally {
      if (active && serial === pairingRequestSerial) {
        pairingInFlight = false;
        setIsPairing(false);
      }
    }
  }
  function requestPairingCode(machine: Machine) {
    const serial = ++pairingRequestSerial;
    const confirmationCode = createPairingConfirmationCode();
    const clientLabel = browserClientLabel();
    setMachineFormError("");
    resetPairingCode();
    setPairingConfirmationCode(confirmationCode);
    setIsRequestingPairingCode(true);
    void (async () => {
      try {
        const { pairingCodeExpiresAtUnix } =
          await rpcSession.startPairingSession(confirmationCode, clientLabel);
        if (!isCurrentPairingRequest(machine, serial)) return;
        setPairingCodeExpiresAtUnix(pairingCodeExpiresAtUnix);
      } catch (err) {
        if (!isCurrentPairingRequest(machine, serial)) return;
        setMachineFormError(errorMessage(err));
      } finally {
        if (active && serial === pairingRequestSerial) {
          setIsRequestingPairingCode(false);
        }
      }
    })();
  }
  function requestSelectedPairingCode() {
    const selected = untrack(() => latest(machines.selected));
    if (!selected) return;
    requestPairingCode(selected);
  }
  function cancelPairingRequest() {
    pairingRequestSerial++;
    pairingInFlight = false;
    setIsPairing(false);
    setIsRequestingPairingCode(false);
  }
  function resetPairingCode() {
    setPairingCode("");
    setPairingConfirmationCode(undefined);
    setPairingCodeExpiresAtUnix(undefined);
  }
  function isCurrentPairingRequest(machine: Machine, serial: number) {
    return (
      active &&
      serial === pairingRequestSerial &&
      untrack(() => latest(machineModalMode)) === "pair" &&
      untrack(() => latest(machines.selected))?.id === machine.id &&
      !!machines.findMachine(machine.id)
    );
  }
  function updateMachineNameDraft(value: string) {
    setMachineName(value);
    setMachineNameEdited(value.trim().length > 0);
  }
  function updateBaseUrlDraft(value: string) {
    setBaseUrl(value);
    if (!untrack(() => latest(machineNameEdited))) {
      setMachineName(inferMachineNameFromUrl(value));
    }
  }
  return {
    machineName,
    setMachineName,
    baseUrl,
    setBaseUrl,
    configNameDraft,
    setConfigNameDraft,
    configUrlDraft,
    setConfigUrlDraft,
    machineModalMode,
    machineFormError,
    pairingCode,
    setPairingCode,
    pairingConfirmationCode,
    pairingCodeExpiresAtUnix,
    isRequestingPairingCode,
    isPairing,
    modalTitle,
    addMachine,
    closeMachineModal,
    openAddMachineModal,
    openAddMachineModalFromUrl,
    openConfigMachineModal,
    openPairMachineModal,
    openDeleteMachineModal,
    saveMachineConfig,
    deleteSelectedMachine,
    pairSelected,
    requestSelectedPairingCode,
    updateMachineNameDraft,
    updateBaseUrlDraft,
  };
});
function machineModalTitle(mode?: MachineModalMode): string {
  switch (mode) {
    case "pair":
      return "Pair machine";
    case "config":
      return "Machine config";
    case "delete":
      return "Delete machine";
    case "add":
    case undefined:
      return "Add machine";
  }
}
export function inferMachineNameFromUrl(raw: string): string {
  try {
    const hostname = new URL(normalizeMachineUrl(raw)).hostname;
    const firstLabel = hostname.split(".")[0] ?? "";
    if (hostname.includes(".") && /[a-z]/i.test(firstLabel)) {
      return firstLabel;
    }
    return hostname;
  } catch {
    return "";
  }
}
function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
function createPairingConfirmationCode(): string {
  const bytes = new Uint8Array(1);
  crypto.getRandomValues(bytes);
  return (bytes[0] % 100).toString().padStart(2, "0");
}
function browserClientLabel(): string {
  return globalThis.navigator?.userAgent.trim() || "web";
}
