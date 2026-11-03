import { useBunja } from "bunja/solid";
import { machineStoreBunja } from "../state/machine-store.ts";
import { rpcSessionBunja } from "../state/rpc-session.ts";
import { MachineIdContext, MachineBaseUrlContext } from "../state/machine.tsx";
// Uses the same scoped session as a selected member, so selection adds no pairing.
export function ClusterConnections() {
  const machines = useBunja(machineStoreBunja);
  return (
    <div hidden>
      {machines()
        .machines()
        .filter((m) => m.cluster)
        .map((machine) => (
          <MachineIdContext value={machine.id}>
            <MachineBaseUrlContext value={machine.baseUrl}>
              <ClusterConnection />
            </MachineBaseUrlContext>
          </MachineIdContext>
        ))}
    </div>
  );
}
function ClusterConnection() {
  const session = useBunja(rpcSessionBunja);
  return <span>{session().connection().phase}</span>;
}
