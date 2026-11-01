import { style, theme } from "../../zyzz.config.ts";
import { createEffect, createMemo, createSignal } from "solid-js";

import type { AvailableShellInfo } from "../../protocol/generated/rpc.ts";
import {
  Activity,
  AppWindow,
  ChevronDown,
  Folder,
  HardDrive,
  Home,
  Info,
  Terminal,
  Trash2,
} from "../../solid/icons.tsx";
import type {
  WorkbenchFilesView,
  WorkbenchTool,
} from "../../state/workbench.ts";
import { className } from "../class-name.ts";
import {
  FloatingMenu,
  FloatingMenuItem,
  type FloatingMenuPosition,
  floatingMenuPositionFromRect,
  useFloatingMenuDismiss,
} from "../ui/floating-menu.tsx";

const tools: {
  id: WorkbenchTool;
  label: string;
  disabled?: boolean;
  Icon: typeof Folder;
}[] = [
  { id: "desktop", label: "Remote desktop", Icon: AppWindow },
  {
    id: "daemon",
    label: "Daemon",
    Icon: Info,
  },
  {
    id: "files",
    label: "Files",
    Icon: Folder,
  },
  {
    id: "terminal",
    label: "Terminal",
    Icon: Terminal,
  },
  {
    id: "windows",
    label: "Windows",
    Icon: AppWindow,
  },
  {
    id: "processes",
    label: "Processes",
    Icon: Activity,
  },
];

const SHELL_MENU_WIDTH = 260;
const SHELL_MENU_MAX_HEIGHT = 360;
const SHELL_MENU_TRIGGER_GAP = 0;
const FILES_MENU_WIDTH = 176;

interface ToolMenuProps {
  activeTool: WorkbenchTool;
  terminalShells: AvailableShellInfo[];
  onOpenFilesView: (filesView: WorkbenchFilesView) => void;
  onOpenTerminalShell: (shell?: AvailableShellInfo) => void;
  onSelect: (tool: WorkbenchTool) => void;
}

