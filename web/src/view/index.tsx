import React, { PropsWithChildren } from "react";
import { useAtomValue } from "jotai";
import { useBunja } from "bunja/react";
import {
  MachineModalHost,
  MachinePanelRegion,
} from "./machine-panel/index.tsx";
import { MachineRailRegion } from "./machine-rail/index.tsx";
import { capabilityBunja } from "../state/capability.ts";
import { MachineIdContext } from "../state/machine-id.tsx";
import { machineStoreBunja } from "../state/machine-store.ts";
import { layoutBunja } from "./state.tsx";
import { TopBarRegion } from "./top-bar/index.tsx";
import { WorkbenchRegion } from "./workbench/index.tsx";
import { className } from "./class-name.ts";

const appShellClassName = [
  "app-shell grid h-full min-h-0 overflow-hidden bg-[#242832]",
  "[grid-template-columns:64px_var(--machine-panel-width,264px)_minmax(0,1fr)]",
  "[grid-template-rows:32px_minmax(0,1fr)]",
  "max-[980px]:[grid-template-columns:64px_var(--machine-panel-width,236px)_minmax(0,1fr)]",
  "max-[680px]:[grid-template-columns:64px_var(--machine-panel-width,212px)_minmax(0,1fr)]",
  "[&.machine-panel-collapsed]:[grid-template-columns:64px_0_minmax(0,1fr)]",
  "[&.machine-panel-collapsed_.machine-panel]:invisible",
  "[&.machine-panel-collapsed_.machine-panel]:border-r-0",
  "[&.machine-panel-collapsed_.machine-panel]:rounded-tl-0",
  "[&.machine-panel-collapsed_.workbench]:[grid-column:2/-1]",
  "[&.machine-panel-collapsed_.workbench]:rounded-tl-[8px]",
].join(" ");

export default function View() {
  useBunja(capabilityBunja);

  return (
    <Layout>
      <MachineRailRegion />
      <TopBarRegion />
      <SelectedMachineIdProvider>
        <MachinePanelRegion />
        <WorkbenchRegion />
      </SelectedMachineIdProvider>
      <MachineModalHost />
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
  const machinePanelWidth = useAtomValue(layout.machinePanelWidthAtom);
  return (
    <main
      className={className(
        appShellClassName,
        machinePanelCollapsed && "machine-panel-collapsed",
      )}
      style={{
        "--machine-panel-width": `${machinePanelWidth}px`,
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
  const selectedId = useAtomValue(machineStore.selectedIdAtom);
  return (
    <MachineIdContext value={selectedId}>
      {children}
    </MachineIdContext>
  );
}
