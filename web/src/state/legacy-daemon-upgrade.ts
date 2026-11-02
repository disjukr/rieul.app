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
  legacyUpgrade,
  offersLegacyUpgrade,
  isLegacyInstalledVersion,
  type LegacyUpdateStatus,
} from "../protocol/legacy-upgrade.ts";

export const legacyDaemonUpgradeBunja = bunja(() => {
  const rpc = bunja.use(rpcSessionBunja);
  const owner = getOwner();
  const supported = createMemo(() => {
    const info = rpc.daemonInfo();
    return info.phase === "ready" && offersLegacyUpgrade(info.daemonInfo);
  });
  const [status, setStatus] = createSignal<LegacyUpdateStatus>();
  const [message, setMessage] = createSignal<string>();
  const [busy, setBusy] = createSignal(false);
  const [revision, setRevision] = createSignal(0);
  const verified = createMemo(
    () => supported() && isLegacyInstalledVersion(status()?.currentVersion),
  );
  const confirmationToken = createMemo(
    () => `${revision()}:${status()?.targetVersion ?? ""}`,
  );
  let active = false,
    pending = false,
    generation = 0;
  async function request(action: "status" | "check" | "install") {
    if (
      !active ||
      pending ||
      !supported() ||
      (action !== "status" && !verified())
    )
      return;
    const token = generation,
      info = rpc.daemonInfo();
    const current = () =>
      active &&
      token === generation &&
      info === rpc.daemonInfo() &&
      supported();
    pending = true;
    setBusy(true);
    setMessage(undefined);
    try {
      // This is the existing session's authenticated transport. Never pair,
      // copy credentials, open another session, or fall back after auth failure.
      const transport = await rpc.webTransport();
      if (!current()) return;
      const next = await legacyUpgrade(transport, action);
      if (!current()) return;
      setStatus(next);
      setRevision((n) => n + 1);
      if (!isLegacyInstalledVersion(next.currentVersion))
        setMessage(
          "The installed version could not be confirmed as a supported older release (0.6.16–0.6.18). Reconnect and read status again; no update will be sent.",
        );
      else if (action === "install")
        setMessage(
          "Installation requested. Active work may defer it. Reconnect after the server restarts.",
        );
      else if (action === "check")
        setMessage(
          "Check requested. Use Read update status to see progress; this upgrade tool does not poll.",
        );
    } catch {
      if (current()) {
        setStatus(undefined);
        setRevision((n) => n + 1);
        setMessage(
          action === "install"
            ? "Installation acknowledgement was lost or rejected. Reconnect and read status before retrying; the server may have accepted it."
            : "Legacy update request failed. Check the connection and read status again. No automatic retry was sent.",
        );
      }
    } finally {
      if (current()) {
        pending = false;
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
          pending = false;
          setBusy(false);
          setStatus(undefined);
          setMessage(undefined);
          setRevision((n) => n + 1);
        });
        return dispose;
      }),
    );
    return () => {
      active = false;
      generation++;
      dispose();
    };
  });
  return {
    supported,
    verified,
    status,
    message,
    busy,
    confirmationToken,
    readStatus: () => request("status"),
    check: () => request("check"),
    reconnect: () => rpc.reconnect(),
    installConfirmed: (token: string) =>
      token === confirmationToken() &&
      status()?.canInstall &&
      status()?.targetVersion
        ? request("install")
        : Promise.resolve(),
  };
});
