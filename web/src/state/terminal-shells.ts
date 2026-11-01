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
import { subscribeAvailableShells } from "../protocol/generated/client.ts";
import type {
  AvailableShellInfo,
  AvailableShellsTableEvent,
} from "../protocol/generated/rpc.ts";
import { machineBunja } from "./machine-store.ts";
import type { Machine } from "./machines.ts";
import { rpcSessionBunja } from "./rpc-session.ts";
export const terminalShellsBunja = bunja(() => {
  const machines = bunja.use(machineBunja);
  const rpcSession = bunja.use(rpcSessionBunja);
  const [terminalShells, setTerminalShells] = createSignal<
    AvailableShellInfo[]
  >([]);
  const defaultShell = createMemo(() => {
    const shells = terminalShells();
    return shells.find((item) => item.isDefault) ?? shells[0];
  });
  const subscriptionKey = createMemo(() =>
    terminalShellsSubscriptionKey(
      machines.machine(),
      machines.isPaired(),
      rpcSession.daemonInstanceId(),
    ),
  );
  const owner = getOwner();
  bunja.effect(() => {
    let stopCurrent: (() => void) | undefined;
    function start() {
      stopCurrent?.();
      stopCurrent = undefined;
      setTerminalShells([]);
      const machine = untrack(machines.machine);
      if (!machine || !untrack(machines.isPaired)) return;
      let cancelled = false;
      let iterator: AsyncGenerator<AvailableShellsTableEvent> | undefined;
      stopCurrent = () => {
        cancelled = true;
        void iterator?.return(undefined).catch(() => {});
      };
      void (async () => {
        try {
          const transport = await rpcSession.webTransport();
          if (cancelled) return;
          iterator = subscribeAvailableShells(transport);
          for await (const event of iterator) {
            if (cancelled) break;
            if (event.type === "snapshot") {
              setTerminalShells(event.rows);
            } else {
              setTerminalShells((current) => applyShellPatch(current, event));
            }
          }
        } catch {
          if (!cancelled) setTerminalShells([]);
        }
      })();
    }
    const dispose = runWithOwner(owner, () =>
      createRoot((dispose) => {
        createEffect(subscriptionKey, () => start());
        return dispose;
      }),
    );
    return () => {
      dispose();
      stopCurrent?.();
    };
  });
  return {
    defaultShell,
    terminalShells,
  };
});
function terminalShellsSubscriptionKey(
  machine: Machine | undefined,
  isPaired: boolean,
  daemonInstanceId: string | undefined,
): string {
  if (!machine || !isPaired || !daemonInstanceId) return "idle";
  return [
    machine.id,
    machine.baseUrl,
    machine.clientId ?? "",
    machine.clientSecret ?? "",
    daemonInstanceId,
  ].join("\n");
}
function applyShellPatch(
  current: AvailableShellInfo[],
  event: Extract<
    AvailableShellsTableEvent,
    {
      type: "patch";
    }
  >,
): AvailableShellInfo[] {
  const removeIds = new Set(event.removes.map((item) => item.shellId));
  const retained = current.filter((shell) => !removeIds.has(shell.shellId));
  const upserts = new Map(event.upserts.map((shell) => [shell.shellId, shell]));
  return [
    ...retained.filter((shell) => !upserts.has(shell.shellId)),
    ...event.upserts,
  ];
}
