import { createMemo, For } from "solid-js";
import { useBunja } from "bunja/solid";
import { machineStoreBunja } from "../state/machine-store.ts";
import { rpcSessionBunja } from "../state/rpc-session.ts";
import { MachineIdContext, MachineBaseUrlContext } from "../state/machine.tsx";
// Uses the same scoped session as a selected member, so selection adds no pairing.
export function ClusterConnections() {
  const machines = useBunja(machineStoreBunja);
  return (
    <div hidden>
      <For
        each={machines()
          .machines()
          .filter((m) => m.cluster)
          .map((m) => m.id)}
      >
        {(id) => <ClusterMachineConnection id={id} />}
      </For>
    </div>
  );
}
// Metadata and unrelated membership changes must not replace scoped consumers.
function ClusterMachineConnection(props: { id: string }) {
  const machines = useBunja(machineStoreBunja);
  const baseUrl = createMemo(
    () =>
      machines()
        .machines()
        .find((m) => m.id === props.id)?.baseUrl,
  );
  return (
    <MachineIdContext value={props.id}>
      <MachineBaseUrlContext value={baseUrl}>
        <ClusterConnection />
      </MachineBaseUrlContext>
    </MachineIdContext>
  );
}
function ClusterConnection() {
  const session = useBunja(rpcSessionBunja);
  return <span>{session().connection().phase}</span>;
}
