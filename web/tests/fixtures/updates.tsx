import "../../src/theme.css";
import { PropertyList } from "../../src/view/ui/property-list";
import { TestBunjaStoreProvider } from "./bunja-store.tsx";
import { override } from "bunja";
import { createSignal, createMemo } from "solid-js";
import { render } from "@solidjs/web";

import { rpcSessionBunja } from "../../src/state/rpc-session";
import { rpcSessionStub } from "../helpers/rpc-session";
import { daemonUpdatesBunja } from "../../src/state/daemon-updates";
import {
  UpdatePhase,
  type UpdateStatus,
} from "../../src/protocol/generated/rpc";
import { DaemonVersionRow } from "../../src/view/workbench/tool/daemon/updates";
function Fixture() {
  const [status, setStatus] = createSignal<UpdateStatus>({
    phase: UpdatePhase.Deferred,
    currentVersion: "0.6.13",
    targetVersion: "0.6.14",
    canInstall: true,
    ordering: { epoch: "fixture", revision: 1 },
    reason: "Connected clients postpone automatic installation.",
  });
  const [token, setToken] = createSignal("first");
  const [calls, setCalls] = createSignal(0);
  const [message, setMessage] = createSignal<string>();
  const [busy] = createSignal(false);
  const [supported, setSupported] = createSignal(true);
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
      <button onClick={() => setSupported(false)}>Unsupported updates</button>
      <button
        onClick={() =>
          setStatus({
            ...status(),
            phase: UpdatePhase.Unavailable,
            canInstall: false,
          })
        }
      >
        Unavailable updates
      </button>
      <button onClick={() => setMessage("Update request failed. Try again.")}>
        Fail update request
      </button>
      <output aria-label="Install calls">{calls()}</output>
      <TestBunjaStoreProvider
        overrides={[
          override(daemonUpdatesBunja, () => model),
          override(rpcSessionBunja, () => rpcSessionStub({})),
        ]}
      >
        <PropertyList>
          <DaemonVersionRow version="0.6.13" />
        </PropertyList>
      </TestBunjaStoreProvider>
    </>
  );
}
render(() => <Fixture />, document.getElementById("root")!);
