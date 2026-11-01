import { bunja } from "bunja";
import {
  createSignal,
  createMemo,
  createEffect,
  createRoot,
  getOwner,
  runWithOwner,
} from "solid-js";
import { rpcSessionBunja } from "./rpc-session.ts";
import {
  getUpdateStatus,
  requestUpdate,
} from "../protocol/generated/client.ts";
import {
  ProcId,
  UpdateAction,
  UpdatePhase,
  type UpdateStatus,
} from "../protocol/generated/rpc.ts";

export const daemonUpdatesBunja = bunja(() => {
  const rpc = bunja.use(rpcSessionBunja);
  const owner = getOwner();
  const [status, setStatus] = createSignal<UpdateStatus>();
  const [message, setMessage] = createSignal<string>();
  const [busy, setBusy] = createSignal(false);
  const [sessionEpoch, setSessionEpoch] = createSignal(0);
  const confirmationToken = createMemo(
    () => `${sessionEpoch()}:${status()?.targetVersion ?? ""}`,
  );
  const supported = createMemo(() => {
    const info = rpc.daemonInfo();
    return (
      info.phase === "ready" &&
      info.daemonInfo.supportedProcIds.includes(ProcId.GetUpdateStatus) &&
      info.daemonInfo.supportedProcIds.includes(ProcId.RequestUpdate)
    );
  });
  let active = false,
    generation = 0,
    refreshPending = false,
    requestPending = false;
  async function refresh() {
    if (!active || refreshPending || !supported()) return;
    const token = generation;
    refreshPending = true;
    try {
      const transport = await rpc.webTransport();
      if (!active || token !== generation) return;
      const next = await getUpdateStatus(transport);
      if (active && token === generation) {
        setStatus(next);
        setMessage(undefined);
      }
    } catch {
      if (active && token === generation)
        setMessage("Update status unavailable. Reconnect or try again.");
    } finally {
      if (token === generation) refreshPending = false;
    }
  }
  async function request(action: UpdateAction, confirmed = false) {
    if (!active || requestPending || !supported()) return;
    if (action === UpdateAction.InstallConfirmed && !confirmed) return;
    const token = generation;
    requestPending = true;
    setBusy(true);
    try {
      const transport = await rpc.webTransport();
      if (!active || token !== generation) return;
      const next = await requestUpdate(transport, { action, confirmed });
      if (active && token === generation) {
        setStatus(next);
        setMessage(undefined);
      }
    } catch {
      if (active && token === generation)
        setMessage(
          action === UpdateAction.InstallConfirmed
            ? "Installation request could not be confirmed. Reconnect and check status before retrying."
            : "Update check failed. Try again.",
        );
    } finally {
      if (active && token === generation) {
        requestPending = false;
        setBusy(false);
      }
    }
  }
  bunja.effect(() => {
    active = true;
    const dispose = runWithOwner(owner, () =>
      createRoot((dispose) => {
        createEffect(rpc.daemonInfo, () => {
          generation++;
          refreshPending = false;
          requestPending = false;
          setSessionEpoch(generation);
          setStatus(undefined);
          setBusy(false);
          setMessage(undefined);
          void refresh();
        });
        return dispose;
      }),
    );
    const interval = setInterval(() => void refresh(), 5000);
    return () => {
      active = false;
      generation++;
      refreshPending = false;
      requestPending = false;
      clearInterval(interval);
      dispose();
    };
  });
  return {
    status,
    message,
    busy,
    supported,
    confirmationToken,
    refresh,
    check: () => request(UpdateAction.Check),
    installConfirmed: (expectedToken: string) =>
      expectedToken === confirmationToken() && status()?.canInstall
        ? request(UpdateAction.InstallConfirmed, true)
        : Promise.resolve(),
  };
});

export function updatePhaseLabel(phase: UpdatePhase): string {
  return {
    [UpdatePhase.Unavailable]: "Unavailable",
    [UpdatePhase.Idle]: "Idle",
    [UpdatePhase.Checking]: "Checking",
    [UpdatePhase.Downloading]: "Downloading",
    [UpdatePhase.Verifying]: "Verifying",
    [UpdatePhase.Ready]: "Ready to install",
    [UpdatePhase.Deferred]: "Waiting",
    [UpdatePhase.Installing]: "Installing",
    [UpdatePhase.Restarting]: "Restarting",
    [UpdatePhase.Failed]: "Failed",
  }[phase];
}
