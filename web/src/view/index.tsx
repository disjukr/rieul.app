import React, { PropsWithChildren } from "react";
import { useAtomValue } from "jotai";
import { useBunja } from "bunja/react";
import {
  MachineModalHost,
  MachinePanelRegion,
} from "./machine-panel/index.tsx";
import { MachineBaseUrlContext, MachineIdContext } from "../state/machine.tsx";
import { machineStoreBunja } from "../state/machine-store.ts";
import { layoutBunja } from "./state.tsx";
import { TopBarRegion } from "./top-bar/index.tsx";
import { WorkbenchRegion } from "./workbench/index.tsx";
import { className } from "./class-name.ts";

const appShellClassName = [
  "app-shell relative isolate grid h-full min-h-0 overflow-hidden bg-wgo-canvas",
  "[background:var(--wgo-canvas-background)]",
  "[&>*]:relative [&>*]:z-[1]",
  "[grid-template-columns:152px_var(--machine-panel-width,232px)_minmax(0,1fr)]",
  "[grid-template-rows:minmax(0,1fr)]",
  "[&.machine-panel-transitioning]:[transition:grid-template-columns_180ms_ease]",
  "max-[980px]:[grid-template-columns:154px_var(--machine-panel-width,220px)_minmax(0,1fr)]",
  "max-[680px]:![grid-template-columns:minmax(0,1fr)]",
  "max-[680px]:![grid-template-rows:minmax(0,1fr)_76px]",
  "[&.machine-panel-collapsed_.machine-panel]:pointer-events-none",
  "[&.machine-panel-collapsed_.machine-panel]:border-r-0",
  "[&.machine-panel-collapsed_.machine-panel]:rounded-tl-0",
  "[&.machine-panel-collapsed_.workbench]:rounded-tl-wgo-2xl",
  "max-[680px]:[&_.machine-panel]:![grid-column:1]",
  "max-[680px]:[&_.workbench]:![grid-column:1]",
].join(" ");

export default function View() {
  return (
    <Layout>
      <SelectedMachineIdProvider>
        <TopBarRegion />
        <MachinePanelRegion />
        <WorkbenchRegion />
        <MachineModalHost />
      </SelectedMachineIdProvider>
    </Layout>
  );
}

interface LayoutProps {
  children: React.ReactNode;
}
function Layout({ children }: LayoutProps) {
  const layout = useBunja(layoutBunja);
  const machinePanelCollapsed = useAtomValue(
    layout.machinePanelCollapsedAtom,
  );
  const machinePanelTransitioning = useAtomValue(
    layout.machinePanelTransitioningAtom,
  );
  const machinePanelWidth = useAtomValue(layout.machinePanelWidthAtom);

  return (
    <main
      className={className(
        appShellClassName,
        machinePanelCollapsed && "machine-panel-collapsed",
        machinePanelTransitioning && "machine-panel-transitioning",
      )}
      style={{
        "--machine-panel-width": machinePanelCollapsed
          ? "0px"
          : `${machinePanelWidth}px`,
        "--machine-panel-open-width": `${machinePanelWidth}px`,
      } as React.CSSProperties}
    >
      {children}
    </main>
  );
}

function SelectedMachineIdProvider(
  { children }: PropsWithChildren,
) {
  const machineStore = useBunja(machineStoreBunja);
  const selected = useAtomValue(machineStore.selectedAtom);
  return (
    <MachineIdContext value={selected?.id}>
      <MachineBaseUrlContext value={selected?.baseUrl}>
        {children}
      </MachineBaseUrlContext>
    </MachineIdContext>
  );
}
