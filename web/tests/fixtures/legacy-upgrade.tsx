import { render } from "@solidjs/web";
import { createSignal, createMemo } from "solid-js";
import { override } from "bunja";
import { TestBunjaStoreProvider } from "./bunja-store";
import { legacyDaemonUpgradeBunja } from "../../src/state/legacy-daemon-upgrade";
import { daemonUpdatesBunja } from "../../src/state/daemon-updates";
import { type LegacyUpdateStatus } from "../../src/protocol/legacy-upgrade";
import { UpdatePhase } from "../../src/protocol/generated/rpc";
import { DaemonUpdateSection } from "../../src/view/workbench/tool/daemon/updates";
function Fixture() {
  const [supported, setSupported] = createSignal(true),
    [busy] = createSignal(false);
  const [status, setStatus] = createSignal<LegacyUpdateStatus>();
  const [message, setMessage] = createSignal<string>();
  const [revision, setRevision] = createSignal(0);
  const [calls, setCalls] = createSignal(0);
  const verified = createMemo(() => status()?.currentVersion === "0.6.16");
  const token = createMemo(() => String(revision()));
  const model = {
    supported,
    verified,
    status,
    message,
    busy,
    confirmationToken: token,
    readStatus: async () => {
      setStatus({
        phase: UpdatePhase.Ready,
        currentVersion: "0.6.16",
        targetVersion: "0.6.20",
        canInstall: true,
      });
      setRevision((n) => n + 1);
    },
    check: async () => {
      setMessage("Check requested. Use Read update status to see progress.");
    },
    reconnect: () => {
      setSupported(false);
      setRevision((n) => n + 1);
    },
    installConfirmed: async (t: string) => {
      if (t === token() && verified()) {
        setCalls((n) => n + 1);
        setStatus({
          ...status()!,
          phase: UpdatePhase.Deferred,
          reason: "Active work postpones installation.",
          canInstall: true,
        });
      }
    },
  };
  const modern = {
    status: createSignal({
      phase: UpdatePhase.Idle,
      currentVersion: "0.6.20",
      canInstall: false,
      ordering: { epoch: "new", revision: 1 },
    })[0],
    message: createSignal<string>()[0],
    busy,
    supported: createMemo(() => true),
    confirmationToken: token,
    refresh: async () => {},
    check: async () => {},
    installConfirmed: async () => {},
  };
  return (
    <>
      <button
        onClick={() => {
          setStatus(undefined);
          setRevision((n) => n + 1);
          setMessage("Legacy update request failed. Read status again.");
        }}
      >
        Simulate failure
      </button>
      <output aria-label="Legacy install calls">{calls()}</output>
      <TestBunjaStoreProvider
        overrides={[
          override(legacyDaemonUpgradeBunja, () => model),
          override(daemonUpdatesBunja, () => modern),
        ]}
      >
        <DaemonUpdateSection />
      </TestBunjaStoreProvider>
    </>
  );
}
render(() => <Fixture />, document.getElementById("root")!);
