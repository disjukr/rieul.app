import { bunja } from "bunja";
import { atom } from "jotai";
import { nowBunja } from "unsaturated/now";
import { JotaiStoreScope } from "unsaturated/store";
import { DaemonInfo, getDaemonInfo } from "../protocol/rpc.ts";
import { connectionBunja } from "./connection.ts";
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
  receivedAtMs: number;
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
  const now = bunja.use(nowBunja);

  const daemonInfoAtom = atom<DaemonInfoState>({ phase: "idle" });
  const daemonServerTimeMsAtom = atom((get) => {
    const daemonInfo = get(daemonInfoAtom);
    if (daemonInfo.phase !== "ready") return undefined;
    const { serverTimeMs } = daemonInfo.daemonInfo;
    if (serverTimeMs <= 0) return undefined;
    const elapsedMs = Math.max(
      0,
      get(now.nowEverySecondAtom) - daemonInfo.receivedAtMs,
    );
    return serverTimeMs + elapsedMs;
  });
  const daemonUptimeSecondsAtom = atom((get) => {
    const daemonInfo = get(daemonInfoAtom);
    if (daemonInfo.phase !== "ready") return undefined;
    const { startedAtMs } = daemonInfo.daemonInfo;
    if (startedAtMs <= 0) return undefined;
    const daemonServerTimeMs = get(daemonServerTimeMsAtom);
    if (daemonServerTimeMs === undefined) return undefined;
    const uptimeSeconds = Math.floor(
      (daemonServerTimeMs - startedAtMs) / 1000,
    );
    return Math.max(0, uptimeSeconds);
  });
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
          store.set(daemonInfoAtom, {
            phase: "ready",
            daemonInfo,
            receivedAtMs: Date.now(),
          });
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
    daemonServerTimeMsAtom,
    daemonUptimeSecondsAtom,
  };
});
