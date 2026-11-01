import { bunja } from "bunja";
import { atom } from "jotai/vanilla";
import { JotaiStoreScope } from "./jotai-store.ts";
import { rpcSessionBunja } from "./rpc-session.ts";
import { getUpdateStatus, requestUpdate } from "../protocol/generated/client.ts";
import { ProcId, UpdateAction, UpdatePhase, type UpdateStatus } from "../protocol/generated/rpc.ts";

export const daemonUpdatesBunja = bunja(() => {
  const store = bunja.use(JotaiStoreScope);
  const rpc = bunja.use(rpcSessionBunja);
  const statusAtom = atom<UpdateStatus | undefined>(undefined);
  const messageAtom = atom<string | undefined>(undefined);
  const busyAtom = atom(false);
  const sessionEpochAtom = atom(0);
  const confirmationTokenAtom = atom((get) => `${get(sessionEpochAtom)}:${get(statusAtom)?.targetVersion ?? ""}`);
  const supportedAtom = atom((get) => {
    const info = get(rpc.daemonInfoAtom);
    return info.phase === "ready" && info.daemonInfo.supportedProcIds.includes(ProcId.GetUpdateStatus) && info.daemonInfo.supportedProcIds.includes(ProcId.RequestUpdate);
  });
  let active = false, generation = 0, refreshPending = false;
  async function refresh() {
    if (!active || refreshPending || !store.get(supportedAtom)) return;
    const token = generation;
    refreshPending = true;
    try {
      const status = await getUpdateStatus(await rpc.webTransport());
      if (active && token === generation) { store.set(statusAtom, status); store.set(messageAtom, undefined); }
    } catch {
      if (active && token === generation) store.set(messageAtom, "Update status unavailable. Reconnect or try again.");
    } finally { if (token === generation) refreshPending = false; }
  }
  async function request(action: UpdateAction, confirmed = false) {
    if (!active || store.get(busyAtom) || !store.get(supportedAtom)) return;
    if (action === UpdateAction.InstallConfirmed && !confirmed) return;
    const token = generation;
    store.set(busyAtom, true);
    try {
      const transport = await rpc.webTransport();
      if (!active || token !== generation) return;
      const status = await requestUpdate(transport, { action, confirmed });
      if (active && token === generation) { store.set(statusAtom, status); store.set(messageAtom, undefined); }
    } catch {
      if (active && token === generation) store.set(messageAtom, action === UpdateAction.InstallConfirmed ? "Installation request could not be confirmed. Reconnect and check status before retrying." : "Update check failed. Try again.");
    } finally { if (active && token === generation) store.set(busyAtom, false); }
  }
  bunja.effect(() => {
    active = true;
    function reset() {
      generation++; refreshPending = false;
      store.set(sessionEpochAtom, generation);
      store.set(statusAtom, undefined); store.set(busyAtom, false); store.set(messageAtom, undefined);
      void refresh();
    }
    const unsubscribe = store.sub(rpc.daemonInfoAtom, reset);
    const interval = setInterval(() => void refresh(), 5000);
    reset();
    return () => { active = false; generation++; refreshPending = false; clearInterval(interval); unsubscribe(); };
  });
  return { statusAtom, messageAtom, busyAtom, supportedAtom, confirmationTokenAtom, refresh,
    check: () => request(UpdateAction.Check),
    installConfirmed: (expectedToken: string) => expectedToken === store.get(confirmationTokenAtom) && store.get(statusAtom)?.canInstall ? request(UpdateAction.InstallConfirmed, true) : Promise.resolve(),
  };
});

export function updatePhaseLabel(phase: UpdatePhase): string {
  return ({
    [UpdatePhase.Unavailable]: "Unavailable", [UpdatePhase.Idle]: "Idle",
    [UpdatePhase.Checking]: "Checking", [UpdatePhase.Downloading]: "Downloading",
    [UpdatePhase.Verifying]: "Verifying", [UpdatePhase.Ready]: "Ready to install",
    [UpdatePhase.Deferred]: "Waiting", [UpdatePhase.Installing]: "Installing",
    [UpdatePhase.Restarting]: "Restarting", [UpdatePhase.Failed]: "Failed",
  })[phase];
}