export function ToolMenu(componentProps: ToolMenuProps) {
  const hasTerminalShells = createMemo(
    () => componentProps.terminalShells.length > 0,
  );
  const [filesMenuOpen, setFilesMenuOpen] = createSignal(false);
  const [filesMenuPosition, setFilesMenuPosition] = createSignal<
    FloatingMenuPosition | undefined
  >(undefined);
  const [shellMenuOpen, setShellMenuOpen] = createSignal(false);
  const [shellMenuPosition, setShellMenuPosition] = createSignal<
    FloatingMenuPosition | undefined
  >(undefined);
  const filesMenuRef = { current: null as HTMLDivElement | null };
  const shellMenuRef = { current: null as HTMLDivElement | null };
  useFloatingMenuDismiss(() => filesMenuOpen(), filesMenuRef, closeFilesMenu, {
    closeOnScroll: true,
  });
  useFloatingMenuDismiss(() => shellMenuOpen(), shellMenuRef, closeShellMenu, {
    closeOnScroll: true,
  });

  createEffect(
    () => ({ hasTerminalShellsSnapshot: hasTerminalShells() }),
    ({ hasTerminalShellsSnapshot }) => {
      if (!hasTerminalShellsSnapshot) closeShellMenu();
    },
  );

  function closeShellMenu() {
    setShellMenuOpen(false);
    setShellMenuPosition(undefined);
  }

  function closeFilesMenu() {
    setFilesMenuOpen(false);
    setFilesMenuPosition(undefined);
  }

  function toggleFilesMenu(
    event: MouseEvent & { currentTarget: HTMLButtonElement },
  ) {
    if (filesMenuOpen()) {
      closeFilesMenu();
      return;
    }
    setFilesMenuPosition(
      floatingMenuPositionFromRect(
        event.currentTarget.getBoundingClientRect(),
        {
          itemCount: 3,
          width: FILES_MENU_WIDTH,
        },
        SHELL_MENU_TRIGGER_GAP,
      ),
    );
    setFilesMenuOpen(true);
  }

  function toggleShellMenu(
    event: MouseEvent & { currentTarget: HTMLButtonElement },
  ) {
    if (!hasTerminalShells()) return;
    if (shellMenuOpen()) {
      closeShellMenu();
      return;
    }
    setShellMenuPosition(
      shellMenuPositionFromRect(
        event.currentTarget.getBoundingClientRect(),
        componentProps.terminalShells.length,
      ),
    );
    setShellMenuOpen(true);
  }

  function openShellTerminal(shell: AvailableShellInfo) {
    closeShellMenu();
    componentProps.onOpenTerminalShell(shell);
  }

  function openDefaultTerminal() {
    closeShellMenu();
    componentProps.onOpenTerminalShell();
  }

  function openFilesView(filesView: WorkbenchFilesView) {
    closeFilesMenu();
    componentProps.onOpenFilesView(filesView);
  }

  return (
    <nav {...styles.toolMenu()} aria-label="Workspace tools">
      {tools.map(({ id, label, disabled, Icon }) =>
        id === "files" ? (
          <div
            {...styles.toolItemRow()}
            ref={(el) => {
              filesMenuRef.current = el;
            }}
          >
            <button
              type="button"
              class={className(
                [styles.toolItem().class, styles.terminalRadius().class].join(
                  " ",
                ),
                componentProps.activeTool === id && "active",
              )}
              onClick={() => openFilesView("home")}
              disabled={disabled}
              aria-current={
                componentProps.activeTool === id ? "page" : undefined
              }
            >
              <Icon size={17} />
              <span>{label}</span>
            </button>
            <button
              type="button"
              class={className(
                styles.terminalDropdownButton().class,
                (componentProps.activeTool === id || filesMenuOpen()) &&
                  "active",
              )}
              onClick={toggleFilesMenu}
              disabled={disabled}
              aria-label="Open files view menu"
              aria-haspopup="menu"
              aria-expanded={filesMenuOpen() ? "true" : "false"}
              title="Open files view"
            >
              <ChevronDown size={14} />
            </button>
            {filesMenuOpen() ? (
              <FloatingMenu
                className={styles.floatingMenu().class}
                menuRef={filesMenuRef}
                position={filesMenuPosition()}
              >
                <FloatingMenuItem onClick={() => openFilesView("roots")}>
                  <HardDrive size={15} />
                  Root
                </FloatingMenuItem>
                <FloatingMenuItem onClick={() => openFilesView("home")}>
                  <Home size={15} />
                  Home
                </FloatingMenuItem>
                <FloatingMenuItem onClick={() => openFilesView("trash")}>
                  <Trash2 size={15} />
                  Trash
                </FloatingMenuItem>
              </FloatingMenu>
            ) : null}
          </div>
        ) : id === "terminal" ? (
          <div
            class={
              hasTerminalShells()
                ? styles.toolItemRow().class
                : styles.toolItemFrame().class
            }
            ref={(el) => {
              shellMenuRef.current = el;
            }}
          >
            <button
              type="button"
              class={className(
                hasTerminalShells()
                  ? [
                      styles.toolItem().class,
                      styles.terminalRadius().class,
                    ].join(" ")
                  : styles.toolItem().class,
                componentProps.activeTool === id && "active",
              )}
              onClick={() => {
                openDefaultTerminal();
              }}
              disabled={disabled}
              aria-current={
                componentProps.activeTool === id ? "page" : undefined
              }
            >
              <Icon size={17} />
              <span>{label}</span>
            </button>
            {hasTerminalShells() ? (
              <button
                type="button"
                class={className(
                  styles.terminalDropdownButton().class,
                  (componentProps.activeTool === id || shellMenuOpen()) &&
                    "active",
                )}
                onClick={toggleShellMenu}
                disabled={disabled}
                aria-label="Open terminal shell menu"
                aria-haspopup="menu"
                aria-expanded={shellMenuOpen() ? "true" : "false"}
                title="Open terminal shell"
              >
                <ChevronDown size={14} />
              </button>
            ) : null}
            {hasTerminalShells() && shellMenuOpen() ? (
              <FloatingMenu
                className={styles.floatingMenu2().class}
                menuRef={shellMenuRef}
                position={shellMenuPosition()}
              >
                {componentProps.terminalShells.map((shell) => (
                  <FloatingMenuItem
                    className={className(
                      styles.shellMenuItem().class,
                      shell.isDefault && styles.shellMenuDefaultItem().class,
                    )}
                    onClick={() => openShellTerminal(shell)}
                    title={`${shell.name} (${commandName(shell.command)})`}
                  >
                    <span {...styles.shellMenuItemLabel()}>
                      <span {...styles.shellMenuShellName()}>{shell.name}</span>
                      {shell.isDefault ? (
                        <span {...styles.shellMenuDefaultBadge()}>Default</span>
                      ) : null}
                    </span>
                    <small {...styles.shellMenuCommand()}>
                      {commandName(shell.command)}
                    </small>
                  </FloatingMenuItem>
                ))}
              </FloatingMenu>
            ) : null}
          </div>
        ) : (
          <div {...styles.toolItemFrame()}>
            <button
              type="button"
              class={className(
                styles.toolItem().class,
                componentProps.activeTool === id && "active",
              )}
              onClick={() => componentProps.onSelect(id)}
              disabled={disabled}
              aria-current={
                componentProps.activeTool === id ? "page" : undefined
              }
            >
              <Icon size={17} />
              <span>{label}</span>
            </button>
          </div>
        ),
      )}
    </nav>
  );
}

