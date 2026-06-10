import { bunja } from "bunja";
import { atom, useAtomValue } from "jotai";
import { useBunja } from "bunja/react";
import { machineStoreBunja } from "../../state/machine-store.ts";
import { MachineAddFormContainer } from "../machine-panel/index.tsx";
import { WorkbenchPaneLayout } from "./pane-layout/index.tsx";
import { PropsWithChildren } from "react";

const workbenchRegionBunja = bunja(() => {
  const { machinesAtom } = bunja.use(machineStoreBunja);
  const hasMachinesAtom = atom((get) => get(machinesAtom).length > 0);
  return { hasMachinesAtom };
});

export function WorkbenchRegion() {
  const { hasMachinesAtom } = useBunja(workbenchRegionBunja);
  const hasMachines = useAtomValue(hasMachinesAtom);
  return (
    <section
      className={hasMachines ? "workbench" : "workbench no-machine"}
    >
      {hasMachines ? <WorkbenchPaneLayout /> : (
        <InlineMachineSetup>
          <MachineAddFormContainer showCancel={false} />
        </InlineMachineSetup>
      )}
    </section>
  );
}

function InlineMachineSetup({ children }: PropsWithChildren) {
  return (
    <section className="inline-machine-setup">
      <div className="inline-machine-card">
        <header className="modal-head">
          <div>
            <span>Machine</span>
            <h2>Add machine</h2>
          </div>
        </header>
        {children}
      </div>
    </section>
  );
}
