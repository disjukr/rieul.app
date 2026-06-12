import { bunja } from "bunja";
import { atom } from "jotai";
import { DaemonInfo, getDaemonInfo } from "../protocol/rpc.ts";
import { connectionBunja } from "./connection.ts";
import { JotaiStoreScope } from "./jotai-store.ts";
import { machineStoreBunja } from "./machine-store.ts";

interface IdleDaemonInfoState {
  phase: "idle";
}

interface LoadingDaemonInfoState {
  phase: "loading";
}

interface ReadyDaemonInfoState {
  phase: "ready";
  daemonInfo: DaemonInfo;
}

interface ErrorDaemonInfoState {
  phase: "error";
  message: string;
}

type DaemonInfoState =
  | IdleDaemonInfoState
  | LoadingDaemonInfoState
  | ReadyDaemonInfoState
  | ErrorDaemonInfoState;

export const daemonInfoBunja = bunja(() => {
  const store = bunja.use(JotaiStoreScope);
  const connection = bunja.use(connectionBunja);
  const machines = bunja.use(machineStoreBunja);

  const daemonInfoAtom = atom<DaemonInfoState>({ phase: "idle" });
  const daemonInfoRefreshKeyAtom = atom((get) => {
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

    function refreshDaemonInfo() {
      const currentRunId = ++runId;
      const machine = store.get(machines.selectedAtom);
      const connectionState = store.get(connection.connectionAtom);
      if (!machine || connectionState.phase !== "reachable") {
        store.set(daemonInfoAtom, { phase: "idle" });
        return;
      }

      store.set(daemonInfoAtom, { phase: "loading" });
      void (async () => {
        try {
          const daemonInfo = await getDaemonInfo(machine);
          if (currentRunId !== runId) return;
          store.set(daemonInfoAtom, { phase: "ready", daemonInfo });
        } catch (err) {
          if (currentRunId !== runId) return;
          store.set(daemonInfoAtom, {
            phase: "error",
            message: err instanceof Error ? err.message : String(err),
          });
        }
      })();
    }

    const unsubscribe = store.sub(
      daemonInfoRefreshKeyAtom,
      refreshDaemonInfo,
    );
    refreshDaemonInfo();
    return () => {
      runId++;
      unsubscribe();
    };
  });

  return {
    daemonInfoAtom,
  };
});
