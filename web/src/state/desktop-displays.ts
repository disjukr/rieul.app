import { bunja } from "bunja";
import {
  createMemo,
  createSignal,
  createEffect,
  createRoot,
  getOwner,
  runWithOwner,
} from "solid-js";
import { listDisplays } from "../protocol/generated/client.ts";
import { ProcId, type DesktopDisplay } from "../protocol/generated/rpc.ts";
import { MachineIdScope } from "./machine-scopes.ts";
import { rpcSessionBunja, type DaemonInfoState } from "./rpc-session.ts";

// Metadata only. Mounting the rail must never attach video, reserve an encoder,
// poll the desktop, or acquire input control.
export const desktopDisplaysBunja = bunja(() => {
  bunja.use(MachineIdScope);
  const rpc = bunja.use(rpcSessionBunja);
  type Snapshot = {
    info: DaemonInfoState;
    displays: DesktopDisplay[];
    revision: number;
    source?: symbol;
  };
  const [snapshots, setSnapshots] = createSignal<Snapshot[]>([]);
  let revision = 0;
  let active = false;
  let request: Promise<void> | undefined;
  let requestInfo: DaemonInfoState | undefined;
  const owner = getOwner();
  const displays = createMemo(() => {
    const info = rpc.daemonInfo();
    if (info.phase !== "ready") return [];
    return (
      snapshots()
        .filter((s) => s.info === info)
        .sort((a, b) => b.revision - a.revision)[0]?.displays ?? []
    );
  });
  function publish(source: symbol, values: DesktopDisplay[]) {
    const info = rpc.daemonInfo();
    if (info.phase !== "ready") return;
    const next = { info, displays: values, source, revision: ++revision };
    setSnapshots((current) => [
      ...current.filter(
        (s) => s.source !== undefined && s.source !== source && s.info === info,
      ),
      next,
    ]);
  }
  function clear(source: symbol) {
    setSnapshots((current) => current.filter((s) => s.source !== source));
  }
  function refresh(): Promise<void> {
    const info = rpc.daemonInfo();
    if (
      !active ||
      info.phase !== "ready" ||
      !info.daemonInfo.supportedProcIds.includes(ProcId.ListDisplays)
    )
      return Promise.resolve();
    if (request && requestInfo === info) return request;
    const token = ++revision;
    requestInfo = info;
    const next = (async () => {
      try {
        const transport = await rpc.webTransport();
        if (!active || rpc.daemonInfo() !== info || token !== revision) return;
        const { displays: values } = await listDisplays(transport);
        if (!active || rpc.daemonInfo() !== info || token !== revision) return;
        setSnapshots((current) => [
          ...current.filter((s) => s.source !== undefined && s.info === info),
          { info, displays: values, revision: token },
        ]);
      } catch {
        if (active && rpc.daemonInfo() === info && token === revision)
          setSnapshots((current) =>
            current.filter((s) => s.source !== undefined),
          );
      } finally {
        if (requestInfo === info) {
          request = undefined;
          requestInfo = undefined;
        }
      }
    })();
    request = next;
    return next;
  }
  bunja.effect(() => {
    active = true;
    const dispose = runWithOwner(owner, () =>
      createRoot((dispose) => {
        createEffect(
          () => rpc.daemonInfo(),
          () => {
            ++revision;
            setSnapshots([]);
            void refresh();
          },
        );
        return dispose;
      }),
    );
    return () => {
      active = false;
      ++revision;
      dispose();
      setSnapshots([]);
    };
  });
  return { displays, refresh, publish, clear };
});
