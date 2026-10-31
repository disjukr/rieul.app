import type { JSX } from "@solidjs/web";
import { createEffect } from "solid-js";

import { useBunja } from "../solid/bunja.tsx";
import { useAtomValue } from "../solid/jotai.tsx";
import { machineStoreBunja } from "../state/machine-store.ts";
import { MachineBaseUrlContext, MachineIdContext } from "../state/machine.tsx";
import { className } from "./class-name.ts";
import { MachineModalHost } from "./machine-panel/index.tsx";
import { layoutBunja } from "./state.tsx";
import { TopBarRegion } from "./top-bar/index.tsx";
import { WorkbenchRegion } from "./workbench/index.tsx";

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
  "max-[680px]:[&.workbench-tab-dnd-active]:!overflow-x-hidden",
  "max-[680px]:[&.workbench-tab-dnd-active]:![scroll-snap-type:none]",
  "max-[680px]:[&.workbench-tab-dnd-active]:select-none",
  "max-[680px]:[scrollbar-width:none] max-[680px]:[&::-webkit-scrollbar]:hidden",
  "max-[680px]:[&_.app-rail]:sticky max-[680px]:[&_.app-rail]:left-0",
  "[&.machine-panel-collapsed_.app-rail-label]:hidden",
  "[&.machine-panel-collapsed_.app-rail-expanded]:hidden",
  "[&.machine-panel-collapsed_.app-rail]:items-center",
  "[&.machine-panel-collapsed_.workbench]:rounded-tl-rieul-2xl",
  "[&.machine-panel-transitioning_.app-rail-label]:inline",
  "[&.machine-panel-transitioning_.app-rail-expanded]:inline-flex",
  "[&.machine-panel-transitioning_.app-rail]:!items-stretch",
  "[&.machine-panel-transitioning_.app-rail-section]:!w-[var(--rail-open-section-width)]",
  "max-[680px]:[&.machine-panel-transitioning_.app-rail-section]:!w-full",
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
const appRailResizerClassName = [
  "app-rail-resizer !absolute top-0 bottom-0 !z-[20] w-[8px]",
  "left-[calc(var(--rail-width,204px)+2px)] cursor-col-resize touch-none bg-transparent",
  "before:content-[''] before:absolute before:rounded-full",
  "before:bg-[rgba(108,126,151,0.22)] before:opacity-0 before:rieul-transition",
  "before:top-[18px] before:bottom-[18px] before:left-[3px] before:w-[2px]",
  "after:content-[''] after:absolute after:rounded-full after:bg-white/38",
  "after:opacity-0 after:rieul-transition",
  "after:top-[42%] after:left-[2px] after:h-[16%] after:w-[4px]",
  "hover:before:opacity-100 hover:after:opacity-92",
  "focus-visible:before:opacity-100 focus-visible:after:opacity-92",
  "focus-visible:outline-0 max-[680px]:hidden",
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
  children: JSX.Element;
}
function Layout(componentProps: LayoutProps) {
  const layout = useBunja(layoutBunja);
  const shellRef = { current: null as HTMLElement | null | null };
  const machinePanelCollapsed = useAtomValue(
    () => layout().machinePanelCollapsedAtom,
  );
  const machinePanelTransitioning = useAtomValue(
    () => layout().machinePanelTransitioningAtom,
  );
  const machinePanelWidth = useAtomValue(() => layout().machinePanelWidthAtom);

  createEffect(
    () => [],
    () => {
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
    },
  );

  return (
    <main
      ref={(el) => {
        shellRef.current = el;
      }}
      class={className(
        appShellClassName,
        machinePanelCollapsed() && "machine-panel-collapsed",
        machinePanelTransitioning() && "machine-panel-transitioning",
      )}
      style={
        {
          "--rail-width": machinePanelCollapsed()
            ? "64px"
            : `${machinePanelWidth()}px`,
          "--rail-open-section-width": `${Math.max(machinePanelWidth() - 24, 0)}px`,
        } as JSX.CSSProperties
      }
    >
      <div class={mobileRailSnapAnchorClassName} aria-hidden="true" />
      {machinePanelCollapsed() ? null : (
        <div
          class={appRailResizerClassName}
          role="separator"
          aria-label="Resize app rail"
          aria-orientation="vertical"
          aria-valuemin={layout().machinePanelMinWidth}
          aria-valuemax={layout().machinePanelMaxWidth}
          aria-valuenow={machinePanelWidth()}
          tabindex={0}
          onPointerDown={(event) => layout().startMachinePanelResize(event)}
          onKeyDown={(event) => layout().resizeMachinePanelWithKeyboard(event)}
        />
      )}
      {componentProps.children}
    </main>
  );
}

function SelectedMachineIdProvider(componentProps: { children?: JSX.Element }) {
  const machineStore = useBunja(machineStoreBunja);
  const selected = useAtomValue(() => machineStore().selectedAtom);
  return (
    <MachineIdContext value={() => selected()?.id}>
      <MachineBaseUrlContext value={() => selected()?.baseUrl}>
        {componentProps.children}
      </MachineBaseUrlContext>
    </MachineIdContext>
  );
}
