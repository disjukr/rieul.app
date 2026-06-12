import { bunja } from "bunja";
import { atom } from "jotai";
import { CapabilitySet, listCapabilities } from "../protocol/rpc.ts";
import { connectionBunja } from "./connection.ts";
import { JotaiStoreScope } from "./jotai-store.ts";
import { machineStoreBunja } from "./machine-store.ts";

interface IdleCapabilityState {
  phase: "idle";
}

interface LoadingCapabilityState {
  phase: "loading";
}

interface ReadyCapabilityState {
  phase: "ready";
  capabilities: CapabilitySet;
}

interface ErrorCapabilityState {
  phase: "error";
  message: string;
}

type CapabilityState =
  | IdleCapabilityState
  | LoadingCapabilityState
  | ReadyCapabilityState
  | ErrorCapabilityState;

export const capabilityBunja = bunja(() => {
  const store = bunja.use(JotaiStoreScope);
  const connection = bunja.use(connectionBunja);
  const machines = bunja.use(machineStoreBunja);

  const capabilityAtom = atom<CapabilityState>({ phase: "idle" });
  const capabilityRefreshKeyAtom = atom((get) => {
    const machine = get(machines.selectedAtom);
    const connectionState = get(connection.connectionAtom);
    if (!machine || connectionState.phase !== "reachable") return "";
    return [
      machine.id,
      machine.baseUrl,
      get(connection.connectionEpochAtom),
    ].join("\n");
  });

  bunja.effect(() => {
    let runId = 0;

    function refreshCapabilities() {
      const currentRunId = ++runId;
      const machine = store.get(machines.selectedAtom);
      const connectionState = store.get(connection.connectionAtom);
      if (!machine || connectionState.phase !== "reachable") {
        store.set(capabilityAtom, { phase: "idle" });
        return;
      }

      store.set(capabilityAtom, { phase: "loading" });
      void (async () => {
        try {
          const capabilities = await listCapabilities(machine);
          if (currentRunId !== runId) return;
          store.set(capabilityAtom, { phase: "ready", capabilities });
        } catch (err) {
          if (currentRunId !== runId) return;
          store.set(capabilityAtom, {
            phase: "error",
            message: err instanceof Error ? err.message : String(err),
          });
        }
      })();
    }

    const unsubscribe = store.sub(
      capabilityRefreshKeyAtom,
      refreshCapabilities,
    );
    refreshCapabilities();
    return () => {
      runId++;
      unsubscribe();
    };
  });

  return {
    capabilityAtom,
  };
});
