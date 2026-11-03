import { ClusterConnections } from "./cluster-connections.tsx";
import { style, theme } from "../zyzz.config.ts";
import type { JSX } from "@solidjs/web";
import { createEffect } from "solid-js";

import { useBunja } from "bunja/solid";

import { machineStoreBunja } from "../state/machine-store.ts";
import { MachineBaseUrlContext, MachineIdContext } from "../state/machine.tsx";
import { className } from "./class-name.ts";
import { MachineModalHost } from "./machine-panel/index.tsx";
import { layoutBunja } from "./state.tsx";
import { TopBarRegion } from "./top-bar/index.tsx";
import { WorkbenchRegion } from "./workbench/index.tsx";

export default function View() {
  return (
    <Layout>
      <ClusterConnections />
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
  const machinePanelCollapsed = () => layout().machinePanelCollapsed();
  const machinePanelTransitioning = () => layout().machinePanelTransitioning();
  const machinePanelWidth = () => layout().machinePanelWidth();

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
        styles.appShell({ className: "app-shell" }).class,
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
      <div {...styles.mobileRailSnapAnchor()} aria-hidden="true" />
      {machinePanelCollapsed() ? null : (
        <div
          {...styles.appRailResizer({ className: "app-rail-resizer" })}
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
  const selected = () => machineStore().selected();
  return (
    <MachineIdContext value={() => selected()?.id}>
      <MachineBaseUrlContext value={() => selected()?.baseUrl}>
        {componentProps.children}
      </MachineBaseUrlContext>
    </MachineIdContext>
  );
}

namespace styles {
  export const appShell = style({
    selectors: {
      "&.machine-panel-transitioning": {
        transition: "grid-template-columns 180ms ease",
      },
      "&>*": {
        position: "relative",
        zIndex: 1,
      },
      "&.machine-panel-transitioning .app-rail-label": {
        display: "inline",
      },
      "&.machine-panel-collapsed .app-rail-expanded": {
        display: "none",
      },
      "&.machine-panel-collapsed .app-rail-label": {
        display: "none",
      },
      "&.machine-panel-transitioning .app-rail-section": {
        width: "var(--rail-open-section-width) !important",
      },
      "&.machine-panel-transitioning .app-rail-expanded": {
        display: "inline-flex",
      },
      "&.machine-panel-collapsed .app-rail": {
        alignItems: "center",
      },
      "&.machine-panel-transitioning .app-rail": {
        alignItems: "stretch !important",
      },
      "&.machine-panel-collapsed .workbench": {
        borderTopLeftRadius: theme.radius2xl,
      },
    },
    background: theme.canvasBackground,
    gridTemplateColumns: "var(--rail-width,204px) minmax(0,1fr)",
    gridTemplateRows: "minmax(0,1fr)",
    position: "relative",
    isolation: "isolate",
    display: "grid",
    height: "100%",
    minHeight: "0",
    overflow: "hidden",
    backgroundColor: theme.bgCanvas,
    "@media (max-width: 680px)": {
      gridTemplateColumns: "100% 100% !important",
      gridTemplateRows: "minmax(0,1fr) !important",
      selectors: {
        "&.workbench-tab-dnd-active": {
          scrollSnapType: "none !important",
          WebkitUserSelect: "none",
          userSelect: "none",
          overflowX: "hidden !important",
        },
        "& .app-rail": {
          position: "sticky",
          left: "0",
        },
        "&.machine-panel-collapsed .app-rail-label": {
          display: "inline !important",
        },
        "&::-webkit-scrollbar": {
          display: "none",
        },
        "&.machine-panel-transitioning .app-rail-section": {
          width: "100% !important",
        },
        "&.machine-panel-collapsed .app-rail-expanded": {
          display: "inline-flex !important",
        },
        "&.machine-panel-collapsed .app-rail": {
          alignItems: "stretch !important",
        },
      },
      overscrollBehaviorX: "contain",
      scrollSnapType: "x mandatory",
      scrollbarWidth: "none",
      overflowX: "auto !important",
      overflowY: "hidden !important",
    },
    "@media (max-width: 980px)": {
      gridTemplateColumns: "var(--rail-width,184px) minmax(0,1fr)",
    },
  });
  export const mobileRailSnapAnchor = style({
    pointerEvents: "none",
    display: "none",
    "@media (max-width: 680px)": {
      gridColumn: "1",
      gridRow: "1",
      scrollSnapAlign: "start",
      scrollSnapStop: "always",
      display: "block",
      height: "100%",
      width: "100%",
    },
  });
  export const appRailResizer = style({
    selectors: {
      "&::before": {
        transition:
          "background var(--rieul-duration-fast,100ms) var(--rieul-ease-out,cubic-bezier(0.16,1,0.3,1)),color var(--rieul-duration-fast,100ms) var(--rieul-ease-out,cubic-bezier(0.16,1,0.3,1)),border-color var(--rieul-duration-fast,100ms) var(--rieul-ease-out,cubic-bezier(0.16,1,0.3,1)),box-shadow var(--rieul-duration-fast,100ms) var(--rieul-ease-out,cubic-bezier(0.16,1,0.3,1))",
        position: "absolute",
        bottom: "18px",
        left: "3px",
        top: "18px",
        width: "2px",
        borderRadius: "9999px",
        backgroundColor: "rgba(108, 126, 151, 0.22)",
        opacity: 0,
        content: "''",
      },
      "&::after": {
        transition:
          "background var(--rieul-duration-fast,100ms) var(--rieul-ease-out,cubic-bezier(0.16,1,0.3,1)),color var(--rieul-duration-fast,100ms) var(--rieul-ease-out,cubic-bezier(0.16,1,0.3,1)),border-color var(--rieul-duration-fast,100ms) var(--rieul-ease-out,cubic-bezier(0.16,1,0.3,1)),box-shadow var(--rieul-duration-fast,100ms) var(--rieul-ease-out,cubic-bezier(0.16,1,0.3,1))",
        position: "absolute",
        left: "2px",
        top: "42%",
        height: "16%",
        width: "4px",
        borderRadius: "9999px",
        backgroundColor: "rgb(255 255 255 / 0.38)",
        opacity: 0,
        content: "''",
      },
      "&:hover::after": {
        opacity: 0.92,
      },
      "&:hover::before": {
        opacity: 1,
      },
      "&:focus-visible::after": {
        opacity: 0.92,
      },
      "&:focus-visible::before": {
        opacity: 1,
      },
      "&:focus-visible": {
        outlineWidth: "0px",
      },
    },
    position: "absolute !important",
    bottom: "0",
    left: "calc(var(--rail-width,204px) + 2px)",
    top: "0",
    zIndex: "20 !important",
    width: "8px",
    cursor: "col-resize",
    touchAction: "none",
    backgroundColor: "transparent",
    "@media (max-width: 680px)": {
      display: "none",
    },
  });
}
