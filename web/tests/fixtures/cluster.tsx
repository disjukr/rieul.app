import "../../src/solid/scopes.ts";
import { render } from "@solidjs/web";
import { createSignal } from "solid-js";
import { override } from "bunja";
import { TestBunjaStoreProvider } from "./bunja-store.tsx";
import { rpcSessionStub } from "../helpers/rpc-session.ts";
import { rpcSessionBunja } from "../../src/state/rpc-session.ts";
import { ClusterSection } from "../../src/view/workbench/tool/daemon/cluster.tsx";
import type { ClusterStatus } from "../../src/cluster/connection.ts";
import "../../src/theme.css";
const [status, setStatus] = createSignal<ClusterStatus>({
  supported: true,
  state: { type: "unaffiliated" },
  message: "Not in a cluster.",
});
Object.assign(window, {
  clusterFixture: {
    unsupported() {
      setStatus({
        supported: false,
        message: "Cluster enrollment is not supported by this daemon.",
      });
    },
  },
});
render(
  () => (
    <TestBunjaStoreProvider
      overrides={[
        override(rpcSessionBunja, () => rpcSessionStub({ cluster: status })),
      ]}
    >
      <ClusterSection />
    </TestBunjaStoreProvider>
  ),
  document.getElementById("root")!,
);
