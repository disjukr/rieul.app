import type { ClusterState } from "../../../../protocol/generated/rpc.ts";
import { hex } from "../../../../cluster/trust.ts";
import { createSignal, createEffect } from "solid-js";
import { useBunja } from "bunja/solid";
import { rpcSessionBunja } from "../../../../state/rpc-session.ts";
import { machineStoreBunja } from "../../../../state/machine-store.ts";
import {
  createCluster,
  joinCluster,
  leaveCluster,
  cancelJoin,
} from "../../../../cluster/manage.ts";
import { Button } from "../../../ui/button.tsx";
import { style, theme } from "../../../../zyzz.config.ts";
export function ClusterSection() {
  const session = useBunja(rpcSessionBunja),
    machines = useBunja(machineStoreBunja);
  const [busy, setBusy] = createSignal(false),
    [error, setError] = createSignal<string>(),
    [confirmation, setConfirmation] = createSignal<
      "create" | "join" | "leave" | "cancelJoin"
    >(),
    [source, setSource] = createSignal("");
  createEffect(
    () => machines().selectedId(),
    () => {
      setConfirmation(undefined);
      setError(undefined);
    },
  );
  const status = () => session().cluster();
  const state = () => status().state;
  const candidates = () =>
    machines()
      .machines()
      .filter(
        (m) =>
          m.id !== machines().selectedId() && (m.cluster || m.clientSecret),
      );
  async function perform() {
    const action = confirmation();
    const targetId = machines().selectedId();
    if (!action || busy()) return;
    setBusy(true);
    setError(undefined);
    try {
      const transport = await session().webTransport();
      let membership: ClusterState | undefined;
      if (action === "create") membership = await createCluster(transport);
      if (action === "join") {
        const selected = candidates().find((m) => m.id === source());
        if (!selected) throw new Error("Choose a cluster member");
        membership = await joinCluster(transport, selected);
      }
      if (action === "cancelJoin") {
        const selected = candidates().find((m) => m.id === source());
        if (!selected)
          throw new Error(
            "Choose a cluster member for removal synchronization",
          );
        await cancelJoin(transport, selected);
      }
      if (action === "leave") await leaveCluster(transport);
      if (targetId && membership?.type === "member") {
        const cluster = {
          id: hex(membership.head.clusterId),
          admissionId: hex(membership.localAdmissionId),
        };
        machines().updateMachine(targetId, (machine) => ({
          ...machine,
          cluster,
        }));
      }
      setConfirmation(undefined);
      await new Promise((resolve) => setTimeout(resolve, 0));
      await session().refreshCluster();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      await session().refreshCluster();
    } finally {
      setBusy(false);
    }
  }
  return (
    <section {...styles.section()} aria-label="Cluster">
      <h3>Cluster</h3>
      <p role="status">{status().message}</p>
      {error() ? <p role="alert">{error()}</p> : null}
      {status().supported ? (
        <>
          <div {...styles.actions()}>
            {state()?.type === "unaffiliated" || state()?.type === "removed" ? (
              <Button
                disabled={busy()}
                onClick={() => setConfirmation("create")}
              >
                Create cluster…
              </Button>
            ) : null}
            {state()?.type === "unaffiliated" ||
            state()?.type === "removed" ||
            state()?.type === "joining" ? (
              <Button
                disabled={busy() || !candidates().length}
                onClick={() => setConfirmation("join")}
              >
                {state()?.type === "joining"
                  ? "Resume joining…"
                  : "Join cluster…"}
              </Button>
            ) : null}
            {state()?.type === "joining" ||
            state()?.type === "removalPending" ? (
              <Button
                disabled={busy()}
                onClick={() => setConfirmation("cancelJoin")}
              >
                {state()?.type === "joining"
                  ? "Cancel joining…"
                  : "Finish join cleanup…"}
              </Button>
            ) : null}
            {state()?.type === "member" ? (
              <Button
                disabled={busy()}
                onClick={() => setConfirmation("leave")}
              >
                Leave cluster…
              </Button>
            ) : null}
            <Button
              disabled={busy()}
              onClick={() => void session().refreshCluster()}
            >
              Refresh cluster status
            </Button>
          </div>
          {confirmation() ? (
            <div {...styles.confirm()}>
              {confirmation() === "cancelJoin" ? (
                <p>
                  Retire this pending join locally and ask the primary to remove
                  its admission. If the primary is offline, cleanup remains
                  pending and a late approval cannot activate this join.
                </p>
              ) : confirmation() === "leave" ? (
                <p>
                  Removal must be confirmed by the primary. A primary must
                  transfer its role before leaving. Existing client grants are
                  not revoked by leaving.
                </p>
              ) : (
                <p>
                  Cluster members fully trust each other. Clients paired with
                  any member receive full access to all members after the
                  primary accepts their pairing. This daemon can belong to only
                  one cluster. Existing local pairings will be adopted
                  automatically.
                </p>
              )}
              {confirmation() === "join" || confirmation() === "cancelJoin" ? (
                <label>
                  Cluster member{" "}
                  <select
                    aria-label="Cluster member"
                    value={source()}
                    onChange={(e) => setSource(e.currentTarget.value)}
                  >
                    <option value="">Choose a member</option>
                    {candidates().map((m) => (
                      <option value={m.id}>{m.name}</option>
                    ))}
                  </select>
                </label>
              ) : null}
              <div {...styles.actions()}>
                <Button
                  disabled={
                    busy() ||
                    ((confirmation() === "join" ||
                      confirmation() === "cancelJoin") &&
                      !source())
                  }
                  onClick={() => void perform()}
                >
                  {busy() ? "Working…" : "Confirm"}
                </Button>
                <Button
                  disabled={busy()}
                  onClick={() => setConfirmation(undefined)}
                >
                  Cancel
                </Button>
              </div>
            </div>
          ) : null}
        </>
      ) : null}
    </section>
  );
}
namespace styles {
  export const section = style({
    display: "grid",
    gap: "8px",
    padding: "16px",
    borderTop: `1px solid ${theme.borderSubtle}`,
  });
  export const actions = style({
    display: "flex",
    flexWrap: "wrap",
    gap: "8px",
  });
  export const confirm = style({
    display: "grid",
    gap: "12px",
    padding: "12px",
    border: `1px solid ${theme.borderSubtle}`,
  });
}
