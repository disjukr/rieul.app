import { bunja } from "bunja";
import { atom } from "jotai/vanilla";
import { JotaiStoreScope } from "./jotai-store.ts";
import { loadMachines, Machine, saveMachines } from "./machines.ts";
import { MachineIdScope } from "./machine-scopes.ts";
import { type MachineStorage, MachineStorageScope } from "./machine-storage.ts";

const SELECTED_MACHINE_STORAGE_KEY = "rieul.selected-machine-id.v1";

export const machineStoreBunja = bunja(() => {
  const store = bunja.use(JotaiStoreScope);
  const storage = bunja.use(MachineStorageScope);
  const initialMachines = loadMachines(storage);
  const initialSelectedId = loadSelectedMachineId(initialMachines, storage);

  const machinesAtom = atom<Machine[]>(initialMachines);
  const selectedIdAtom = atom<string | undefined>(initialSelectedId);
  const pendingPairMachineIdAtom = atom<string | undefined>(undefined);
  const selectedAtom = atom((get) =>
    getMachine(get(machinesAtom), get(selectedIdAtom)),
  );
  const selectedIsPairedAtom = atom((get) => isPaired(get(selectedAtom)));

  function selectMachine(machineId?: string) {
    store.set(selectedIdAtom, machineId);
  }

  function findMachine(machineId?: string): Machine | undefined {
    return getMachine(store.get(machinesAtom), machineId);
  }

  function addMachine(machine: Machine) {
    store.set(machinesAtom, (current) => [...current, machine]);
    store.set(selectedIdAtom, machine.id);
  }

  function updateMachine(
    machineId: string,
    update: (machine: Machine) => Machine,
  ) {
    store.set(machinesAtom, (current) =>
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
    store.set(pendingPairMachineIdAtom, machineId);
  }

  function clearPendingPairMachine(machineId: string) {
    if (store.get(pendingPairMachineIdAtom) === machineId) {
      store.set(pendingPairMachineIdAtom, undefined);
    }
  }

  // Publish the collection and its fallback selection as one Jotai action.
  const deleteSelectedMachineAtom = atom(
    null,
    (get, set): Machine | undefined => {
      const selected = get(selectedAtom);
      if (!selected) return;
      const remaining = get(machinesAtom).filter(
        (machine) => machine.id !== selected.id,
      );
      set(machinesAtom, remaining);
      set(selectedIdAtom, (current) =>
        current === selected.id ? remaining[0]?.id : current,
      );
      return selected;
    },
  );

  function deleteSelectedMachine(): Machine | undefined {
    return store.set(deleteSelectedMachineAtom);
  }

  bunja.effect(() =>
    store.sub(machinesAtom, () => {
      saveMachines(store.get(machinesAtom), storage);
    }),
  );
  bunja.effect(() =>
    store.sub(selectedIdAtom, () => {
      saveSelectedMachineId(store.get(selectedIdAtom), storage);
    }),
  );

  return {
    machinesAtom,
    selectedIdAtom,
    selectedAtom,
    selectedIsPairedAtom,
    pendingPairMachineIdAtom,
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

  const machineAtom = atom((get) =>
    getMachine(get(machines.machinesAtom), machineId),
  );
  const isPairedAtom = atom((get) => isPaired(get(machineAtom)));

  return {
    machineId,
    machineAtom,
    isPairedAtom,
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
  return Boolean(machine?.clientId && machine?.clientSecret);
}
