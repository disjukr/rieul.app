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
import { fixture, id } from "../helpers/cluster-history.ts";
import { hex } from "../../src/cluster/trust.ts";
const [status, setStatus] = createSignal<ClusterStatus>({
  supported: true,
  state: { type: "unaffiliated" },
  message: "Not in a cluster.",
});
Object.assign(window, {
  clusterFixture: {
    async management(
      transition: "active" | "sealed" | "awaitingActivation" | "replica",
    ) {
      const f = await fixture();
      await f.admit();
      await f.adopt();
      const history = f.history;
      setStatus({
        supported: true,
        message: "Cluster access is ready.",
        state: {
          type: "member",
          genesis: history.genesis,
          head: history.head,
          localAdmissionId: id(2),
          members: [],
          primaryTransition: { type: transition },
        },
        record: {
          id: hex(history.head.clusterId),
          publicKey: f.client.public,
          privateKey: f.client.private,
          history,
          grantId: id(5),
        },
      });
    },
    unresolved() {
      setStatus({
        supported: true,
        message: "This node was removed from its cluster.",
        state: { type: "removed", clusterId: id(1), admissionId: id(2) },
        issues: [
          {
            clusterId: id(1),
            grantId: id(5),
            expiresAtUnix: 2_000_000_000,
            requiresActiveMember: true,
          },
        ],
      });
    },
    unsupported() {
      setStatus({
        supported: false,
        message:
          "Cluster enrollment is not supported by this daemon. Windows enrollment is currently unavailable.",
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
