import type { ClusterState } from "../../../../protocol/generated/rpc.ts";
import {
  hex,
  verifyHistory,
  type VerifiedCluster,
} from "../../../../cluster/trust.ts";
import { createSignal, createEffect } from "solid-js";
import { useBunja } from "bunja/solid";
import { rpcSessionBunja } from "../../../../state/rpc-session.ts";
import { machineStoreBunja } from "../../../../state/machine-store.ts";
import {
  createCluster,
  joinCluster,
  leaveCluster,
  cancelJoin,
  transferPrimary,
  revokeClusterGrant,
} from "../../../../cluster/manage.ts";
import { Button } from "../../../ui/button.tsx";
import { style, theme } from "../../../../zyzz.config.ts";
export function ClusterSection() {
  const session = useBunja(rpcSessionBunja),
    machines = useBunja(machineStoreBunja);
  const [busy, setBusy] = createSignal(false),
    [error, setError] = createSignal<string>(),
    [confirmation, setConfirmation] = createSignal<
      "create" | "join" | "leave" | "cancelJoin" | "transfer" | "revoke"
    >(),
    [source, setSource] = createSignal(""),
    [grant, setGrant] = createSignal(""),
    [verified, setVerified] = createSignal<VerifiedCluster>();
  createEffect(
    () => machines().selectedId(),
    () => {
      setConfirmation(undefined);
      setError(undefined);
    },
  );
  const status = () => session().cluster();
  const state = () => status().state;
  let verification = 0;
  createEffect(
    () => status().record?.history,
    (history) => {
      const generation = ++verification;
      setVerified(undefined);
      if (history)
        void verifyHistory(history)
          .then((value) => {
            if (generation === verification) setVerified(value);
          })
          .catch(() => {});
    },
  );
  const memberState = () => {
    const value = state();
    return value?.type === "member" ? value : undefined;
  };
  const transition = () => memberState()?.primaryTransition.type;
  const transferTargets = () =>
    machines()
      .machines()
      .filter((machine) => {
        const current = memberState();
        if (
          !current ||
          !machine.cluster ||
          machine.cluster.id !== hex(current.head.clusterId) ||
          !verified()?.members.has(machine.cluster.admissionId)
        )
          return false;
        return transition() === "active"
          ? machine.cluster.admissionId !== hex(current.localAdmissionId)
          : machine.cluster.admissionId ===
              hex(current.head.primaryAdmissionId);
      });
  const grants = () => Array.from(verified()?.grants.entries() ?? []);
  const managementMessage = () =>
    transition() === "active"
      ? "This daemon is the primary. Membership changes require it to be online."
      : transition() === "sealed"
        ? "Management is sealed on this daemon. Authority belongs to the selected new primary; resume to confirm its activation."
        : transition() === "awaitingActivation"
          ? "This daemon is awaiting durable primary activation. Management is not ready."
          : "This daemon is a replica. Management requests require the primary; cached access can continue while it is offline.";
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
      if (action === "transfer") {
        const selected = transferTargets().find(
          (machine) => machine.id === source(),
        );
        if (!selected) throw new Error("Choose the verified transfer target");
        await transferPrimary(transport, selected);
      }
      if (action === "revoke") {
        const selected = grants().find(([id]) => id === grant());
        if (!selected)
          throw new Error("The cluster approval is no longer current");
        await revokeClusterGrant(
          transport,
          Uint8Array.from(selected[0].match(/../g)!, (byte) =>
            parseInt(byte, 16),
          ),
        );
      }
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
          {status().issues?.map((issue) => (
            <p role="alert" {...styles.identifier()}>
              Unresolved cancellation for approval {hex(issue.grantId)}.{" "}
              {issue.requiresActiveMember
                ? "An active member must revoke it; the removed issuer cannot finish cancellation automatically."
                : "Primary cancellation is pending."}
            </p>
          ))}
          {memberState() ? (
            <>
              <p>{managementMessage()}</p>
              <h4>Cluster approvals</h4>
              <p>
                These approvals grant access across the cluster. Local pairings
                are managed separately. Revocation reaches offline replicas when
                they synchronize.
              </p>
              {grants().map(([id, approval]) => (
                <div {...styles.confirm()}>
                  <span {...styles.identifier()}>
                    Approval {id}
                    {id ===
                    (status().record?.grantId
                      ? hex(status().record!.grantId!)
                      : "")
                      ? " (this browser)"
                      : ""}
                  </span>
                  <span>
                    Issuer admission: {hex(approval.issuer).slice(0, 12)}
                  </span>
                  <span>
                    {approval.expires * 1000 <= Date.now()
                      ? "Expired"
                      : "Expires"}
                    : {new Date(approval.expires * 1000).toLocaleString()}
                  </span>
                  <Button
                    disabled={busy()}
                    onClick={() => {
                      setGrant(id);
                      setConfirmation("revoke");
                    }}
                  >
                    Revoke cluster approval…
                  </Button>
                </div>
              ))}
            </>
          ) : null}
          <div {...styles.actions()}>
            {transition() === "active" ||
            transition() === "sealed" ||
            transition() === "awaitingActivation" ? (
              <Button
                disabled={busy() || !transferTargets().length}
                onClick={() => {
                  setSource("");
                  setConfirmation("transfer");
                }}
              >
                {transition() === "active"
                  ? "Transfer primary…"
                  : "Resume primary activation…"}
              </Button>
            ) : null}
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
              {confirmation() === "transfer" ? (
                <p {...styles.identifier()}>
                  {transition() === "active"
                    ? "Transfer membership management authority to"
                    : "Confirm durable activation of"}{" "}
                  {transferTargets().find((m) => m.id === source())?.name ??
                    "the selected daemon"}
                  {source()
                    ? ` (${transferTargets().find((m) => m.id === source())?.baseUrl})`
                    : ""}
                  . Once sealed, the previous primary cannot resume writes. If
                  the target is offline, activation remains pending; there is no
                  automatic promotion.
                </p>
              ) : confirmation() === "revoke" ? (
                <p {...styles.identifier()}>
                  Revoke cluster approval {grant()} across all members. This
                  does not remove a local pairing. Revoking this browser’s
                  approval can disconnect its cluster sessions.
                </p>
              ) : confirmation() === "cancelJoin" ? (
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
              {confirmation() === "join" ||
              confirmation() === "cancelJoin" ||
              confirmation() === "transfer" ? (
                <label>
                  Cluster member{" "}
                  <select
                    aria-label="Cluster member"
                    value={source()}
                    onChange={(e) => setSource(e.currentTarget.value)}
                  >
                    <option value="">Choose a member</option>
                    {(confirmation() === "transfer"
                      ? transferTargets()
                      : candidates()
                    ).map((m) => (
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
                      confirmation() === "cancelJoin" ||
                      confirmation() === "transfer") &&
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
  export const identifier = style({ overflowWrap: "anywhere" });
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
