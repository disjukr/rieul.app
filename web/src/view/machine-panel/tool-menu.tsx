import {
  type MouseEvent as ReactMouseEvent,
  useEffect,
  useRef,
  useState,
} from "react";
import {
  Activity,
  ChevronDown,
  Folder,
  HardDrive,
  Home,
  Info,
  Terminal,
  Trash2,
} from "lucide-react";
import type { AvailableShellInfo } from "../../protocol/generated/rpc.ts";
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
  },
];

const SHELL_MENU_WIDTH = 260;
const SHELL_MENU_MAX_HEIGHT = 360;
const SHELL_MENU_TRIGGER_GAP = 0;
const FILES_MENU_WIDTH = 176;

const toolMenuClassName =
  "grid content-start gap-0 min-h-0 overflow-visible px-[0.5rem] py-[1rem]";
const toolItemFrameClassName = "h-[48px] box-border py-[2px]";
const toolItemRowClassName = [
  "relative grid h-[48px] box-border py-[2px]",
  "[grid-template-columns:minmax(0,1fr)_36px]",
].join(" ");
const toolItemClassName = [
  "inline-flex appearance-none items-center justify-start gap-[0.5rem]",
  "w-full h-full min-h-0 border-0 rounded-[0.5rem]",
  "cursor-pointer bg-transparent px-[0.5rem] text-left text-[#475467] [font-family:inherit]",
  "hover:bg-[#eef3fb] hover:text-[#20242d]",
  "[&.active]:bg-[#eef3fb] [&.active]:text-[#20242d]",
  "disabled:opacity-56",
  "[&_span]:min-w-0 [&_span]:overflow-hidden [&_span]:text-ellipsis",
  "[&_span]:whitespace-nowrap [&_span]:font-700",
].join(" ");
const terminalMainButtonClassName = [
  toolItemClassName,
  "rounded-r-[0.25rem]",
].join(" ");
const terminalDropdownButtonClassName = [
  "inline-flex appearance-none items-center justify-center",
  "h-full min-h-0 w-[36px] min-w-[36px] p-0 rounded-l-[0.25re,] rounded-r-[0.5rem]",
  "cursor-pointer border-0 bg-transparent text-[#475467] [font-family:inherit]",
  "hover:bg-[#eef3fb] hover:text-[#20242d]",
  "[&.active]:bg-[#eef3fb] [&.active]:text-[#20242d]",
].join(" ");
const shellMenuItemClassName = [
  "!grid min-w-0 grid-cols-[minmax(0,1fr)_auto] !gap-[0.5rem]",
].join(" ");
const shellMenuDefaultItemClassName = "bg-[#eef3fb]";
const shellMenuItemLabelClassName =
  "flex min-w-0 items-center gap-[0.5rem] text-left";
const shellMenuShellNameClassName =
  "block min-w-0 overflow-hidden text-ellipsis whitespace-nowrap text-left";
const shellMenuDefaultBadgeClassName = [
  "rounded-[999px] bg-white px-[6px] py-[1px]",
  "text-[10px] font-700 text-[#475467]",
].join(" ");
const shellMenuCommandClassName = [
  "block max-w-[88px] min-w-0 overflow-hidden text-right",
  "text-ellipsis whitespace-nowrap text-[#667085]",
].join(" ");

interface ToolMenuProps {
  activeTool: WorkbenchTool;
  terminalShells: AvailableShellInfo[];
  onOpenFilesView: (filesView: WorkbenchFilesView) => void;
  onOpenTerminalShell: (shell?: AvailableShellInfo) => void;
  onSelect: (tool: WorkbenchTool) => void;
}

export function ToolMenu(
  {
    activeTool,
    terminalShells,
    onOpenFilesView,
    onOpenTerminalShell,
    onSelect,
  }: ToolMenuProps,
) {
  const hasTerminalShells = terminalShells.length > 0;
  const [filesMenuOpen, setFilesMenuOpen] = useState(false);
  const [filesMenuPosition, setFilesMenuPosition] = useState<
    FloatingMenuPosition | undefined
  >(undefined);
  const [shellMenuOpen, setShellMenuOpen] = useState(false);
  const [shellMenuPosition, setShellMenuPosition] = useState<
    FloatingMenuPosition | undefined
  >(undefined);
  const filesMenuRef = useRef<HTMLDivElement>(null);
  const shellMenuRef = useRef<HTMLDivElement>(null);
  useFloatingMenuDismiss(filesMenuOpen, filesMenuRef, closeFilesMenu, {
    closeOnScroll: true,
  });
  useFloatingMenuDismiss(shellMenuOpen, shellMenuRef, closeShellMenu, {
    closeOnScroll: true,
  });

  useEffect(() => {
    if (!hasTerminalShells) closeShellMenu();
  }, [hasTerminalShells]);

  function closeShellMenu() {
    setShellMenuOpen(false);
    setShellMenuPosition(undefined);
  }

  function closeFilesMenu() {
    setFilesMenuOpen(false);
    setFilesMenuPosition(undefined);
  }

  function toggleFilesMenu(event: ReactMouseEvent<HTMLButtonElement>) {
    if (filesMenuOpen) {
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

  function toggleShellMenu(event: ReactMouseEvent<HTMLButtonElement>) {
    if (!hasTerminalShells) return;
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

  function openFilesView(filesView: WorkbenchFilesView) {
    closeFilesMenu();
    onOpenFilesView(filesView);
  }

  return (
    <nav className={toolMenuClassName} aria-label="Workspace tools">
      {tools.map(({ id, label, disabled, Icon }) =>
        id === "files"
          ? (
            <div
              key={id}
              className={toolItemRowClassName}
              ref={filesMenuRef}
            >
              <button
                type="button"
                className={className(
                  terminalMainButtonClassName,
                  activeTool === id && "active",
                )}
                onClick={() => openFilesView("home")}
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
                  (activeTool === id || filesMenuOpen) && "active",
                )}
                onClick={toggleFilesMenu}
                disabled={disabled}
                aria-label="Open files view menu"
                aria-haspopup="menu"
                aria-expanded={filesMenuOpen}
                title="Open files view"
              >
                <ChevronDown size={14} />
              </button>
              {filesMenuOpen
                ? (
                  <FloatingMenu
                    className="z-[80] w-[176px]"
                    position={filesMenuPosition}
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
                )
                : null}
            </div>
          )
          : id === "terminal"
          ? (
            <div
              key={id}
              className={hasTerminalShells
                ? toolItemRowClassName
                : toolItemFrameClassName}
              ref={shellMenuRef}
            >
              <button
                type="button"
                className={className(
                  hasTerminalShells
                    ? terminalMainButtonClassName
                    : toolItemClassName,
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
              {hasTerminalShells
                ? (
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
                )
                : null}
              {hasTerminalShells && shellMenuOpen
                ? (
                  <FloatingMenu
                    className="z-[80] w-[260px] overflow-x-hidden overflow-y-auto"
                    position={shellMenuPosition}
                  >
                    {terminalShells.map((shell) => (
                      <FloatingMenuItem
                        key={shell.shellId}
                        className={className(
                          shellMenuItemClassName,
                          shell.isDefault && shellMenuDefaultItemClassName,
                        )}
                        onClick={() => openShellTerminal(shell)}
                        title={`${shell.name} (${commandName(shell.command)})`}
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
                      </FloatingMenuItem>
                    ))}
                  </FloatingMenu>
                )
                : null}
            </div>
          )
          : (
            <div key={id} className={toolItemFrameClassName}>
              <button
                type="button"
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
            </div>
          )
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
