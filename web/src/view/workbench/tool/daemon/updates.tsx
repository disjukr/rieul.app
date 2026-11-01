import { style } from "../../../../zyzz.config.ts";
import { createSignal } from "solid-js";
import { useBunja } from "bunja/solid";
import {
  daemonUpdatesBunja,
  updatePhaseLabel,
} from "../../../../state/daemon-updates.ts";
import { UpdatePhase } from "../../../../protocol/generated/rpc.ts";
import { Button } from "../../../ui/button.tsx";

export function DaemonUpdateSection() {
  const updates = useBunja(daemonUpdatesBunja);
  const status = () => updates().status();
  const message = () => updates().message();
  const busy = () => updates().busy();
  const supported = () => updates().supported();
  const confirmationToken = () => updates().confirmationToken();
  const [confirmedToken, setConfirmedToken] = createSignal<string>();
  const confirming = () =>
    confirmedToken() !== undefined && confirmedToken() === confirmationToken();
  const working = () =>
    busy() ||
    [
      UpdatePhase.Checking,
      UpdatePhase.Downloading,
      UpdatePhase.Verifying,
      UpdatePhase.Installing,
      UpdatePhase.Restarting,
    ].includes(status()?.phase ?? UpdatePhase.Idle);
  return (
    <section {...styles.section()} aria-label="Daemon updates">
      <div {...styles.div()}>Updates</div>
      <div {...styles.div2()}>
        <div role="status" aria-live="polite">
          {!supported()
            ? "This daemon does not support update management."
            : status()
              ? updatePhaseLabel(status()!.phase)
              : "Loading update status…"}
        </div>
        {status()?.currentVersion ? (
          <div>Installed: {status()!.currentVersion}</div>
        ) : null}
        {status()?.targetVersion ? (
          <div>Available: {status()!.targetVersion}</div>
        ) : null}
        {status()?.reason ? <p {...styles.p()}>{status()!.reason}</p> : null}
        {message() ? <p role="alert">{message()}</p> : null}
        {supported() && status()?.phase !== UpdatePhase.Unavailable ? (
          <div {...styles.div3()}>
            <Button disabled={working()} onClick={() => void updates().check()}>
              Check for updates
            </Button>
            <Button
              disabled={busy() || !status()?.canInstall}
              onClick={() => setConfirmedToken(confirmationToken())}
            >
              Install update…
            </Button>
          </div>
        ) : null}
        {confirming() ? (
          <div
            role="alertdialog"
            aria-label="Confirm server update"
            {...styles.div4()}
          >
            <p>
              Installing restarts the server and disconnects all clients. You
              will need to reconnect.
            </p>
            <p>
              Active terminals, commands, file transfers and agent runtimes will
              postpone installation. They will not be forcibly terminated.
            </p>
            <div {...styles.div5()}>
              <Button onClick={() => setConfirmedToken(undefined)}>
                Cancel
              </Button>
              <Button
                disabled={busy() || !supported() || !status()?.canInstall}
                onClick={() => {
                  setConfirmedToken(undefined);
                  void updates().installConfirmed(confirmationToken());
                }}
              >
                Confirm and install
              </Button>
            </div>
          </div>
        ) : null}
      </div>
    </section>
  );
}

namespace styles {
  export const section = style({
    marginTop: "18px",
    minWidth: "0",
  });
  export const div = style({
    marginBottom: "8px",
    fontSize: "1rem",
    color: "rgb(102 112 133 / 1)",
    fontWeight: 800,
  });
  export const div2 = style({
    display: "grid",
    gap: "8px",
    borderWidth: "1px",
    borderColor: "rgb(216 221 231 / 1)",
    borderRadius: "8px",
    backgroundColor: "rgb(251 252 254 / 1)",
    padding: "1rem",
  });
  export const p = style({
    color: "rgb(102 112 133 / 1)",
  });
  export const div3 = style({
    display: "flex",
    flexWrap: "wrap",
    gap: "8px",
  });
  export const div4 = style({
    display: "grid",
    gap: "8px",
    borderTopWidth: "1px",
    borderColor: "rgb(216 221 231 / 1)",
    paddingTop: "1rem",
  });
  export const div5 = style({
    display: "flex",
    gap: "8px",
  });
}
