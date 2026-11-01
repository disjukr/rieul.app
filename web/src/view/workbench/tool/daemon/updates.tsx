import { createSignal } from "solid-js";
import { useBunja } from "../../../../solid/bunja.tsx";
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
    <section class="mt-[18px] min-w-0" aria-label="Daemon updates">
      <div class="mb-[8px] text-[1rem] font-800 text-[#667085]">Updates</div>
      <div class="grid gap-[8px] rounded-[8px] border border-[#d8dde7] bg-[#fbfcfe] p-[1rem]">
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
        {status()?.reason ? (
          <p class="text-[#667085]">{status()!.reason}</p>
        ) : null}
        {message() ? <p role="alert">{message()}</p> : null}
        {supported() && status()?.phase !== UpdatePhase.Unavailable ? (
          <div class="flex flex-wrap gap-[8px]">
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
            class="grid gap-[8px] border-t border-[#d8dde7] pt-[1rem]"
          >
            <p>
              Installing restarts the server and disconnects all clients. You
              will need to reconnect.
            </p>
            <p>
              Active terminals, commands, file transfers and agent runtimes will
              postpone installation. They will not be forcibly terminated.
            </p>
            <div class="flex gap-[8px]">
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
