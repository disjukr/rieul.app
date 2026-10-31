import { bunja } from "bunja";
import { atom } from "jotai/vanilla";
import { JotaiStoreScope } from "./jotai-store.ts";
import { subscribeProcesses } from "../protocol/generated/client.ts";
import {
  ProcId,
  type ProcessInfo,
  type ProcessesTableEvent,
} from "../protocol/generated/rpc.ts";
import { rpcSessionBunja } from "./rpc-session.ts";

interface ProcessesState {
  message?: string;
  phase: "loading" | "ready" | "error" | "unsupported";
  rows: ProcessInfo[];
}

export const processesBunja = bunja(() => {
  const store = bunja.use(JotaiStoreScope);
  const session = bunja.use(rpcSessionBunja);
  const stateAtom = atom<ProcessesState>({ phase: "loading", rows: [] });

  bunja.effect(() => {
    let stop: (() => void) | undefined;
    function start() {
      stop?.();
      stop = undefined;
      const info = store.get(session.daemonInfoAtom);
      if (info.phase === "error") {
        store.set(stateAtom, {
          phase: "error",
          message: "Daemon info unavailable",
          rows: [],
        });
        return;
      }
      if (info.phase !== "ready") {
        store.set(stateAtom, { phase: "loading", rows: [] });
        return;
      }
      if (
        !info.daemonInfo.supportedProcIds.includes(ProcId.SubscribeProcesses)
      ) {
        store.set(stateAtom, {
          phase: "unsupported",
          message: "This daemon does not support process subscriptions.",
          rows: [],
        });
        return;
      }

      store.set(stateAtom, { phase: "loading", rows: [] });
      let cancelled = false;
      let iterator: AsyncGenerator<ProcessesTableEvent> | undefined;
      stop = () => {
        cancelled = true;
        void iterator?.return(undefined).catch(() => {});
      };
      void (async () => {
        try {
          const transport = await session.webTransport();
          if (cancelled) return;
          iterator = subscribeProcesses(transport);
          for await (const event of iterator) {
            if (cancelled) return;
            store.set(stateAtom, (current) => ({
              phase: "ready",
              rows: applyProcessesEvent(current.rows, event),
            }));
          }
        } catch (error) {
          if (!cancelled)
            store.set(stateAtom, {
              phase: "error",
              rows: [],
              message: error instanceof Error ? error.message : String(error),
            });
        }
      })();
    }
    const unsubscribe = store.sub(session.daemonInfoAtom, start);
    start();
    return () => {
      unsubscribe();
      stop?.();
    };
  });
  return { stateAtom };
});

function applyProcessesEvent(
  currentRows: ProcessInfo[],
  event: ProcessesTableEvent,
): ProcessInfo[] {
  if (event.type === "snapshot") {
    return sortedProcesses(event.rows);
  }

  const rowsByPid = new Map(currentRows.map((row) => [row.pid, row]));
  for (const pid of event.removePids) {
    rowsByPid.delete(pid);
  }
  for (const row of event.upserts) {
    rowsByPid.set(row.pid, row);
  }
  return sortedProcesses([...rowsByPid.values()]);
}

function sortedProcesses(rows: ProcessInfo[]): ProcessInfo[] {
  return [...rows].sort((a, b) => a.pid - b.pid);
}
