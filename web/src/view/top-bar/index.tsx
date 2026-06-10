import { useAtomValue } from "jotai";
import { useBunja } from "bunja/react";
import { connectionBunja } from "../../state/connection.ts";
import { machineStoreBunja } from "../../state/machine-store.ts";
import { layoutBunja } from "../state.tsx";
import { AppTopbar } from "./app-topbar.tsx";

export function TopBarRegion() {
  const layout = useBunja(layoutBunja);
  const machineStore = useBunja(machineStoreBunja);
  const connectionState = useBunja(connectionBunja);
  const selected = useAtomValue(machineStore.selectedAtom);
  const connection = useAtomValue(connectionState.connectionAtom);
  const machinePanelCollapsed = useAtomValue(
    layout.machinePanelCollapsedAtom,
  );

  return (
    <AppTopbar
      connection={connection}
      machine={selected}
      machinePanelCollapsed={machinePanelCollapsed}
      onRefresh={() => void connectionState.checkSelected()}
      onToggleMachinePanel={layout.toggleMachinePanel}
    />
  );
}
