import { endpoint, hex, verifyHistory } from "../cluster/trust.ts";
import type { ClusterRecord } from "../cluster/storage.ts";
import {
  createSignal,
  createMemo,
  createEffect,
  createRoot,
  getOwner,
  runWithOwner,
  untrack,
} from "solid-js";
import { bunja } from "bunja";
import { loadMachines, Machine, saveMachines } from "./machines.ts";
import { MachineIdScope } from "./machine-scopes.ts";
import { type MachineStorage, MachineStorageScope } from "./machine-storage.ts";
const SELECTED_MACHINE_STORAGE_KEY = "rieul.selected-machine-id.v1";
export const machineStoreBunja = bunja(() => {
  const storage = bunja.use(MachineStorageScope);
  const initialMachines = loadMachines(storage);
  const initialSelectedId = loadSelectedMachineId(initialMachines, storage);
  const [machines, setMachines] = createSignal<Machine[]>(initialMachines);
  const [selectedId, setSelectedId] = createSignal<string | undefined>(
    initialSelectedId,
  );
  const [pendingPairMachineId, setPendingPairMachineId] = createSignal<
    string | undefined
  >(undefined);
  const selected = createMemo(() => getMachine(machines(), selectedId()));
  const selectedIsPaired = createMemo(() => isPaired(selected()));
  function selectMachine(machineId?: string) {
    setSelectedId(machineId);
  }
  function findMachine(machineId?: string): Machine | undefined {
    return getMachine(untrack(machines), machineId);
  }
  function addMachine(machine: Machine) {
    setMachines((current) => [...current, machine]);
    setSelectedId(machine.id);
  }
  function updateMachine(
    machineId: string,
    update: (machine: Machine) => Machine,
  ) {
    setMachines((current) =>
      current.map((machine) =>
        machine.id === machineId ? update(machine) : machine,
      ),
    );
  }
  function setMachineCredentials(
    machineId: string,
    credentials: {
      clientId: string;
      clientSecret: string;
      clientCredentialExpiresAtUnix: number;
    },
  ) {
    updateMachine(machineId, (machine) => ({ ...machine, ...credentials }));
  }
  function clearMachineCredentials(machineId: string) {
    updateMachine(
      machineId,
      ({ clientSecret: _clientSecret, ...machine }) => machine,
    );
  }
  function setMachineCredentialExpiry(
    machineId: string,
    clientCredentialExpiresAtUnix: number,
  ) {
    updateMachine(machineId, (machine) => ({
      ...machine,
      clientCredentialExpiresAtUnix,
    }));
  }
  function requestPairingForMachine(machineId: string) {
    setPendingPairMachineId(machineId);
  }
  function clearPendingPairMachine(machineId: string) {
    setPendingPairMachineId((current) =>
      current === machineId ? undefined : current,
    );
  }
  function deleteSelectedMachine(): Machine | undefined {
    const current = untrack(selected);
    if (!current) return;
    setMachines((items) => {
      const remaining = items.filter((machine) => machine.id !== current.id);
      setSelectedId((id) => (id === current.id ? remaining[0]?.id : id));
      return remaining;
    });
    return current;
  }
  const owner = getOwner();
  bunja.effect(() =>
    runWithOwner(owner, () =>
      createRoot((dispose) => {
        let persistedMachines = initialMachines;
        let persistedSelectedId = initialSelectedId;
        createEffect(machines, (value) => {
          if (value === persistedMachines) return;
          saveMachines(value, storage);
          persistedMachines = value;
        });
        createEffect(selectedId, (value) => {
          if (value === persistedSelectedId) return;
          saveSelectedMachineId(value, storage);
          persistedSelectedId = value;
        });
        return dispose;
      }),
    ),
  );
  const appliedClusterHeads = new Map<
    string,
    { sequence: number; hash: string }
  >();
  async function applyCluster(
    record: ClusterRecord,
    sourceId?: string,
    sourceAdmission?: string,
  ) {
    if (!record.history || !record.grantId) return;
    const verified = await verifyHistory(record.history);
    setMachines((current) => {
      const prior = appliedClusterHeads.get(record.id),
        nextHash = hex(verified.head.entryHash);
      if (prior && prior.sequence > verified.head.sequence) return current;
      if (
        prior &&
        prior.sequence === verified.head.sequence &&
        prior.hash !== nextHash
      )
        return current; // Fail closed without throwing from a deferred signal updater.
      appliedClusterHeads.set(record.id, {
        sequence: verified.head.sequence,
        hash: nextHash,
      });
      const valid = verified.grants.get(hex(record.grantId!));
      const authorized =
        valid &&
        valid.expires * 1000 > Date.now() &&
        hex(valid.client) === hex(record.publicKey);
      const bound = current.map((m) =>
        m.id === sourceId &&
        sourceAdmission &&
        verified.members.has(sourceAdmission) &&
        new URL(m.baseUrl).pathname === "/" &&
        endpoint(verified.members.get(sourceAdmission)!.endpoint) ===
          new URL(m.baseUrl).origin &&
        (!m.cluster || m.cluster.id === record.id) &&
        m.cluster?.admissionId !== sourceAdmission
          ? { ...m, cluster: { id: record.id, admissionId: sourceAdmission } }
          : m,
      );
      const next = bound.filter(
        (m) =>
          !m.cluster ||
          m.cluster.id !== record.id ||
          (authorized && verified.members.has(m.cluster.admissionId)) ||
          Boolean(m.clientSecret),
      );
      if (!authorized) {
        setSelectedId((id) =>
          id && !next.some((m) => m.id === id) ? next[0]?.id : id,
        );
        return next.length === current.length &&
          next.every((m, i) => m === current[i])
          ? current
          : next;
      }
      for (const member of verified.members.values()) {
        const baseUrl = endpoint(member.endpoint),
          admissionId = hex(member.admissionId);
        const existing = next.find(
          (m) =>
            m.cluster?.id === record.id &&
            m.cluster.admissionId === admissionId,
        );
        if (existing) continue;
        // An address match alone never transfers an existing machine's trust.
        next.push({
          id: `cluster:${record.id}:${admissionId}`,
          name: new URL(baseUrl).host,
          baseUrl,
          cluster: { id: record.id, admissionId },
        });
      }
      setSelectedId((id) =>
        id && !next.some((m) => m.id === id) ? next[0]?.id : id,
      );
      return next.length === current.length &&
        next.every((m, i) => m === current[i])
        ? current
        : next;
    });
  }
  return {
    applyCluster,
    machines,
    selectedId,
    selected,
    selectedIsPaired,
    pendingPairMachineId,
    selectMachine,
    findMachine,
    addMachine,
    updateMachine,
    setMachineCredentials,
    clearMachineCredentials,
    setMachineCredentialExpiry,
    requestPairingForMachine,
    clearPendingPairMachine,
    deleteSelectedMachine,
  };
});
export const machineBunja = bunja(() => {
  const machineId = bunja.use(MachineIdScope);
  const machines = bunja.use(machineStoreBunja);
  const machine = createMemo(() => getMachine(machines.machines(), machineId));
  const paired = createMemo(() => isPaired(machine()));
  return {
    machineId,
    machine,
    isPaired: paired,
  };
});
function getMachine(
  machines: Machine[],
  machineId?: string,
): Machine | undefined {
  return machines.find((machine) => machine.id === machineId);
}
function loadSelectedMachineId(
  machines: Machine[],
  storage: MachineStorage,
): string | undefined {
  const stored = storage.getItem(SELECTED_MACHINE_STORAGE_KEY);
  if (stored && getMachine(machines, stored)) return stored;
  return machines[0]?.id;
}
function saveSelectedMachineId(
  machineId: string | undefined,
  storage: MachineStorage,
) {
  if (machineId) {
    storage.setItem(SELECTED_MACHINE_STORAGE_KEY, machineId);
  } else {
    storage.removeItem(SELECTED_MACHINE_STORAGE_KEY);
  }
}
export function isPaired(machine?: Machine): boolean {
  return Boolean(
    machine?.cluster || (machine?.clientId && machine?.clientSecret),
  );
}
