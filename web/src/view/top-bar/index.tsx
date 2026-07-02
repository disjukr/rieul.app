import { useAtomValue } from "jotai";
import { useBunja } from "bunja/react";
import { machineStoreBunja } from "../../state/machine-store.ts";
import { layoutBunja } from "../state.tsx";
import { AppTopbar } from "./app-topbar.tsx";

export function TopBarRegion() {
  const layout = useBunja(layoutBunja);
  const machineStore = useBunja(machineStoreBunja);
  const selected = useAtomValue(machineStore.selectedAtom);
  const machinePanelCollapsed = useAtomValue(
    layout.machinePanelCollapsedAtom,
  );

  return (
    <AppTopbar
      machine={selected}
      machinePanelCollapsed={machinePanelCollapsed}
      onToggleMachinePanel={layout.toggleMachinePanel}
    />
  );
}
