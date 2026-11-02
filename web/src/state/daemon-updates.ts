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
  checkForUpdates,
  installUpdateConfirmed,
} from "../protocol/generated/client.ts";
import {
  subscribeUpdateStatusProc,
  ProcId,
  UpdatePhase,
  type UpdateStatus,
} from "../protocol/generated/rpc.ts";

import { callServerStream } from "../protocol/client.ts";

export const daemonUpdatesBunja = bunja(() => {
  const rpc = bunja.use(rpcSessionBunja);
  const owner = getOwner();
  const [storedStatus, setStatus] = createSignal<UpdateStatus>();
  const [checking, setChecking] = createSignal(false);
  const status = createMemo(() =>
    checking()
      ? {
          ...storedStatus(),
          phase: UpdatePhase.Checking,
          canInstall: false,
          reason: undefined,
        }
      : storedStatus(),
  );
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
      info.daemonInfo.supportedProcIds.includes(ProcId.SubscribeUpdateStatus) &&
      info.daemonInfo.supportedProcIds.includes(ProcId.CheckForUpdates) &&
      info.daemonInfo.supportedProcIds.includes(ProcId.InstallUpdateConfirmed)
    );
  });
  let subscription: AbortController | undefined;
  let retry: ReturnType<typeof setTimeout> | undefined;
  const retiredEpochs = new Set<string>();
  function accept(
    next: UpdateStatus,
    source: "subscription" | "command" | "query",
  ) {
    const current = storedStatus()?.ordering;
    const order = next.ordering;
    if (current) {
      if (!order || retiredEpochs.has(order.epoch)) return;
      if (current.epoch === order.epoch) {
        if (order.revision <= current.revision) return;
      } else {
        if (source !== "subscription") return;
        retiredEpochs.add(current.epoch);
      }
    }
    setStatus(next);
    setChecking(false);
    setMessage(undefined);
  }
  async function subscribe(token: number) {
    subscription?.abort();
    const controller = new AbortController();
    subscription = controller;
    try {
      const transport = await rpc.webTransport();
      if (!active || token !== generation || controller.signal.aborted) return;
      for await (const next of callServerStream(
        transport,
        subscribeUpdateStatusProc,
        undefined,
        controller.signal,
      )) {
        if (!active || token !== generation || controller.signal.aborted)
          return;
        accept(next, "subscription");
      }
      if (!controller.signal.aborted)
        throw new Error("Update subscription ended");
    } catch {
      if (active && token === generation && !controller.signal.aborted) {
        setMessage("Update status disconnected. Reconnecting…");
        retry = setTimeout(() => void subscribe(token), 1000);
      }
    }
  }
  let active = false,
    generation = 0,
    requestPending = false;
  async function refresh() {
    if (active && supported()) {
      clearTimeout(retry);
      await subscribe(generation);
    }
  }
  async function request(action: "check" | "install") {
    if (!active || requestPending || !supported()) return;
    const token = generation;
    requestPending = true;
    setBusy(true);
    if (action === "check") {
      setChecking(true);
      setMessage(undefined);
    }
    try {
      const transport = await rpc.webTransport();
      if (!active || token !== generation) return;
      const next = await (action === "check"
        ? checkForUpdates(transport)
        : installUpdateConfirmed(transport));
      if (active && token === generation) {
        accept(next, "command");
      }
    } catch {
      if (active && token === generation)
        setMessage(
          action === "install"
            ? "Installation request could not be confirmed. Reconnect and check status before retrying."
            : "Update check failed. Try again.",
        );
    } finally {
      if (active && token === generation) {
        requestPending = false;
        setBusy(false);
        setChecking(false);
      }
    }
  }
  bunja.effect(() => {
    active = true;
    const dispose = runWithOwner(owner, () =>
      createRoot((dispose) => {
        createEffect(rpc.daemonInfo, () => {
          generation++;
          subscription?.abort();
          clearTimeout(retry);
          retiredEpochs.clear();
          requestPending = false;
          setSessionEpoch(generation);
          setStatus(undefined);
          setChecking(false);
          setBusy(false);
          setMessage(undefined);
          if (supported()) void subscribe(generation);
          else if (rpc.daemonInfo().phase === "ready")
            setMessage(
              "Update management requires a newer daemon. Upgrade the daemon to use this client.",
            );
        });
        return dispose;
      }),
    );
    return () => {
      active = false;
      generation++;
      requestPending = false;
      subscription?.abort();
      clearTimeout(retry);
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
    check: () => request("check"),
    installConfirmed: (expectedToken: string) =>
      expectedToken === confirmationToken() && status()?.canInstall
        ? request("install")
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
