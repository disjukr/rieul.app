import { override } from "bunja";
import { createSignal, createMemo } from "solid-js";
import { render } from "@solidjs/web";
import { BunjaProvider } from "../../src/solid/bunja";
import { daemonUpdatesBunja } from "../../src/state/daemon-updates";
import {
  UpdatePhase,
  type UpdateStatus,
} from "../../src/protocol/generated/rpc";
import { DaemonUpdateSection } from "../../src/view/workbench/tool/daemon/updates";
function Fixture() {
  const [status, setStatus] = createSignal<UpdateStatus>({
    phase: UpdatePhase.Deferred,
    currentVersion: "0.6.13",
    targetVersion: "0.6.14",
    canInstall: true,
    reason: "Connected clients postpone automatic installation.",
  });
  const [token, setToken] = createSignal("first");
  const [calls, setCalls] = createSignal(0);
  const [message] = createSignal<string>();
  const [busy] = createSignal(false);
  const supported = createMemo(() => true);
  const confirmationToken = createMemo(() => token());
  const model = {
    status,
    confirmationToken,
    message,
    busy,
    supported,
    refresh: async () => {},
    check: async () => {},
    installConfirmed: async (expected: string) => {
      if (expected === token()) {
        setCalls((n) => n + 1);
        setStatus({
          ...status()!,
          phase: UpdatePhase.Installing,
          canInstall: false,
        });
      }
    },
  };
  return (
    <>
      <button onClick={() => setToken("replacement")}>Replace daemon</button>
      <output aria-label="Install calls">{calls()}</output>
      <BunjaProvider overrides={[override(daemonUpdatesBunja, () => model)]}>
        <DaemonUpdateSection />
      </BunjaProvider>
    </>
  );
}
render(() => <Fixture />, document.getElementById("root")!);
