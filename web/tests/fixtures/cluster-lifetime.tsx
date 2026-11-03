// Real view and Bunja scopes; signed synthetic history and offline transports only.
import { render } from "@solidjs/web";
import { BunjaStoreProvider, useBunja } from "bunja/solid";
import "../../src/solid/scopes";
import "../../src/theme.css";
import View from "../../src/view/index.tsx";
import { machineStoreBunja } from "../../src/state/machine-store.ts";
import { fixture, id, concat } from "../helpers/cluster-history.ts";
import { hex } from "../../src/cluster/trust.ts";
const machines = JSON.parse(localStorage.getItem("rieul.machines.v1")!);
machines[0].baseUrl = "https://root.test:443";
machines[0].clientId = "fixture";
machines[0].clientSecret = "fixture";
localStorage.setItem("rieul.machines.v1", JSON.stringify(machines));
const history = await fixture();
await history.admit();
await history.adopt();
export interface ClusterLifetimeFixture {
  poll(): Promise<void>;
  rename(): void;
  removeMember(): Promise<void>;
}
declare global {
  interface Window {
    clusterFixture: ClusterLifetimeFixture;
  }
}
function Fixture() {
  const store = useBunja(machineStoreBunja);
  Object.assign(window, {
    clusterFixture: {
      poll: () =>
        store().applyCluster(
          {
            id: hex(history.history.head.clusterId),
            privateKey: history.client.private,
            publicKey: history.client.public,
            grantId: id(5),
            history: history.history,
          },
          "A",
          hex(id(2)),
        ),
      removeMember: async () => {
        await history.append([1, id(3)], concat(new Uint8Array([1]), id(3)));
      },
      rename: () =>
        store().updateMachine("A", (m) => ({ ...m, name: "Renamed" })),
    },
  });
  return <View />;
}
render(
  () => (
    <BunjaStoreProvider>
      <Fixture />
    </BunjaStoreProvider>
  ),
  document.getElementById("root")!,
);
