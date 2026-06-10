import React from "react";
import { useAtomValue } from "jotai";
import { useBunja } from "bunja/react";
import {
  MachineModalHost,
  MachinePanelRegion,
} from "./machine-panel/index.tsx";
import { MachineRailRegion } from "./machine-rail/index.tsx";
import { layoutBunja } from "./state.tsx";
import { TopBarRegion } from "./top-bar/index.tsx";
import { WorkbenchRegion } from "./workbench/index.tsx";

interface LayoutProps {
  children: React.ReactNode;
}

export default function View() {
  return (
    <Layout>
      <MachineRailRegion />
      <TopBarRegion />
      <MachinePanelRegion />
      <WorkbenchRegion />
      <MachineModalHost />
    </Layout>
  );
}

function Layout({ children }: LayoutProps) {
  const layout = useBunja(layoutBunja);
  const machinePanelCollapsed = useAtomValue(
    layout.machinePanelCollapsedAtom,
  );
  const machinePanelWidth = useAtomValue(layout.machinePanelWidthAtom);
  return (
    <main
      className={machinePanelCollapsed
        ? "app-shell machine-panel-collapsed"
        : "app-shell"}
      style={{
        "--machine-panel-width": `${machinePanelWidth}px`,
      } as React.CSSProperties}
    >
      {children}
    </main>
  );
}
