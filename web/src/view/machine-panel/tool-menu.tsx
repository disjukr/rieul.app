import {
  type MouseEvent as ReactMouseEvent,
  useEffect,
  useRef,
  useState,
} from "react";
import { Activity, ChevronDown, Folder, Info, Terminal } from "lucide-react";
import type { AvailableShellInfo } from "../../protocol/rpc.ts";
import type { WorkbenchTool } from "../../state/workbench.ts";
import { className } from "../class-name.ts";

const tools: {
  id: WorkbenchTool;
  label: string;
  disabled?: boolean;
  Icon: typeof Folder;
}[] = [
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
    id: "processes",
    label: "Processes",
    Icon: Activity,
    disabled: true,
  },
];

const SHELL_MENU_WIDTH = 260;
const SHELL_MENU_MAX_HEIGHT = 360;
const SHELL_MENU_EDGE_GAP = 8;
const SHELL_MENU_TRIGGER_GAP = 5;

const toolMenuClassName =
  "grid content-start gap-[4px] min-h-0 overflow-visible px-[8px] py-[10px]";
const toolItemRowClassName =
  "relative grid [grid-template-columns:minmax(0,1fr)_30px]";
const toolItemClassName = [
  "inline-flex appearance-none items-center justify-start gap-[8px]",
  "w-full min-h-[38px] border-0 rounded-[6px]",
  "cursor-pointer bg-transparent px-[10px] text-left text-[#475467] [font-family:inherit]",
  "hover:bg-[#eef3fb] hover:text-[#20242d]",
  "[&.active]:bg-[#eef3fb] [&.active]:text-[#20242d]",
  "disabled:opacity-56",
  "[&_span]:min-w-0 [&_span]:overflow-hidden [&_span]:text-ellipsis",
  "[&_span]:whitespace-nowrap [&_span]:text-[13px] [&_span]:font-700",
].join(" ");
const terminalMainButtonClassName = [
  toolItemClassName,
  "rounded-r-[3px]",
].join(" ");
const terminalDropdownButtonClassName = [
  "inline-flex appearance-none items-center justify-center",
  "min-h-[38px] w-[30px] min-w-[30px] p-0 rounded-l-[3px] rounded-r-[6px]",
  "cursor-pointer border-0 bg-transparent text-[#475467] [font-family:inherit]",
  "hover:bg-[#eef3fb] hover:text-[#20242d]",
  "[&.active]:bg-[#eef3fb] [&.active]:text-[#20242d]",
].join(" ");
const shellMenuClassName = [
  "fixed z-[80] grid w-[260px] overflow-x-hidden overflow-y-auto",
  "gap-[2px] rounded-[7px] border border-[#d8dde7] bg-white p-[5px]",
  "[box-shadow:0_16px_42px_rgb(32_36_45_/_20%)]",
].join(" ");
const shellMenuItemClassName = [
  "!flex !appearance-none !flex-col !items-start !justify-center !gap-[1px]",
  "w-full min-w-0 min-h-[34px]",
  "cursor-pointer rounded-[5px] border-0 bg-transparent px-[8px] text-left text-[#20242d] [font-family:inherit]",
  "text-[12px] font-650 hover:bg-[#eef3fb]",
].join(" ");
const shellMenuDefaultItemClassName = "bg-[#eef3fb]";
const shellMenuItemLabelClassName =
  "grid w-full min-w-0 grid-cols-[minmax(0,1fr)_auto] items-center gap-[8px] text-left";
const shellMenuShellNameClassName =
  "block min-w-0 overflow-hidden text-ellipsis whitespace-nowrap text-left";
const shellMenuDefaultBadgeClassName = [
  "rounded-[999px] bg-white px-[6px] py-[1px]",
  "text-[10px] font-700 text-[#475467]",
].join(" ");
const shellMenuCommandClassName = [
  "block w-full min-w-0 overflow-hidden text-left",
  "text-ellipsis whitespace-nowrap text-[#667085]",
].join(" ");

interface ShellMenuPosition {
  left: number;
  top: number;
  maxHeight: number;
}

interface ToolMenuProps {
  activeTool: WorkbenchTool;
  terminalShells: AvailableShellInfo[];
  onOpenTerminalShell: (shell?: AvailableShellInfo) => void;
  onSelect: (tool: WorkbenchTool) => void;
}