function shellMenuPositionFromRect(
  rect: DOMRect,
  shellCount: number,
): FloatingMenuPosition {
  return floatingMenuPositionFromRect(
    rect,
    {
      itemCount: shellCount,
      maxHeight: SHELL_MENU_MAX_HEIGHT,
      minHeight: 120,
      width: SHELL_MENU_WIDTH,
    },
    SHELL_MENU_TRIGGER_GAP,
  );
}

function commandName(command: string): string {
  const normalized = command.replaceAll("\\", "/");
  const segments = normalized.split("/").filter(Boolean);
  return segments[segments.length - 1] ?? command;
}

namespace styles {
  export const terminalRadius = style({
    borderRadius: theme.radiusSm,
    "@media (max-width: 680px)": {
      borderRadius: theme.radiusMd,
    },
  });

  export const toolMenu = style({
    display: "grid",
    minHeight: "0",
    alignContent: "flex-start",
    gap: "2px",
    overflow: "visible",
    paddingLeft: "8px",
    paddingRight: "8px",
    paddingTop: "10px",
    paddingBottom: "10px",
    "@media (max-width: 680px)": {
      scrollbarWidth: "none",
      selectors: {
        "&::-webkit-scrollbar": {
          display: "none",
        },
      },
      height: "100%",
      display: "flex",
      alignItems: "center",
      gap: "6px",
      overflowX: "auto",
      overflowY: "visible",
      paddingLeft: "8px",
      paddingRight: "8px",
      paddingTop: "7px",
      paddingBottom: "7px",
    },
  });
  export const toolItemFrame = style({
    boxSizing: "border-box",
    height: "34px",
    "@media (max-width: 680px)": {
      height: "54px",
      flex: "0 0 auto",
    },
  });
  export const toolItemRow = style({
    gridTemplateColumns: "minmax(0,1fr) 34px",
    position: "relative",
    display: "grid",
    boxSizing: "border-box",
    height: "34px",
    "@media (max-width: 680px)": {
      gridTemplateColumns: "minmax(0,1fr)",
      height: "54px",
      width: "78px",
      flex: "0 0 78px",
    },
  });
  export const toolItem = style({
    transition:
      "background var(--rieul-duration-fast,100ms) var(--rieul-ease-out,cubic-bezier(0.16,1,0.3,1)),color var(--rieul-duration-fast,100ms) var(--rieul-ease-out,cubic-bezier(0.16,1,0.3,1)),border-color var(--rieul-duration-fast,100ms) var(--rieul-ease-out,cubic-bezier(0.16,1,0.3,1)),box-shadow var(--rieul-duration-fast,100ms) var(--rieul-ease-out,cubic-bezier(0.16,1,0.3,1))",
    selectors: {
      "&.active": {
        boxShadow:
          "0 1px 2px rgba(18,25,38,0.08),inset 0 1px 0 rgba(255,255,255,0.62)",
        borderColor: theme.borderLight,
        backgroundColor: "rgb(255 255 255 / 0.42)",
        color: theme.textPrimary,
      },
      "& span": {
        minWidth: "0",
        overflow: "hidden",
        textOverflow: "ellipsis",
        whiteSpace: "nowrap",
        fontWeight: 500,
      },
      "&:hover": {
        backgroundColor: "rgb(255 255 255 / 0.38)",
        color: theme.textPrimary,
      },
      "&:disabled": {
        opacity: 0.56,
      },
    },
    fontFamily: "inherit",
    height: "100%",
    minHeight: "0",
    width: "100%",
    display: "inline-flex",
    cursor: "pointer",
    WebkitAppearance: "none",
    appearance: "none",
    alignItems: "center",
    justifyContent: "flex-start",
    gap: "0.5rem",
    borderWidth: "1px",
    borderColor: "transparent",
    borderRadius: theme.radiusSm,
    backgroundColor: "transparent",
    paddingLeft: "7px",
    paddingRight: "7px",
    textAlign: "left",
    color: theme.textSecondary,
    "@media (max-width: 680px)": {
      selectors: {
        "&.active": {
          boxShadow:
            "inset 0 3px 0 var(--rieul-accent),0 1px 2px rgba(18,25,38,0.08)",
        },
      },
      width: "74px",
      flexDirection: "column",
      justifyContent: "center",
      gap: "3px",
      paddingLeft: "5px",
      paddingRight: "5px",
      textAlign: "center",
      fontSize: "11px",
      lineHeight: 1.1,
    },
  });
  export const terminalDropdownButton = style({
    fontFamily: "inherit",
    height: "100%",
    minHeight: "0",
    minWidth: "34px",
    width: "34px",
    display: "inline-flex",
    cursor: "pointer",
    WebkitAppearance: "none",
    appearance: "none",
    alignItems: "center",
    justifyContent: "center",
    borderWidth: "1px",
    selectors: {
      "&.active": {
        borderColor: theme.borderLight,
        backgroundColor: "rgb(255 255 255 / 0.42)",
        color: theme.textPrimary,
      },
      "&:hover": {
        backgroundColor: "rgb(255 255 255 / 0.38)",
        color: theme.textPrimary,
      },
    },
    borderColor: "transparent",
    borderRadius: theme.radiusSm,
    backgroundColor: "transparent",
    padding: "0",
    color: theme.textSecondary,
    "@media (max-width: 680px)": {
      display: "none",
    },
  });
  export const shellMenuItem = style({
    display: "grid !important",
    gridTemplateColumns: "minmax(0,1fr) auto",
    minWidth: "0",
    gap: "0.5rem !important",
  });
  export const shellMenuDefaultItem = style({
    backgroundColor: theme.accentSoft,
  });
  export const shellMenuItemLabel = style({
    minWidth: "0",
    display: "flex",
    alignItems: "center",
    gap: "0.5rem",
    textAlign: "left",
  });
  export const shellMenuShellName = style({
    display: "block",
    minWidth: "0",
    overflow: "hidden",
    textOverflow: "ellipsis",
    whiteSpace: "nowrap",
    textAlign: "left",
  });
  export const shellMenuDefaultBadge = style({
    borderRadius: "999px",
    backgroundColor: theme.bgPrimary,
    paddingLeft: "6px",
    paddingRight: "6px",
    paddingTop: "1px",
    paddingBottom: "1px",
    fontSize: "11px",
    color: theme.textSecondary,
    fontWeight: 600,
  });
  export const shellMenuCommand = style({
    display: "block",
    maxWidth: "88px",
    minWidth: "0",
    overflow: "hidden",
    textOverflow: "ellipsis",
    whiteSpace: "nowrap",
    textAlign: "right",
    color: theme.textTertiary,
  });
  export const floatingMenu = style({
    zIndex: 80,
    width: "176px",
  });
  export const floatingMenu2 = style({
    zIndex: 80,
    width: "260px",
    overflowX: "hidden",
    overflowY: "auto",
  });
}
