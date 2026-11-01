import { style, theme } from "../../zyzz.config.ts";
import { Plus } from "../../solid/icons.tsx";
import type { Machine } from "../../state/machines.ts";
import { className } from "../class-name.ts";
import { AppTooltip } from "../ui/tooltip.tsx";

interface MachineRailProps {
  machines: Machine[];
  projectLogoUrl: string;
  selectedId?: string;
  onAddMachine: () => void;
  onContextMenu: (
    event: MouseEvent & { currentTarget: HTMLButtonElement },
    machine: Machine,
  ) => void;
  onSelectMachine: (machineId: string) => void;
}

export function MachineRail(componentProps: MachineRailProps) {
  return (
    <>
      <aside {...styles.machineRail()} aria-label="Machine switcher">
        <div {...styles.railBrand()} title="rieul">
          <img src={componentProps.projectLogoUrl} alt="rieul" />
        </div>

        <nav {...styles.railList()} aria-label="Machines">
          {componentProps.machines.map((machine) => (
            <div {...styles.railItemFrame()}>
              <AppTooltip label={machine.name}>
                <button
                  type="button"
                  class={className(
                    styles.railMachine().class,
                    machine.id === componentProps.selectedId && "active",
                  )}
                  onClick={() => componentProps.onSelectMachine(machine.id)}
                  onContextMenu={(event) =>
                    componentProps.onContextMenu(event, machine)
                  }
                  aria-label={machine.name}
                >
                  <span
                    {...styles.railIndicator({ className: "rail-indicator" })}
                  />
                  <span {...styles.machineAvatar()}>
                    {machineInitials(machine.name)}
                  </span>
                </button>
              </AppTooltip>
            </div>
          ))}
        </nav>

        <div {...styles.railItemFrame()}>
          <button
            type="button"
            {...styles.railAction()}
            onClick={() => componentProps.onAddMachine()}
            title="Add machine"
            aria-label="Add machine"
          >
            <Plus size={18} />
          </button>
        </div>
      </aside>
    </>
  );
}

function machineInitials(name: string): string {
  const letters = name
    .split(/[\s._-]+/)
    .map((part) => part.trim()[0])
    .filter(Boolean)
    .join("")
    .slice(0, 2)
    .toUpperCase();
  return letters || "PC";
}

namespace styles {
  export const machineRail = style({
    gridColumn: "1",
    gridRow: "2",
    gridTemplateRows: "48px minmax(0,1fr) auto",
    display: "grid",
    minHeight: "0",
    justifyItems: "center",
    gap: "0",
    overflow: "hidden",
    backgroundColor: theme.shellBg,
    padding: "0",
  });
  export const railBrand = style({
    selectors: {
      "& img": {
        display: "block",
        height: "48px",
        width: "48px",
        objectFit: "contain",
      },
    },
    height: "48px",
    width: "48px",
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    overflow: "visible",
  });
  export const railList = style({
    display: "grid",
    minHeight: "0",
    width: "100%",
    alignContent: "flex-start",
    justifyItems: "center",
    gap: "0",
    overflow: "auto",
  });
  export const railItemFrame = style({
    display: "grid",
    height: "48px",
    width: "100%",
    placeItems: "center",
  });
  export const railMachine = style({
    fontFamily: "inherit",
    transition:
      "border-radius 140ms ease,background 140ms ease,color 140ms ease",
    position: "relative",
    selectors: {
      "&:hover .rail-indicator": {
        height: "18px",
      },
      "&.active .rail-indicator": {
        height: "28px",
      },
      "&.active": {
        borderRadius: "13px",
        backgroundColor: theme.accent,
        color: theme.textInverse,
      },
      "&:hover": {
        borderRadius: "13px",
        backgroundColor: theme.shellItemBg,
        color: theme.shellText,
      },
    },
    height: "36px",
    minHeight: "36px",
    minWidth: "36px",
    width: "36px",
    display: "inline-flex",
    cursor: "pointer",
    WebkitAppearance: "none",
    appearance: "none",
    alignItems: "center",
    justifyContent: "center",
    borderWidth: "0px",
    borderRadius: "9999px",
    backgroundColor: theme.shellItemBg,
    padding: "0",
    color: theme.shellText,
  });
  export const railIndicator = style({
    transition: "height 140ms ease",
    position: "absolute",
    left: "-6px",
    height: "0",
    width: "3px",
    borderRadius: "0 999px 999px 0",
    backgroundColor: theme.bgPrimary,
  });
  export const machineAvatar = style({
    fontSize: "12px",
    fontWeight: 750,
    letterSpacing: "0",
  });
  export const railAction = style({
    fontFamily: "inherit",
    transition:
      "border-radius 140ms ease,background 140ms ease,color 140ms ease",
    position: "relative",
    height: "36px",
    minHeight: "36px",
    minWidth: "36px",
    width: "36px",
    display: "inline-flex",
    cursor: "pointer",
    WebkitAppearance: "none",
    appearance: "none",
    alignItems: "center",
    justifyContent: "center",
    borderWidth: "0px",
    borderRadius: "9999px",
    selectors: {
      "&:hover": {
        borderRadius: "13px",
        backgroundColor: theme.accent,
        color: theme.textInverse,
      },
    },
    backgroundColor: theme.shellItemBg,
    padding: "0",
    color: theme.shellSuccess,
  });
}