export function ToolMenu(
  { activeTool, terminalShells, onOpenTerminalShell, onSelect }: ToolMenuProps,
) {
  const [shellMenuOpen, setShellMenuOpen] = useState(false);
  const [shellMenuPosition, setShellMenuPosition] = useState<
    ShellMenuPosition | undefined
  >(undefined);
  const shellMenuRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!shellMenuOpen) return;

    function closeShellMenuOnPointer(event: MouseEvent) {
      const target = event.target;
      if (target instanceof Node && shellMenuRef.current?.contains(target)) {
        return;
      }
      closeShellMenu();
    }

    function closeShellMenuOnEscape(event: KeyboardEvent) {
      if (event.key === "Escape") closeShellMenu();
    }

    function closeShellMenuOnScroll(event: Event) {
      const target = event.target;
      if (target instanceof Node && shellMenuRef.current?.contains(target)) {
        return;
      }
      closeShellMenu();
    }

    globalThis.addEventListener("mousedown", closeShellMenuOnPointer);
    globalThis.addEventListener("keydown", closeShellMenuOnEscape);
    globalThis.addEventListener("resize", closeShellMenu);
    globalThis.addEventListener("scroll", closeShellMenuOnScroll, true);
    return () => {
      globalThis.removeEventListener("mousedown", closeShellMenuOnPointer);
      globalThis.removeEventListener("keydown", closeShellMenuOnEscape);
      globalThis.removeEventListener("resize", closeShellMenu);
      globalThis.removeEventListener("scroll", closeShellMenuOnScroll, true);
    };
  }, [shellMenuOpen]);

  function closeShellMenu() {
    setShellMenuOpen(false);
    setShellMenuPosition(undefined);
  }

  function toggleShellMenu(event: ReactMouseEvent<HTMLButtonElement>) {
    if (shellMenuOpen) {
      closeShellMenu();
      return;
    }
    setShellMenuPosition(
      shellMenuPositionFromRect(
        event.currentTarget.getBoundingClientRect(),
        terminalShells.length,
      ),
    );
    setShellMenuOpen(true);
  }

  function openShellTerminal(shell: AvailableShellInfo) {
    closeShellMenu();
    onOpenTerminalShell(shell);
  }

  function openDefaultTerminal() {
    closeShellMenu();
    onOpenTerminalShell();
  }

  return (
    <nav className={toolMenuClassName} aria-label="Workspace tools">
      {tools.map(({ id, label, disabled, Icon }) =>
        id === "terminal"
          ? (
            <div
              key={id}
              className={toolItemRowClassName}
              ref={shellMenuRef}
            >
              <button
                type="button"
                className={className(
                  terminalMainButtonClassName,
                  activeTool === id && "active",
                )}
                onClick={() => {
                  openDefaultTerminal();
                }}
                disabled={disabled}
                aria-current={activeTool === id ? "page" : undefined}
              >
                <Icon size={17} />
                <span>{label}</span>
              </button>
              <button
                type="button"
                className={className(
                  terminalDropdownButtonClassName,
                  (activeTool === id || shellMenuOpen) && "active",
                )}
                onClick={toggleShellMenu}
                disabled={disabled}
                aria-label="Open terminal shell menu"
                aria-haspopup="menu"
                aria-expanded={shellMenuOpen}
                title="Open terminal shell"
              >
                <ChevronDown size={14} />
              </button>
              {shellMenuOpen
                ? (
                  <div
                    className={shellMenuClassName}
                    role="menu"
                    style={shellMenuPosition}
                  >
                    {terminalShells.map((shell) => (
                      <button
                        type="button"
                        key={shell.shellId}
                        role="menuitem"
                        className={className(
                          shellMenuItemClassName,
                          shell.isDefault && shellMenuDefaultItemClassName,
                        )}
                        onClick={() => openShellTerminal(shell)}
                      >
                        <span className={shellMenuItemLabelClassName}>
                          <span className={shellMenuShellNameClassName}>
                            {shell.name}
                          </span>
                          {shell.isDefault
                            ? (
                              <span className={shellMenuDefaultBadgeClassName}>
                                Default
                              </span>
                            )
                            : null}
                        </span>
                        <small className={shellMenuCommandClassName}>
                          {commandName(shell.command)}
                        </small>
                      </button>
                    ))}
                  </div>
                )
                : null}
            </div>
          )
          : (
            <button
              type="button"
              key={id}
              className={className(
                toolItemClassName,
                activeTool === id && "active",
              )}
              onClick={() => onSelect(id)}
              disabled={disabled}
              aria-current={activeTool === id ? "page" : undefined}
            >
              <Icon size={17} />
              <span>{label}</span>
            </button>
          )
      )}
    </nav>
  );
}

function shellMenuPositionFromRect(
  rect: DOMRect,
  shellCount: number,
): ShellMenuPosition {
  const estimatedHeight = Math.min(
    SHELL_MENU_MAX_HEIGHT,
    shellCount * 36 + 10,
  );
  const left = Math.max(
    SHELL_MENU_EDGE_GAP,
    Math.min(
      rect.right - SHELL_MENU_WIDTH,
      globalThis.innerWidth - SHELL_MENU_WIDTH - SHELL_MENU_EDGE_GAP,
    ),
  );
  const belowMaxHeight = globalThis.innerHeight - rect.bottom -
    SHELL_MENU_TRIGGER_GAP - SHELL_MENU_EDGE_GAP;
  const aboveMaxHeight = rect.top - SHELL_MENU_TRIGGER_GAP -
    SHELL_MENU_EDGE_GAP;
  const openAbove = belowMaxHeight < 160 && aboveMaxHeight > belowMaxHeight;
  const maxHeight = Math.max(
    120,
    Math.min(
      estimatedHeight,
      openAbove ? aboveMaxHeight : belowMaxHeight,
    ),
  );
  const top = openAbove
    ? Math.max(
      SHELL_MENU_EDGE_GAP,
      rect.top - SHELL_MENU_TRIGGER_GAP - maxHeight,
    )
    : rect.bottom + SHELL_MENU_TRIGGER_GAP;
  return { left, top, maxHeight };
}

function commandName(command: string): string {
  const normalized = command.replaceAll("\\", "/");
  const segments = normalized.split("/").filter(Boolean);
  return segments[segments.length - 1] ?? command;
}
