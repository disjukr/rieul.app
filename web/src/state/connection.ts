import { bunja } from "bunja";
import { atom } from "jotai";
import { JotaiStoreScope } from "unsaturated/store";
import { checkReachable } from "../protocol/rpc.ts";
import { Machine } from "./machines.ts";
import { machineStoreBunja } from "./machine-store.ts";
import { ConnectionState } from "./types.ts";

const STATUS_PING_INTERVAL_MS = 5_000;

export const connectionBunja = bunja(() => {
  const store = bunja.use(JotaiStoreScope);
  const machines = bunja.use(machineStoreBunja);

  const connectionAtom = atom<ConnectionState>({
    phase: "idle",
    message: "No machine selected",
  });
  const connectionEpochAtom = atom(0);
  const selectedConnectionKeyAtom = atom((get) =>
    connectionKey(get(machines.selectedAtom))
  );

  let connectionReachable = false;
  let pingGeneration = 0;
  let stopped = false;
  let timer: ReturnType<typeof setTimeout> | undefined;

  function setChecking(message: string) {
    store.set(connectionAtom, { phase: "checking", message });
  }

  function markReachable(message: string, latencyMs?: number) {
    if (!connectionReachable) {
      store.set(connectionEpochAtom, (current) => current + 1);
    }
    connectionReachable = true;
    store.set(connectionAtom, { phase: "reachable", message, latencyMs });
  }

  function markOffline(message: string) {
    connectionReachable = false;
    store.set(connectionAtom, { phase: "offline", message });
  }

  function restartPingLoop() {
    clearPingTimer();
    const generation = nextPingGeneration();
    connectionReachable = false;
    const selected = store.get(machines.selectedAtom);
    if (!selected) {
      store.set(connectionAtom, {
        phase: "idle",
        message: "No machine selected",
      });
      return;
    }
    void pingStatus(selected, true, generation);
  }

  async function pingStatus(
    machine: Machine,
    showChecking: boolean,
    generation: number,
  ) {
    const key = connectionKey(machine);
    if (showChecking) setChecking("Checking transport");

    try {
      const reachability = await checkReachable(
        machine,
        machines.rpcCallOptions(),
      );
      if (!isCurrentPing(generation, key)) return;
      markReachable(
        formatReachability(reachability.latencyMs),
        reachability.latencyMs,
      );
    } catch (err) {
      if (!isCurrentPing(generation, key)) return;
      markOffline(connectionErrorMessage(err, machine));
    } finally {
      if (isCurrentPing(generation, key)) {
        timer = setTimeout(
          () => void pingStatus(machine, false, generation),
          STATUS_PING_INTERVAL_MS,
        );
      }
    }
  }

  function checkSelected() {
    restartPingLoop();
  }

  function clearPingTimer() {
    if (timer !== undefined) {
      clearTimeout(timer);
      timer = undefined;
    }
  }

  function nextPingGeneration(): number {
    pingGeneration += 1;
    return pingGeneration;
  }

  function isCurrentPing(generation: number, key: string): boolean {
    return !stopped &&
      pingGeneration === generation &&
      store.get(selectedConnectionKeyAtom) === key;
  }

  bunja.effect(() => {
    const unsubscribe = store.sub(selectedConnectionKeyAtom, restartPingLoop);
    restartPingLoop();
    return () => {
      stopped = true;
      nextPingGeneration();
      clearPingTimer();
      unsubscribe();
    };
  });

  return {
    connectionAtom,
    connectionEpochAtom,
    setChecking,
    markReachable,
    markOffline,
    checkSelected,
  };
});

function connectionKey(machine?: Machine): string {
  if (!machine) return "";
  return [
    machine.id,
    machine.baseUrl,
    machine.clientId ?? "",
    machine.clientSecret ?? "",
  ].join("\n");
}

function formatReachability(latencyMs?: number): string {
  if (latencyMs === undefined) return "Connected";
  return `${Math.max(1, Math.round(latencyMs))}ms`;
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

export function connectionErrorMessage(
  err: unknown,
  machine?: Machine,
): string {
  const message = errorMessage(err);
  if (!message.toLowerCase().includes("handshake")) return message;

  const host = machine ? safeHost(machine.baseUrl) : "";
  if (host === "localhost" || host === "127.0.0.1" || host === "::1") {
    return "WebTransport TLS handshake failed. Use the daemon URL printed by the pairing command; localhost will fail when the daemon certificate is issued for another host.";
  }
  return "WebTransport TLS handshake failed. Check that the daemon URL matches a trusted certificate host.";
}

function safeHost(raw: string): string {
  try {
    return new URL(raw).hostname.toLowerCase();
  } catch {
    return "";
  }
}
