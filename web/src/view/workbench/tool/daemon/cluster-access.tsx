import { createEffect, createSignal } from "solid-js";
import { useBunja } from "bunja/solid";
import {
  hex,
  verifyHistory,
  type VerifiedCluster,
} from "../../../../cluster/trust.ts";
import { revokeClusterGrant } from "../../../../cluster/manage.ts";
import { rpcSessionBunja } from "../../../../state/rpc-session.ts";
import { machineStoreBunja } from "../../../../state/machine-store.ts";
import { Button } from "../../../ui/button.tsx";
import { style, theme } from "../../../../zyzz.config.ts";

export function ClusterAccessSection() {
  const session = useBunja(rpcSessionBunja),
    machines = useBunja(machineStoreBunja);
  const [busy, setBusy] = createSignal(false),
    [error, setError] = createSignal<string>(),
    [grant, setGrant] = createSignal<string>(),
    [verified, setVerified] = createSignal<VerifiedCluster>();
  const status = () => session().cluster();
  const grants = () => Array.from(verified()?.grants.entries() ?? []);
  createEffect(
    () => machines().selectedId(),
    () => {
      setGrant(undefined);
      setError(undefined);
    },
  );
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
  async function revoke() {
    const confirmedGrant = grant();
    const targetId = machines().selectedId();
    if (!confirmedGrant || busy()) return;
    setBusy(true);
    setError(undefined);
    try {
      const transport = await session().webTransport();
      if (machines().selectedId() !== targetId || grant() !== confirmedGrant)
        return;
      const selected = grants().find(([id]) => id === confirmedGrant);
      if (!selected)
        throw new Error("The cluster approval is no longer current");
      await revokeClusterGrant(
        transport,
        Uint8Array.from(selected[0].match(/../g)!, (byte) =>
          parseInt(byte, 16),
        ),
      );
      setGrant(undefined);
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
    <>
      {status().supported && status().state?.type === "member" ? (
        <section {...styles.section()} aria-label="Cluster access">
          <details>
            <summary>Cluster access</summary>
            <div {...styles.content()}>
              {error() ? <p role="alert">{error()}</p> : null}
              {status().issues?.map((issue) => (
                <p role="alert" {...styles.identifier()}>
                  Unresolved cancellation for approval {hex(issue.grantId)}.{" "}
                  {issue.requiresActiveMember
                    ? "An active member must revoke it; the removed issuer cannot finish cancellation automatically."
                    : "Primary cancellation is pending."}
                </p>
              ))}
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
                    }}
                  >
                    Revoke cluster approval…
                  </Button>
                </div>
              ))}

              {grant() ? (
                <div {...styles.confirm()}>
                  <p {...styles.identifier()}>
                    Revoke cluster approval {grant()} across all members. This
                    does not remove a local pairing. Revoking this browser’s
                    approval can disconnect its cluster sessions.
                  </p>
                  <div {...styles.actions()}>
                    <Button disabled={busy()} onClick={() => void revoke()}>
                      {busy() ? "Working…" : "Confirm"}
                    </Button>
                    <Button
                      disabled={busy()}
                      onClick={() => setGrant(undefined)}
                    >
                      Cancel
                    </Button>
                  </div>
                </div>
              ) : null}
            </div>
          </details>
        </section>
      ) : null}
    </>
  );
}
namespace styles {
  export const identifier = style({ overflowWrap: "anywhere" });
  export const section = style({
    padding: "16px",
    borderTop: `1px solid ${theme.borderSubtle}`,
  });
  export const content = style({
    display: "grid",
    gap: "8px",
    paddingTop: "8px",
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
