import { style, theme } from "../../zyzz.config.ts";
import { createMemo } from "solid-js";

import { ChevronDown, Loader2, Wifi, WifiOff } from "../../solid/icons.tsx";
import type { Machine } from "../../state/machines.ts";
import type { ConnectionState } from "../../state/types.ts";

interface MachinePanelProps {
  connection: ConnectionState;
  machine?: Machine;
  machinePanelCollapsed: boolean;
  machinePanelMaxWidth: number;
  machinePanelMinWidth: number;
  machinePanelWidth: number;
  onOpenMachineMenu: (
    event: MouseEvent & { currentTarget: HTMLButtonElement },
    machine: Machine,
  ) => void;
  onResizeKeyDown: (
    event: KeyboardEvent & { currentTarget: HTMLDivElement },
  ) => void;
  onResizePointerDown: (
    event: PointerEvent & { currentTarget: HTMLDivElement },
  ) => void;
}

export function MachinePanel(componentProps: MachinePanelProps) {
  return (
    <aside
      {...styles.machinePanel({ className: "machine-panel" })}
      aria-label="Machine workspace"
      aria-hidden={componentProps.machinePanelCollapsed ? "true" : "false"}
      inert={componentProps.machinePanelCollapsed ? true : undefined}
    >
      <div {...styles.machinePanelInner()}>
        <section {...styles.machinePanelSummary()}>
          <div {...styles.machineTitle()}>
            <h1>
              {componentProps.machine ? (
                <button
                  type="button"
                  class={[
                    styles.machineTitleButton({
                      className: "machine-title-button",
                    }).class,
                    componentProps.connection.phase === "idle"
                      ? "checking"
                      : "",
                  ]
                    .filter(Boolean)
                    .join(" ")}
                  onMouseDown={(event) => event.stopPropagation()}
                  onClick={(event) =>
                    componentProps.onOpenMachineMenu(
                      event,
                      componentProps.machine!,
                    )
                  }
                  title="Machine actions"
                  aria-label={`${componentProps.machine.name} machine actions`}
                  tabindex={
                    componentProps.machinePanelCollapsed ? -1 : undefined
                  }
                >
                  <span
                    {...styles.machineTitleText({
                      className: "machine-title-text",
                    })}
                  >
                    {componentProps.machine.name}
                  </span>
                  <MachineTitleStatus connection={componentProps.connection} />
                  <ChevronDown size={16} />
                </button>
              ) : (
                "No machine"
              )}
            </h1>
            <MachineConnectionLine
              connection={componentProps.connection}
              machine={componentProps.machine}
            />
          </div>
        </section>

        <MachineContext
          machine={componentProps.machine}
          connection={componentProps.connection}
        />
      </div>
      <div
        {...styles.machinePanelResizer()}
        role="separator"
        aria-label="Resize machine panel"
        aria-orientation="vertical"
        aria-valuemin={componentProps.machinePanelMinWidth}
        aria-valuemax={componentProps.machinePanelMaxWidth}
        aria-valuenow={componentProps.machinePanelWidth}
        tabindex={componentProps.machinePanelCollapsed ? -1 : 0}
        onPointerDown={(event) => componentProps.onResizePointerDown(event)}
        onKeyDown={(event) => componentProps.onResizeKeyDown(event)}
      />
    </aside>
  );
}

