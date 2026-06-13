import { bunja } from "bunja";
import { atom } from "jotai";
import {
  isInvalidCredentialsError,
  renewClientCredential,
} from "../protocol/rpc.ts";
import { loadMachines, Machine, saveMachines } from "./machines.ts";
import { JotaiStoreScope } from "./jotai-store.ts";
import { MachineIdScope } from "./machine-id.tsx";

const initialMachines = loadMachines();
const CREDENTIAL_RENEWAL_LEAD_MS = 7 * 24 * 60 * 60 * 1000;
const CREDENTIAL_RENEWAL_RETRY_MS = 60 * 1000;
const MAX_RENEWAL_TIMER_MS = 24 * 60 * 60 * 1000;

export const machineStoreBunja = bunja(() => {
  const store = bunja.use(JotaiStoreScope);

  const machinesAtom = atom<Machine[]>(initialMachines);
  const selectedIdAtom = atom<string | undefined>(initialMachines[0]?.id);
  const selectedAtom = atom((get) =>
    getMachine(get(machinesAtom), get(selectedIdAtom))
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
    store.set(
      machinesAtom,
      (current) =>
        current.map((machine) =>
          machine.id === machineId ? update(machine) : machine
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

  function deleteSelectedMachine(): Machine | undefined {
    const selected = store.get(selectedAtom);
    if (!selected) return undefined;
    const remaining = store.get(machinesAtom).filter((machine) =>
      machine.id !== selected.id
    );
    store.set(machinesAtom, remaining);
    store.set(
      selectedIdAtom,
      (current) => current === selected.id ? remaining[0]?.id : current,
    );
    return selected;
  }

  bunja.effect(() =>
    store.sub(machinesAtom, () => {
      saveMachines(store.get(machinesAtom));
    })
  );

  bunja.effect(() => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    let stopped = false;
    let renewingKey = "";

    function clearTimer() {
      if (timer !== undefined) {
        clearTimeout(timer);
        timer = undefined;
      }
    }

    function schedule() {
      clearTimer();
      if (stopped) return;
      const selected = store.get(selectedAtom);
      if (
        !selected?.clientId || !selected.clientSecret ||
        !selected.clientCredentialExpiresAtUnix
      ) {
        return;
      }
      const renewAtMs = selected.clientCredentialExpiresAtUnix * 1000 -
        CREDENTIAL_RENEWAL_LEAD_MS;
      const delayMs = Math.min(
        Math.max(0, renewAtMs - Date.now()),
        MAX_RENEWAL_TIMER_MS,
      );
      timer = setTimeout(() => void renewSelected(), delayMs);
    }

    async function renewSelected() {
      const selected = store.get(selectedAtom);
      if (!selected?.clientId || !selected.clientSecret) return;
      const key = machineCredentialKey(selected);
      if (renewingKey === key) return;
      renewingKey = key;
      let retryScheduled = false;
      try {
        const { clientCredentialExpiresAtUnix } = await renewClientCredential(
          selected,
        );
        if (!stopped && machineCredentialKey(store.get(selectedAtom)) === key) {
          setMachineCredentialExpiry(
            selected.id,
            clientCredentialExpiresAtUnix,
          );
        }
      } catch (err) {
        if (!stopped && machineCredentialKey(store.get(selectedAtom)) === key) {
          if (isInvalidCredentialsError(err)) {
            clearMachineCredentials(selected.id);
          } else {
            clearTimer();
            timer = setTimeout(
              () => void renewSelected(),
              CREDENTIAL_RENEWAL_RETRY_MS,
            );
            retryScheduled = true;
          }
        }
      } finally {
        if (renewingKey === key) renewingKey = "";
        if (!stopped && !retryScheduled) schedule();
      }
    }

    const unsubscribeMachines = store.sub(machinesAtom, schedule);
    const unsubscribeSelected = store.sub(selectedIdAtom, schedule);
    schedule();
    return () => {
      stopped = true;
      clearTimer();
      unsubscribeMachines();
      unsubscribeSelected();
    };
  });

  return {
    machinesAtom,
    selectedIdAtom,
    selectedAtom,
    selectedIsPairedAtom,
    selectMachine,
    findMachine,
    addMachine,
    updateMachine,
    setMachineCredentials,
    clearMachineCredentials,
    setMachineCredentialExpiry,
    deleteSelectedMachine,
  };
});

export const machineBunja = bunja(() => {
  const machineId = bunja.use(MachineIdScope);
  const machines = bunja.use(machineStoreBunja);

  const machineAtom = atom((get) =>
    getMachine(get(machines.machinesAtom), machineId)
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

export function isPaired(machine?: Machine): boolean {
  return Boolean(machine?.clientId && machine?.clientSecret);
}

function machineCredentialKey(machine?: Machine): string {
  if (!machine) return "";
  return [
    machine.id,
    machine.baseUrl,
    machine.clientId ?? "",
    machine.clientSecret ?? "",
  ].join("\n");
}
