import React, { PropsWithChildren, useEffect, useRef } from "react";
import { useAtomValue } from "jotai";
import { useBunja } from "bunja/react";
import { MachineModalHost } from "./machine-panel/index.tsx";
import { MachineBaseUrlContext, MachineIdContext } from "../state/machine.tsx";
import { machineStoreBunja } from "../state/machine-store.ts";
import { layoutBunja } from "./state.tsx";
import { TopBarRegion } from "./top-bar/index.tsx";
import { WorkbenchRegion } from "./workbench/index.tsx";
import { className } from "./class-name.ts";

const appShellClassName = [
  "app-shell relative isolate grid h-full min-h-0 overflow-hidden bg-rieul-canvas",
  "[background:var(--rieul-canvas-background)]",
  "[&>*]:relative [&>*]:z-[1]",
  "[grid-template-columns:var(--rail-width,204px)_minmax(0,1fr)]",
  "[grid-template-rows:minmax(0,1fr)]",
  "[&.machine-panel-transitioning]:[transition:grid-template-columns_180ms_ease]",
  "max-[980px]:[grid-template-columns:var(--rail-width,184px)_minmax(0,1fr)]",
  "max-[680px]:![grid-template-columns:100%_100%]",
  "max-[680px]:![grid-template-rows:minmax(0,1fr)]",
  "max-[680px]:!overflow-x-auto max-[680px]:!overflow-y-hidden",
  "max-[680px]:[scroll-snap-type:x_mandatory] max-[680px]:[overscroll-behavior-x:contain]",
  "max-[680px]:[scrollbar-width:none] max-[680px]:[&::-webkit-scrollbar]:hidden",
  "max-[680px]:[&_.app-rail]:sticky max-[680px]:[&_.app-rail]:left-0",
  "[&.machine-panel-collapsed_.app-rail-label]:hidden",
  "[&.machine-panel-collapsed_.app-rail-expanded]:hidden",
  "[&.machine-panel-collapsed_.app-rail]:items-center",
  "[&.machine-panel-collapsed_.workbench]:rounded-tl-rieul-2xl",
  "max-[680px]:[&.machine-panel-collapsed_.app-rail-label]:!inline",
  "max-[680px]:[&.machine-panel-collapsed_.app-rail-expanded]:!inline-flex",
  "max-[680px]:[&.machine-panel-collapsed_.app-rail]:!items-stretch",
].join(" ");
const mobileRailSnapAnchorClassName = [
  "hidden pointer-events-none",
  "max-[680px]:block max-[680px]:[grid-column:1] max-[680px]:[grid-row:1]",
  "max-[680px]:w-full max-[680px]:h-full",
  "max-[680px]:[scroll-snap-align:start] max-[680px]:[scroll-snap-stop:always]",
].join(" ");

export default function View() {
  return (
    <Layout>
      <SelectedMachineIdProvider>
        <TopBarRegion />
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
  const shellRef = useRef<HTMLElement | null>(null);
  const machinePanelCollapsed = useAtomValue(
    layout.machinePanelCollapsedAtom,
  );
  const machinePanelTransitioning = useAtomValue(
    layout.machinePanelTransitioningAtom,
  );

  useEffect(() => {
    if (!globalThis.matchMedia("(max-width: 680px)").matches) return;
    const shell = shellRef.current;
    if (!shell) return;
    const target = shell;

    function resetMobileRailPosition() {
      target.scrollLeft = 0;
    }

    resetMobileRailPosition();
    const timeout = globalThis.setTimeout(resetMobileRailPosition, 80);
    return () => globalThis.clearTimeout(timeout);
  }, []);

  return (
    <main
      ref={shellRef}
      className={className(
        appShellClassName,
        machinePanelCollapsed && "machine-panel-collapsed",
        machinePanelTransitioning && "machine-panel-transitioning",
      )}
      style={{
        "--rail-width": machinePanelCollapsed ? "64px" : "204px",
      } as React.CSSProperties}
    >
      <div className={mobileRailSnapAnchorClassName} aria-hidden="true" />
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
