import { style, theme } from "../../zyzz.config.ts";
import type { ParentProps } from "solid-js";
import { bunja } from "bunja";
import { createMemo } from "solid-js";

import { useBunja } from "bunja/solid";
import { ChevronLeft } from "../../solid/icons.tsx";
import { machineStoreBunja } from "../../state/machine-store.ts";
import { MachineAddFormContainer } from "../machine-panel/index.tsx";
import { WorkbenchPaneLayout } from "./pane-layout/index.tsx";
import { className } from "../class-name.ts";

const workbenchRegionBunja = bunja(() => {
  const { machines, selected } = bunja.use(machineStoreBunja);
  const hasMachines = createMemo(() => machines().length > 0);
  return {
    hasMachines,
    selected,
  };
});
export function WorkbenchRegion() {
  const _model = useBunja(workbenchRegionBunja);
  const hasMachines = () => _model().hasMachines();
  const selected = () => _model().selected();
  return (
    <>
      {(() => {
        return (
          <section
            class={className(
              styles.workbench({ className: "workbench" }).class,
              !hasMachines() && styles.section().class,
            )}
          >
            <MobileWorkbenchHeader
              machineName={selected()?.name ?? "No machine"}
            />
            {hasMachines() ? (
              <WorkbenchPaneLayout />
            ) : (
              <InlineMachineSetup>
                <MachineAddFormContainer showCancel={false} />
              </InlineMachineSetup>
            )}
          </section>
        );
      })()}
    </>
  );
}
function MobileWorkbenchHeader(props: { machineName: string }) {
  return (
    <>
      {(() => {
        return (
          <header {...styles.mobileWorkbenchHeader()}>
            <button
              type="button"
              {...styles.mobileBackButton()}
              onClick={showMobileRail}
              aria-label="Back to app rail"
              title="Back"
            >
              <ChevronLeft size={20} strokeWidth={2.2} />
            </button>
            <div {...styles.mobileMachineTitle()}>{props.machineName}</div>
          </header>
        );
      })()}
    </>
  );
}
function showMobileRail(
  event: MouseEvent & {
    currentTarget: HTMLButtonElement;
  },
) {
  const shell =
    event.currentTarget.closest<HTMLElement>(".app-shell") ??
    document.querySelector<HTMLElement>(".app-shell");
  if (!shell) return;
  shell.scrollTo({
    left: 0,
    behavior: "smooth",
  });
}
function InlineMachineSetup(props: ParentProps) {
  return (
    <>
      {(() => {
        return (
          <section {...styles.inlineMachineSetup()}>
            <div {...styles.inlineMachineCard()}>
              <header {...styles.modalHead()}>
                <div>
                  <span>Machine</span>
                  <h2>Add machine</h2>
                </div>
              </header>
              {props.children}
            </div>
          </section>
        );
      })()}
    </>
  );
}

namespace styles {
  export const workbench = style({
    gridColumn: "2",
    gridRow: "1",
    margin: "0",
    minHeight: "0",
    minWidth: "0",
    overflow: "visible",
    backgroundColor: "transparent",
    boxShadow: "0 0 rgb(0 0 0 / 0), 0 0 rgb(0 0 0 / 0), 0 0 rgb(0 0 0 / 0)",
    "@media (max-width: 680px)": {
      gridColumn: "2",
      gridRow: "1",
      gridTemplateRows: "44px minmax(0,1fr)",
      scrollSnapAlign: "start",
      scrollSnapStop: "always",
      display: "grid",
      margin: "0",
      overflow: "hidden",
      backgroundColor: theme.bgCanvas,
    },
  });
  export const mobileWorkbenchHeader = style({
    display: "none",
    minWidth: "0",
    alignItems: "center",
    gap: "8px",
    borderBottomWidth: "1px",
    borderBottomColor: theme.borderLight,
    backgroundColor: "rgba(248, 248, 248, 0.86)",
    paddingLeft: "8px",
    paddingRight: "8px",
    WebkitBackdropFilter: "blur(40px)",
    backdropFilter: "blur(40px)",
    "@media (max-width: 680px)": {
      display: "flex",
    },
  });
  export const mobileBackButton = style({
    transition:
      "background var(--rieul-duration-fast,100ms) var(--rieul-ease-out,cubic-bezier(0.16,1,0.3,1)),color var(--rieul-duration-fast,100ms) var(--rieul-ease-out,cubic-bezier(0.16,1,0.3,1)),border-color var(--rieul-duration-fast,100ms) var(--rieul-ease-out,cubic-bezier(0.16,1,0.3,1)),box-shadow var(--rieul-duration-fast,100ms) var(--rieul-ease-out,cubic-bezier(0.16,1,0.3,1))",
    fontFamily: "inherit",
    height: "34px",
    minWidth: "34px",
    width: "34px",
    display: "inline-flex",
    cursor: "pointer",
    WebkitAppearance: "none",
    appearance: "none",
    alignItems: "center",
    justifyContent: "center",
    borderWidth: "1px",
    borderColor: "transparent",
    selectors: {
      "&:hover": {
        borderColor: "rgb(255 255 255 / 0.48)",
        backgroundColor: "rgb(255 255 255 / 0.42)",
        color: theme.textPrimary,
      },
      "&:active": {
        backgroundColor: theme.bgActive,
      },
    },
    borderRadius: "12px",
    backgroundColor: "transparent",
    padding: "0",
    color: theme.textSecondary,
  });
  export const mobileMachineTitle = style({
    minWidth: "0",
    overflow: "hidden",
    textOverflow: "ellipsis",
    whiteSpace: "nowrap",
    fontSize: "13px",
    color: theme.textPrimary,
    fontWeight: 760,
  });
  export const inlineMachineSetup = style({
    display: "grid",
    minHeight: "0",
    alignContent: "center",
    justifyItems: "center",
    overflow: "auto",
    padding: "24px",
  });
  export const inlineMachineCard = style({
    width: "min(460px,100%)",
    overflow: "hidden",
    borderWidth: "1px",
    borderColor: theme.borderLight,
    borderRadius: "8px",
    backgroundColor: theme.bgPrimary,
  });
  export const modalHead = style({
    selectors: {
      "& div": {
        display: "grid",
        minWidth: "0",
        gap: "2px",
      },
      "& h2": {
        margin: "0",
        fontSize: "18px",
        color: theme.textPrimary,
        letterSpacing: "0",
      },
      "& span": {
        fontSize: "12px",
        color: theme.textTertiary,
        fontWeight: 700,
      },
    },
    display: "flex",
    alignItems: "center",
    justifyContent: "space-between",
    gap: "12px",
    borderBottomWidth: "1px",
    borderBottomColor: theme.borderMuted,
    paddingLeft: "16px",
    paddingRight: "16px",
    paddingTop: "14px",
    paddingBottom: "14px",
  });
  export const section = style({
    display: "grid",
  });
}