function MachineContext(
  componentProps: MachineTitleStatusProps & { machine?: Machine },
) {
  return (
    <div {...styles.machineContext()} aria-label="Machine context">
      <ContextRow
        label="Target"
        value={componentProps.machine?.name ?? "No machine"}
      />
      <ContextRow
        label="Transport"
        value={connectionTransport(componentProps.connection)}
      />
      <ContextRow
        label="Endpoint"
        value={
          componentProps.machine?.baseUrl.replace(/^https?:\/\//, "") ?? "-"
        }
      />
    </div>
  );
}

function ContextRow(componentProps: { label: string; value: string }) {
  return (
    <div {...styles.machineContextRow()}>
      <span {...styles.machineContextLabel()}>{componentProps.label}</span>
      <span {...styles.machineContextValue()}>{componentProps.value}</span>
    </div>
  );
}

function connectionTransport(connection: ConnectionState): string {
  switch (connection.phase) {
    case "reachable":
      return "WebTransport";
    case "idle":
      return "Checking";
    case "offline":
      return "Unavailable";
  }
}

function MachineConnectionLine(
  componentProps: MachineTitleStatusProps & { machine?: Machine },
) {
  const text = createMemo(() =>
    !componentProps.machine
      ? "No target"
      : componentProps.connection.phase === "reachable"
        ? "Connected"
        : componentProps.connection.phase === "idle"
          ? "Connecting"
          : "Offline",
  );
  const tone = createMemo(() =>
    !componentProps.machine
      ? styles.connectionIdle().class
      : componentProps.connection.phase === "reachable"
        ? styles.connectionSuccess().class
        : componentProps.connection.phase === "idle"
          ? styles.connectionWaiting().class
          : styles.connectionError().class,
  );
  return (
    <div {...styles.machineConnectionLine()}>
      <span class={`${styles.machineConnectionDot().class} ${tone()}`} />
      <span>{text()}</span>
    </div>
  );
}

interface MachineTitleStatusProps {
  connection: ConnectionState;
}

function MachineTitleStatus(props: MachineTitleStatusProps) {
  return (
    <>
      {props.connection.phase === "reachable" ? (
        <Wifi
          size={14}
          className={`${styles.machineTitleStatusIcon().class} ${styles.connectedIcon().class} `}
          aria-label="Connected"
        />
      ) : props.connection.phase === "idle" ? (
        <Loader2
          size={14}
          className={`${styles.machineTitleStatusIcon().class} ${styles.connectingIcon().class} `}
          aria-label="Connecting"
        />
      ) : (
        <WifiOff
          size={14}
          className={`${styles.machineTitleStatusIcon().class} ${styles.offlineIcon().class} `}
          aria-label="Unconnected"
        />
      )}
    </>
  );
}

namespace styles {
  export const connectedIcon = style({
    color: theme.success,
  });
  export const connectingIcon = style({
    animation: "spin 1s linear infinite",
    color: theme.warning,
  });
  export const offlineIcon = style({
    color: theme.danger,
  });
  export const connectionError = style({
    backgroundColor: theme.danger,
  });

  export const connectionWaiting = style({
    backgroundColor: theme.warning,
  });

  export const connectionSuccess = style({
    backgroundColor: theme.success,
  });

  export const connectionIdle = style({
    backgroundColor: theme.textDisabled,
  });

  export const machinePanel = style({
    gridColumn: "2",
    gridRow: "1",
    gridTemplateRows: "auto minmax(0,1fr)",
    position: "relative",
    display: "grid",
    minHeight: "0",
    minWidth: "0",
    overflow: "hidden",
    borderRightWidth: "1px",
    borderRightColor: theme.borderLight,
    backgroundColor: "rgba(242, 242, 243, 0.74)",
    boxShadow:
      "0 0 rgb(0 0 0 / 0), 0 0 rgb(0 0 0 / 0), inset -1px 0 0 rgba(255, 255, 255, 0.54)",
    WebkitBackdropFilter: "blur(24px)",
    backdropFilter: "blur(24px)",
    transitionProperty: "border-color,border-radius",
    transitionTimingFunction: "cubic-bezier(0, 0, 0.2, 1)",
    transitionDuration: "150ms",
    "@media (max-width: 680px)": {
      display: "none",
    },
  });
  export const machinePanelInner = style({
    gridTemplateRows: "auto minmax(0,1fr)",
    display: "grid",
    height: "100%",
    minHeight: "0",
    minWidth: "var(--machine-panel-open-width,264px)",
    width: "var(--machine-panel-open-width,264px)",
    "@media (max-width: 680px)": {
      gridTemplateRows: "minmax(0,1fr)",
      minWidth: "0",
      width: "100%",
    },
  });
  export const machinePanelSummary = style({
    display: "grid",
    height: "54px",
    minHeight: "54px",
    borderBottomWidth: "1px",
    borderBottomColor: theme.borderLight,
    backgroundColor: "rgba(255, 255, 255, 0.24)",
    paddingLeft: "10px",
    paddingRight: "10px",
    "@media (max-width: 680px)": {
      display: "none",
    },
  });
  export const machineTitle = style({
    display: "grid",
    selectors: {
      "& h1": {
        margin: "0",
        minWidth: "0",
        display: "flex",
        alignItems: "center",
      },
    },
    minWidth: "0",
    alignContent: "center",
    gap: "3px",
  });
  export const machineTitleButton = style({
    fontFamily: "inherit",
    height: "28px",
    maxWidth: "100%",
    minHeight: "28px",
    display: "inline-flex",
    selectors: {
      "& svg": {
        flex: "0 0 auto",
      },
      "&:hover": {
        backgroundColor: "rgb(255 255 255 / 0.28)",
      },
      "&:active": {
        backgroundColor: theme.bgActive,
      },
    },
    cursor: "pointer",
    WebkitAppearance: "none",
    appearance: "none",
    alignItems: "center",
    justifyContent: "flex-start",
    gap: "0.5rem",
    overflow: "visible",
    borderWidth: "1px",
    borderColor: "transparent",
    borderRadius: theme.radiusSm,
    backgroundColor: "transparent",
    paddingLeft: "6px",
    paddingRight: "6px",
    fontSize: "14px",
    color: theme.textPrimary,
    fontWeight: 700,
    lineHeight: 1,
    letterSpacing: "0",
  });
  export const machineTitleText = style({
    display: "block",
    minWidth: "0",
    flex: "1 1 auto",
    overflow: "hidden",
    textOverflow: "ellipsis",
    whiteSpace: "nowrap",
    lineHeight: 1.25,
  });
  export const machineTitleStatusIcon = style({
    strokeWidth: 2.4,
    flex: "0 0 auto",
  });
  export const machineConnectionLine = style({
    marginLeft: "6px",
    minWidth: "0",
    display: "flex",
    alignItems: "center",
    gap: "6px",
    fontSize: "12px",
    color: theme.textTertiary,
    fontWeight: 650,
  });
  export const machineConnectionDot = style({
    height: "6px",
    width: "6px",
    borderRadius: "9999px",
  });
  export const machineContext = style({
    display: "grid",
    alignContent: "flex-start",
    gap: "10px",
    paddingLeft: "10px",
    paddingRight: "10px",
    paddingTop: "12px",
    paddingBottom: "12px",
    fontSize: "12px",
    color: theme.textTertiary,
    "@media (max-width: 680px)": {
      display: "none",
    },
  });
  export const machineContextRow = style({
    display: "grid",
    gridTemplateColumns: "72px minmax(0,1fr)",
    minHeight: "30px",
    alignItems: "center",
    gap: "8px",
    borderBottomWidth: "1px",
    borderBottomColor: "rgb(255 255 255 / 0.26)",
    paddingLeft: "6px",
    paddingRight: "6px",
  });
  export const machineContextLabel = style({
    color: theme.textTertiary,
    fontWeight: 650,
  });
  export const machineContextValue = style({
    minWidth: "0",
    overflow: "hidden",
    textOverflow: "ellipsis",
    whiteSpace: "nowrap",
    textAlign: "right",
    color: theme.textSecondary,
    fontWeight: 700,
  });
  export const machinePanelResizer = style({
    position: "absolute",
    selectors: {
      "&::after": {
        position: "absolute",
        bottom: "0",
        left: "3px",
        top: "0",
        width: "1px",
        backgroundColor: "transparent",
        content: "''",
      },
      "&:hover::after": {
        width: "2px",
        backgroundColor: theme.accent,
      },
      "&:focus-visible::after": {
        width: "2px",
        backgroundColor: theme.accent,
      },
      "&:focus-visible": {
        outlineWidth: "0px",
      },
    },
    bottom: "0",
    right: "-4px",
    top: "0",
    zIndex: 8,
    width: "8px",
    cursor: "col-resize",
    touchAction: "none",
    "@media (max-width: 680px)": {
      display: "none",
    },
  });
}
