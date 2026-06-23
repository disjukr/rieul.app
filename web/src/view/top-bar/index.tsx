import { useAtomValue } from "jotai";
import { useBunja } from "bunja/react";
import { machineStoreBunja } from "../../state/machine-store.ts";
import { rpcSessionBunja } from "../../state/rpc-session.ts";
import { layoutBunja } from "../state.tsx";
import { AppTopbar } from "./app-topbar.tsx";

export function TopBarRegion() {
  const layout = useBunja(layoutBunja);
  const machineStore = useBunja(machineStoreBunja);
  const rpcSession = useBunja(rpcSessionBunja);
  const selected = useAtomValue(machineStore.selectedAtom);
  const connection = useAtomValue(rpcSession.connectionAtom);
  const machinePanelCollapsed = useAtomValue(
    layout.machinePanelCollapsedAtom,
  );

  return (
    <AppTopbar
      connection={connection}
      machine={selected}
      machinePanelCollapsed={machinePanelCollapsed}
      onRefresh={() => void rpcSession.reconnect()}
      onToggleMachinePanel={layout.toggleMachinePanel}
    />
  );
}
