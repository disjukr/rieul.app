import { useAtomValue } from "jotai";
import { useBunja } from "bunja/react";
import { connectionBunja } from "../../state/connection.ts";
import { machineModalBunja } from "../../state/machine-modal.ts";
import { machineStoreBunja } from "../../state/machine-store.ts";
import {
  workbenchBunja,
  WorkbenchMachineScope,
} from "../../state/workbench.ts";
import { MachineAddFormContainer } from "../machine-panel/index.tsx";
import { InlineMachineSetup } from "./inline-machine-setup.tsx";
import { Workbench } from "./workbench.tsx";

export function WorkbenchRegion() {
  const machineStore = useBunja(machineStoreBunja);
  const machineModal = useBunja(machineModalBunja);
  const connectionState = useBunja(connectionBunja);
  const selectedId = useAtomValue(machineStore.selectedIdAtom);
  const workbench = useBunja(workbenchBunja, [
    WorkbenchMachineScope.bind(selectedId),
  ]);
  const machines = useAtomValue(machineStore.machinesAtom);
  const selected = useAtomValue(machineStore.selectedAtom);
  const selectedIsPaired = useAtomValue(machineStore.selectedIsPairedAtom);
  const connectionEpoch = useAtomValue(connectionState.connectionEpochAtom);
  const workbenchLayout = useAtomValue(workbench.layoutAtom);
  const workbenchPanes = useAtomValue(workbench.panesAtom);

  return (
    <section
      className={machines.length === 0 ? "workbench no-machine" : "workbench"}
    >
      {machines.length === 0
        ? (
          <InlineMachineSetup>
            <MachineAddFormContainer showCancel={false} />
          </InlineMachineSetup>
        )
        : (
          <Workbench
            layout={workbenchLayout}
            panes={workbenchPanes}
            setLayout={workbench.setLayout}
            addPane={workbench.addPane}
            removePane={workbench.removePane}
            addFilesTab={workbench.addFilesTab}
            selectTab={workbench.selectTab}
            closeTab={workbench.closeTab}
            moveTab={workbench.moveTab}
            machine={selected}
            isPaired={selectedIsPaired}
            connectionEpoch={connectionEpoch}
            onPair={() =>
              selected && machineModal.openPairMachineModal(selected.id)}
          />
        )}
    </section>
  );
}
