import {
  Activity,
  AppWindow,
  CheckCircle2,
  ChevronDown,
  Folder,
  Monitor,
  MoreVertical,
  PanelLeftClose,
  PanelLeftOpen,
  Plus,
  Radio,
  RefreshCw,
  Settings,
  Terminal,
  Trash2,
  Unlink,
} from "lucide-react";
import {
  type KeyboardEvent,
  type MouseEvent,
  type RefObject,
  useCallback,
  useEffect,
  useRef,
  useState,
} from "react";
import type { AvailableShellInfo } from "../../protocol/generated/rpc.ts";
import type { Machine } from "../../state/machines.ts";
import type { DaemonInfoState } from "../../state/rpc-session.ts";
import type { ConnectionState } from "../../state/types.ts";
import type {
  WorkbenchFilesTabConfig,
  WorkbenchPane,
  WorkbenchTab,
  WorkbenchTerminalTabConfig,
  WorkbenchTool,
} from "../../state/workbench.ts";
import { className } from "../class-name.ts";
import {
  clampFloatingMenuPosition,
  FloatingMenu,
  FloatingMenuItem,
  type FloatingMenuPosition,
  useFloatingMenuDismiss,
} from "../ui/floating-menu.tsx";

const projectLogoUrl = new URL("../../assets/wgo.svg", import.meta.url).href;

const globalTopbarClassName = [
  "[grid-column:1] [grid-row:1] flex flex-col",
  "h-full min-h-0 min-w-0 overflow-visible",
  "box-border border-r wgo-material-chrome",
  "gap-[10px] px-[10px] py-[12px] leading-[1.45] text-wgo-text-2",
  "max-[680px]:[grid-row:2] max-[680px]:m-[8px]",
  "max-[680px]:h-[60px] max-[680px]:min-h-0 max-[680px]:flex-row",
  "max-[680px]:items-center max-[680px]:justify-between max-[680px]:gap-[8px]",
  "max-[680px]:rounded-[18px] max-[680px]:border max-[680px]:border-white/56",
  "max-[680px]:bg-[rgba(248,248,248,0.82)] max-[680px]:px-[8px] max-[680px]:py-[6px]",
  "max-[680px]:shadow-[0_12px_32px_rgba(18,25,38,0.18),inset_0_1px_0_rgba(255,255,255,0.82)]",
  "max-[680px]:backdrop-blur-2xl",
].join(" ");
const globalTopbarLeftClassName = [
  "grid gap-[8px] min-w-0",
  "max-[680px]:flex max-[680px]:min-w-0 max-[680px]:flex-[0_1_132px]",
].join(" ");
const globalTopbarCenterClassName = "min-w-0 pointer-events-none hidden";
const globalTopbarRightClassName =
  "grid min-w-0 content-start gap-[10px] max-[680px]:flex-1";
const topbarBrandClassName = [
  "inline-flex h-[34px] min-w-0 items-center gap-[8px] rounded-[11px] px-[4px]",
  "text-[13px] font-780 text-wgo-text",
  "[&_img]:h-[23px] [&_img]:w-[23px] [&_img]:rounded-[7px]",
  "[&_img]:shadow-[0_1px_2px_rgba(18,25,38,0.1)]",
  "[&_span]:leading-none",
  "max-[680px]:hidden",
].join(" ");
const topbarLeftDividerClassName =
  "h-px w-full bg-[rgba(18,25,38,0.1)] shadow-[0_1px_0_rgba(255,255,255,0.48)] max-[680px]:hidden";
const globalIconButtonClassName = [
  "inline-flex appearance-none items-center justify-center w-[28px] min-w-[28px] h-[28px] min-h-[28px]",
  "box-border cursor-pointer border border-transparent rounded-wgo-md bg-transparent text-wgo-text-3 p-0 leading-none",
  "[font-family:inherit]",
  "opacity-72 hover:opacity-100 hover:border-white/44 hover:bg-white/36 hover:text-wgo-text-2",
  "active:bg-wgo-active",
  "max-[680px]:hidden",
].join(" ");
const globalMachineTitleClassName = [
  "flex h-[32px] items-center gap-[3px] min-w-0 rounded-[10px]",
  "border border-white/46 bg-[rgba(255,255,255,0.42)] px-[7px] text-wgo-text",
  "shadow-[inset_0_1px_0_rgba(255,255,255,0.74),0_8px_20px_rgba(18,25,38,0.07)]",
  "font-700 text-[13px]",
  "[&_span]:min-w-0 [&_span]:overflow-hidden [&_span]:leading-[1.45]",
  "[&_span]:text-ellipsis [&_span]:whitespace-nowrap",
  "max-[680px]:h-[44px] max-[680px]:max-w-[132px] max-[680px]:rounded-[14px]",
  "max-[680px]:px-[8px] max-[680px]:text-[12px]",
].join(" ");
const toolSwitcherClassName = [
  "rail-tool-switcher grid w-full min-w-0 content-start gap-[2px] rounded-[14px]",
  "border border-white/34 bg-[rgba(248,248,248,0.28)] p-[3px] backdrop-blur-2xl",
  "shadow-[inset_0_1px_0_rgba(255,255,255,0.68),0_8px_18px_rgba(18,25,38,0.045)]",
  "max-[680px]:flex max-[680px]:h-[44px] max-[680px]:items-center max-[680px]:justify-center",
  "max-[680px]:gap-[4px] max-[680px]:border-0 max-[680px]:bg-transparent",
  "max-[680px]:p-0 max-[680px]:shadow-none",
].join(" ");
const toolSplitClassName = [
  "inline-flex h-[27px] w-full min-w-0 items-center gap-[2px] rounded-[10px] px-[2px]",
  "border border-transparent text-[12px] font-650 text-wgo-text-3/68",
  "wgo-transition",
  "hover:bg-white/20 hover:text-wgo-text-2",
  "[&.active]:border-white/74 [&.active]:bg-[rgba(255,255,255,0.72)] [&.active]:text-wgo-text",
  "[&.active]:shadow-[0_6px_14px_rgba(20,30,46,0.095),inset_0_1px_0_rgba(255,255,255,0.86),inset_0_-1px_0_rgba(32,48,70,0.035)]",
  "max-[680px]:h-[44px] max-[680px]:flex-[1_1_0] max-[680px]:justify-center",
  "max-[680px]:rounded-[14px] max-[680px]:px-0",
].join(" ");
const toolNameButtonClassName = [
  "inline-flex h-[23px] min-w-0 flex-1 appearance-none items-center justify-start gap-[6px]",
  "rounded-[8px] border-0 bg-transparent px-[7px] py-0 text-inherit [font-family:inherit]",
  "cursor-pointer wgo-transition",
  "hover:bg-white/18 hover:text-wgo-text",
  "[&_svg]:flex-[0_0_auto] [&_svg]:opacity-86 [&_span]:min-w-0 [&_span]:overflow-hidden [&_span]:text-ellipsis [&_span]:whitespace-nowrap",
  "max-[680px]:h-full max-[680px]:justify-center max-[680px]:gap-0 max-[680px]:px-0",
].join(" ");
const toolNameLabelClassName = "max-[680px]:hidden";
const toolPlusButtonClassName = [
  "inline-flex h-[23px] w-[22px] min-w-[22px] appearance-none items-center justify-center",
  "rounded-[8px] border-0 bg-transparent p-0 text-inherit [font-family:inherit]",
  "cursor-pointer opacity-52 wgo-transition hover:bg-white/30 hover:text-wgo-text hover:opacity-100",
  "[.active_&]:opacity-62",
  "max-[680px]:hidden",
].join(" ");
const machineChromeButtonClassName = [
  "inline-flex h-[24px] min-w-[24px] appearance-none items-center justify-center",
  "rounded-wgo-sm border border-transparent bg-transparent p-0 text-wgo-text-3",
  "[font-family:inherit] cursor-pointer wgo-transition",
  "hover:border-white/50 hover:bg-white/42 hover:text-wgo-text",
].join(" ");
const machineActionsButtonClassName = [
  machineChromeButtonClassName,
  "w-[24px]",
].join(" ");
const topbarMenuClassName = [
  "z-[60] w-[244px] gap-[2px] rounded-wgo-lg p-[4px]",
  "wgo-material-floating text-wgo-text",
].join(" ");
const topbarMenuHeaderClassName = [
  "px-[8px] py-[6px] text-[11px] font-740 text-wgo-text-3",
].join(" ");
const topbarMenuMetaClassName =
  "ml-auto min-w-0 max-w-[92px] overflow-hidden text-ellipsis whitespace-nowrap text-[12px] text-wgo-text-3";
const machineMenuClassName = [
  "z-[60] w-[216px] gap-[3px] rounded-wgo-lg p-[5px]",
  "wgo-material-floating text-wgo-text",
].join(" ");
const machineMenuHeaderClassName =
  "px-[8px] pb-[5px] pt-[6px] text-[11px] font-760 tracking-[0] text-wgo-text-3";
const machineMenuDividerClassName =
  "mx-[5px] my-[5px] h-px bg-[rgba(18,25,38,0.12)] shadow-[0_1px_0_rgba(255,255,255,0.64)]";
const machineMenuDangerItemClassName = [
  "text-wgo-danger hover:bg-wgo-danger-soft hover:text-wgo-danger",
  "[&_svg]:text-wgo-danger",
].join(" ");
const connectionButtonClassName = [
  "inline-flex h-[24px] items-center gap-[3px] rounded-wgo-sm",
  "border border-transparent bg-transparent px-[4px] text-wgo-text-3",
  "backdrop-blur-xl [font-family:inherit] cursor-pointer",
  "hover:border-white/50 hover:bg-white/42 hover:text-wgo-text",
  "focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-wgo-focus",
].join(" ");
const statusDotClassName = "h-[6px] w-[6px] rounded-full";
const connectionPopoverClassName = [
  "z-[60] w-[320px] gap-0 rounded-wgo-xl p-0",
  "wgo-material-floating text-wgo-text",
].join(" ");
const popoverHeaderClassName = [
  "grid gap-[8px] border-b border-b-black/6 px-[12px] py-[11px]",
].join(" ");
const popoverTitleClassName =
  "flex min-w-0 items-center gap-[8px] text-[13px] font-760";
const popoverMetaClassName =
  "min-w-0 overflow-hidden text-ellipsis whitespace-nowrap text-[12px] font-650 text-wgo-text-3";
const popoverRowClassName = [
  "grid min-h-[32px] grid-cols-[92px_minmax(0,1fr)] items-center gap-[10px]",
  "border-b border-b-black/5 px-[12px] text-[12px] last:border-b-0",
].join(" ");
const popoverLabelClassName = "font-650 text-wgo-text-3";
const popoverValueClassName =
  "min-w-0 overflow-hidden text-right text-ellipsis whitespace-nowrap font-720 text-wgo-text-2";
const railBrandRowClassName =
  "flex min-w-0 items-center justify-between gap-[6px] max-[680px]:hidden";
const railMachineListClassName = [
  "grid min-w-0 gap-[4px] rounded-[13px] border border-white/28",
  "bg-[rgba(248,248,248,0.28)] p-[4px] backdrop-blur-xl",
  "max-[680px]:hidden",
].join(" ");
const railMachineButtonClassName = [
  "inline-flex h-[30px] min-w-0 appearance-none items-center gap-[7px]",
  "rounded-[9px] border border-transparent bg-transparent px-[7px]",
  "text-[12px] font-650 text-wgo-text-3 [font-family:inherit]",
  "cursor-pointer wgo-transition hover:border-white/48 hover:bg-white/34 hover:text-wgo-text-2",
  "[&.active]:border-white/74 [&.active]:bg-white/70 [&.active]:text-wgo-text",
  "[&.active]:shadow-[inset_0_1px_0_rgba(255,255,255,0.86),0_6px_16px_rgba(18,25,38,0.08)]",
  "[&_span]:min-w-0 [&_span]:overflow-hidden [&_span]:text-ellipsis [&_span]:whitespace-nowrap",
].join(" ");
const railAddMachineButtonClassName = [
  "mt-auto inline-flex h-[30px] w-full appearance-none items-center justify-center gap-[6px]",
  "rounded-[9px] border border-white/22 bg-white/14 px-[8px]",
  "text-[12px] font-650 text-wgo-text-3 [font-family:inherit]",
  "cursor-pointer wgo-transition hover:border-white/48 hover:bg-white/34 hover:text-wgo-text",
  "max-[680px]:mt-0 max-[680px]:h-[44px] max-[680px]:w-[44px] max-[680px]:min-w-[44px]",
  "max-[680px]:rounded-[14px] max-[680px]:px-0 max-[680px]:text-wgo-text-2",
  "max-[680px]:[&_span]:hidden",
].join(" ");

const topbarTools: {
  icon: typeof Folder;
  label: string;
  tool: WorkbenchTool;
}[] = [
  { icon: Radio, label: "Daemon", tool: "daemon" },
  { icon: Folder, label: "Files", tool: "files" },
  { icon: Terminal, label: "Terminal", tool: "terminal" },
  { icon: AppWindow, label: "Windows", tool: "windows" },
  { icon: Activity, label: "Processes", tool: "processes" },
];

interface AppTopbarProps {
  activeTool: WorkbenchTool;
  connection?: ConnectionState;
  daemonInfo: DaemonInfoState;
  machine?: Machine;
  machinePanelCollapsed: boolean;
  machines: Machine[];
  panes: WorkbenchPane[];
  selectedMachineId?: string;
  terminalShells: AvailableShellInfo[];
  onAddMachine: () => void;
  onOpenDaemonTab: () => void;
  onOpenFilesTab: (config?: WorkbenchFilesTabConfig) => void;
  onOpenProcessesTab: () => void;
  onOpenTerminalTab: (config?: WorkbenchTerminalTabConfig) => void;
  onOpenWindowsTab: () => void;
  onSelectTab: (paneId: string, tabId: string) => void;
  onConfigureMachine: () => void;
  onDeleteMachine: () => void;
  onReconnectMachine: () => void;
  onSelectMachine: (machineId: string) => void;
  onToggleMachinePanel: () => void;
  onUnpairMachine: () => void;
}

type ToolMenuKind = "tabs" | "create";

interface ToolMenuState {
  kind: ToolMenuKind;
  position: FloatingMenuPosition;
  tool: WorkbenchTool;
}

interface MachineMenuState {
  kind: "connection" | "actions";
  position: FloatingMenuPosition;
}

export function AppTopbar(
  {
    activeTool,
    connection,
    daemonInfo,
    machine,
    machinePanelCollapsed,
    machines,
    panes,
    selectedMachineId,
    terminalShells,
    onAddMachine,
    onOpenDaemonTab,
    onOpenFilesTab,
    onOpenProcessesTab,
    onOpenTerminalTab,
    onOpenWindowsTab,
    onSelectTab,
    onConfigureMachine,
    onDeleteMachine,
    onReconnectMachine,
    onSelectMachine,
    onToggleMachinePanel,
    onUnpairMachine,
  }: AppTopbarProps,
) {
  const toolMenuRef = useRef<HTMLDivElement | null>(null);
  const machineMenuRef = useRef<HTMLDivElement | null>(null);
  const toolMenuHoverTimerRef = useRef<number | undefined>(undefined);
  const [toolMenu, setToolMenu] = useState<ToolMenuState | undefined>();
  const [machineMenu, setMachineMenu] = useState<
    MachineMenuState | undefined
  >();
  const defaultTerminalShell =
    terminalShells.find((shell) => shell.isDefault) ?? terminalShells[0];
  const openToolTab: Record<WorkbenchTool, () => void> = {
    daemon: onOpenDaemonTab,
    files: onOpenFilesTab,
    processes: onOpenProcessesTab,
    terminal: openDefaultTerminal,
    windows: onOpenWindowsTab,
  };
  const closeToolMenu = useCallback(() => {
    setToolMenu(undefined);
  }, []);
  useFloatingMenuDismiss(
    toolMenu !== undefined,
    toolMenuRef,
    closeToolMenu,
    { closeOnScroll: true },
  );
  const closeMachineMenu = useCallback(() => {
    setMachineMenu(undefined);
  }, []);
  useFloatingMenuDismiss(
    machineMenu !== undefined,
    machineMenuRef,
    closeMachineMenu,
    { closeOnScroll: true },
  );
  useEffect(() => {
    return () => {
      clearPendingToolMenu();
    };
  }, []);

  const tabTargets = tabTargetsForPanes(panes);

  function clearPendingToolMenu() {
    if (toolMenuHoverTimerRef.current === undefined) return;
    globalThis.clearTimeout(toolMenuHoverTimerRef.current);
    toolMenuHoverTimerRef.current = undefined;
  }

  function openToolMenu(
    tool: WorkbenchTool,
    kind: ToolMenuKind,
    target: HTMLElement,
  ) {
    clearPendingToolMenu();
    const rect = target.getBoundingClientRect();
    setMachineMenu(undefined);
    setToolMenu({
      kind,
      tool,
      position: clampFloatingMenuPosition(
        rect.right + 8,
        rect.top,
        { itemCount: kind === "tabs" ? 5 : 4, width: 244 },
      ),
    });
  }

  function scheduleToolMenu(
    tool: WorkbenchTool,
    kind: ToolMenuKind,
    target: HTMLElement,
  ) {
    clearPendingToolMenu();
    toolMenuHoverTimerRef.current = globalThis.setTimeout(() => {
      toolMenuHoverTimerRef.current = undefined;
      openToolMenu(tool, kind, target);
    }, 170);
  }

  function openMachineMenu(
    kind: "connection" | "actions",
    target: HTMLElement,
  ) {
    const rect = target.getBoundingClientRect();
    const width = kind === "connection" ? 320 : 216;
    setToolMenu(undefined);
    setMachineMenu({
      kind,
      position: clampFloatingMenuPosition(
        rect.right + 8,
        rect.top,
        { itemCount: kind === "connection" ? 7 : 6, width },
      ),
    });
  }

  function selectLatestToolTab(tool: WorkbenchTool) {
    const latest = latestTabTarget(tabTargets, tool);
    if (!latest) {
      openToolTab[tool]();
      return;
    }
    onSelectTab(latest.paneId, latest.tab.id);
  }

  function runMachineAction(action: () => void) {
    closeMachineMenu();
    action();
  }

  function terminalTabConfigForShell(
    shell: AvailableShellInfo,
  ): WorkbenchTerminalTabConfig {
    return {
      launch: {
        args: shell.args,
        command: shell.command,
      },
      title: shell.name,
    };
  }

  function openDefaultTerminal() {
    const shell = defaultTerminalShell;
    closeToolMenu();
    if (!shell) {
      onOpenTerminalTab();
      return;
    }
    onOpenTerminalTab(terminalTabConfigForShell(shell));
  }

  function openTerminalForShell(shell: AvailableShellInfo) {
    closeToolMenu();
    onOpenTerminalTab(terminalTabConfigForShell(shell));
  }

  function openConnectionMenu(target: HTMLElement) {
    if (machineMenu?.kind === "connection") {
      closeMachineMenu();
      return;
    }
    openMachineMenu("connection", target);
  }

  function openActionsMenu(target: HTMLElement) {
    if (machineMenu?.kind === "actions") {
      closeMachineMenu();
      return;
    }
    openMachineMenu("actions", target);
  }

  function openToolTabFromMenu(tool: WorkbenchTool) {
    closeToolMenu();
    openToolTab[tool]();
  }

  function openFilesOption(filesView: "roots" | "home" | "trash") {
    closeToolMenu();
    onOpenFilesTab({ filesView });
  }

  function toolTabTargets(tool: WorkbenchTool) {
    return tabTargets.filter((target) => target.tab.tool === tool);
  }

  function toolMenuTitle(tool: WorkbenchTool) {
    return topbarTools.find((item) => item.tool === tool)?.label ?? tool;
  }

  function showToolMenuOnFocus(
    tool: WorkbenchTool,
    kind: ToolMenuKind,
    target: HTMLElement,
  ) {
    openToolMenu(tool, kind, target);
  }

  function onToolNameKeyDown(
    event: KeyboardEvent<HTMLButtonElement>,
    tool: WorkbenchTool,
  ) {
    if (event.key === "ArrowDown") {
      event.preventDefault();
      openToolMenu(tool, "tabs", event.currentTarget);
    }
  }

  function onToolPlusKeyDown(
    event: KeyboardEvent<HTMLButtonElement>,
    tool: WorkbenchTool,
  ) {
    if (event.key === "ArrowDown") {
      event.preventDefault();
      openToolMenu(tool, "create", event.currentTarget);
    }
  }

  function deviceName() {
    return machine?.name ?? "No machine";
  }

  function isPaired() {
    return Boolean(machine?.clientId && machine?.clientSecret);
  }

  function connectionIcon() {
    return (
      <span
        className={className(
          statusDotClassName,
          connection?.phase === "reachable"
            ? "bg-wgo-success"
            : connection?.phase === "idle"
            ? "bg-wgo-warning"
            : "bg-wgo-danger",
        )}
      />
    );
  }

  function openMachineContextMenu(
    event: MouseEvent<HTMLButtonElement>,
    kind: "connection" | "actions",
  ) {
    event.preventDefault();
    if (kind === "connection") openConnectionMenu(event.currentTarget);
    else openActionsMenu(event.currentTarget);
  }

  function onMachineKeyDown(
    event: KeyboardEvent<HTMLButtonElement>,
    kind: "connection" | "actions",
  ) {
    if (event.key !== "ArrowDown") return;
    event.preventDefault();
    if (kind === "connection") openConnectionMenu(event.currentTarget);
    else openActionsMenu(event.currentTarget);
  }

  function connectionPopoverPosition() {
    return machineMenu?.kind === "connection"
      ? machineMenu.position
      : undefined;
  }

  function actionsPopoverPosition() {
    return machineMenu?.kind === "actions" ? machineMenu.position : undefined;
  }

  function selectTarget(target: ToolTabTarget) {
    closeToolMenu();
    onSelectTab(target.paneId, target.tab.id);
  }

  function renderToolMenu() {
    if (!toolMenu) return null;
    if (toolMenu.kind === "tabs") {
      const targets = toolTabTargets(toolMenu.tool);
      return (
        <FloatingMenu
          className={topbarMenuClassName}
          menuRef={toolMenuRef}
          position={toolMenu.position}
        >
          <div className={topbarMenuHeaderClassName}>
            {toolMenuTitle(toolMenu.tool)} Tabs
          </div>
          {targets.length === 0
            ? (
              <FloatingMenuItem
                onClick={() => openToolTabFromMenu(toolMenu.tool)}
              >
                <Plus size={14} />
                New {toolMenuTitle(toolMenu.tool)} Tab
              </FloatingMenuItem>
            )
            : targets.map((target) => (
              <FloatingMenuItem
                key={`${target.paneId}:${target.tab.id}`}
                onClick={() => selectTarget(target)}
              >
                <ToolIcon tool={target.tab.tool} size={14} />
                <span>{tabLabel(target.tab)}</span>
                <span className={topbarMenuMetaClassName}>
                  {target.paneLabel}
                </span>
              </FloatingMenuItem>
            ))}
        </FloatingMenu>
      );
    }

    return (
      <FloatingMenu
        className={topbarMenuClassName}
        menuRef={toolMenuRef}
        position={toolMenu.position}
      >
        <div className={topbarMenuHeaderClassName}>
          New {toolMenuTitle(toolMenu.tool)}
        </div>
        {toolMenu.tool === "files"
          ? (
            <>
              <FloatingMenuItem onClick={() => openFilesOption("roots")}>
                <Folder size={14} />
                Root
              </FloatingMenuItem>
              <FloatingMenuItem onClick={() => openFilesOption("home")}>
                <Folder size={14} />
                Home
              </FloatingMenuItem>
              <FloatingMenuItem onClick={() => openFilesOption("trash")}>
                <Trash2 size={14} />
                Trash
              </FloatingMenuItem>
            </>
          )
          : toolMenu.tool === "terminal"
          ? (
            terminalShells.length === 0
              ? (
                <FloatingMenuItem
                  disabled
                >
                  <Terminal size={14} />
                  No shells available
                </FloatingMenuItem>
              )
              : terminalShells.map((shell) => (
                <FloatingMenuItem
                  key={shell.shellId}
                  onClick={() => openTerminalForShell(shell)}
                >
                  <Terminal size={14} />
                  <span>{shell.name}</span>
                  {shell.isDefault
                    ? <span className={topbarMenuMetaClassName}>Default</span>
                    : null}
                </FloatingMenuItem>
              ))
          )
          : (
            <FloatingMenuItem
              onClick={() => openToolTabFromMenu(toolMenu.tool)}
            >
              <ToolIcon tool={toolMenu.tool} size={14} />
              New {toolMenuTitle(toolMenu.tool)} Tab
            </FloatingMenuItem>
          )}
      </FloatingMenu>
    );
  }

  function renderMachineActionsMenu() {
    const position = actionsPopoverPosition();
    if (!position) return null;
    return (
      <FloatingMenu
        className={machineMenuClassName}
        menuRef={machineMenuRef}
        position={position}
      >
        <div className={machineMenuHeaderClassName}>
          {deviceName()}
        </div>
        <FloatingMenuItem onClick={() => runMachineAction(onReconnectMachine)}>
          <RefreshCw size={15} />
          Reconnect
        </FloatingMenuItem>
        <FloatingMenuItem onClick={() => runMachineAction(onConfigureMachine)}>
          <Settings size={15} />
          Configure
        </FloatingMenuItem>
        <div className={machineMenuDividerClassName} aria-hidden="true" />
        <FloatingMenuItem
          disabled={!isPaired()}
          onClick={() => runMachineAction(onUnpairMachine)}
        >
          <Unlink size={15} />
          Unpair
        </FloatingMenuItem>
        <div className={machineMenuDividerClassName} aria-hidden="true" />
        <FloatingMenuItem
          tone="danger"
          className={machineMenuDangerItemClassName}
          onClick={() => runMachineAction(onDeleteMachine)}
        >
          <Trash2 size={15} />
          Delete
        </FloatingMenuItem>
      </FloatingMenu>
    );
  }

  const connectionPosition = connectionPopoverPosition();

  function renderConnectionPopover() {
    if (!connectionPosition) return null;
    return (
      <ConnectionPopover
        connection={connection}
        daemonInfo={daemonInfo}
        machine={machine}
        menuRef={machineMenuRef}
        position={connectionPosition}
      />
    );
  }

  function machineActionDisabled() {
    return !machine;
  }

  function canOpenMachineMenu() {
    return Boolean(machine);
  }

  function renderToolLaunchers() {
    return topbarTools.map(({ icon: Icon, label, tool }) => (
      <div
        key={tool}
        className={className(
          toolSplitClassName,
          activeTool === tool && "active",
        )}
      >
        <button
          type="button"
          className={toolNameButtonClassName}
          aria-haspopup="menu"
          aria-label={`Switch to latest ${label} tab`}
          onClick={() => selectLatestToolTab(tool)}
          onFocus={(event) =>
            showToolMenuOnFocus(tool, "tabs", event.currentTarget)}
          onKeyDown={(event) => onToolNameKeyDown(event, tool)}
          onMouseEnter={(event) =>
            scheduleToolMenu(tool, "tabs", event.currentTarget)}
          onMouseLeave={clearPendingToolMenu}
          title={`Switch to latest ${label} tab`}
        >
          <Icon size={13} />
          <span className={toolNameLabelClassName}>{label}</span>
        </button>
        <button
          type="button"
          className={toolPlusButtonClassName}
          aria-haspopup="menu"
          aria-label={`New ${label} Tab`}
          onClick={() => openToolTabFromMenu(tool)}
          onFocus={(event) =>
            showToolMenuOnFocus(tool, "create", event.currentTarget)}
          onKeyDown={(event) => onToolPlusKeyDown(event, tool)}
          onMouseEnter={(event) =>
            scheduleToolMenu(tool, "create", event.currentTarget)}
          onMouseLeave={clearPendingToolMenu}
          title={`New ${label} Tab`}
        >
          <Plus size={12} strokeWidth={2.3} />
        </button>
      </div>
    ));
  }

  function renderMachineLaunchers() {
    if (machines.length <= 1) return null;
    return (
      <nav className={railMachineListClassName} aria-label="Machines">
        {machines.map((item) => (
          <button
            key={item.id}
            type="button"
            className={className(
              railMachineButtonClassName,
              item.id === selectedMachineId && "active",
            )}
            onClick={() => onSelectMachine(item.id)}
            title={item.name}
            aria-label={item.name}
            aria-current={item.id === selectedMachineId ? "true" : undefined}
          >
            <Monitor size={13} />
            <span>{item.name}</span>
          </button>
        ))}
      </nav>
    );
  }

  function machineTitleControls() {
    return (
      <div className={globalMachineTitleClassName}>
        {connectionIcon()}
        <span>{deviceName()}</span>
        <button
          type="button"
          className={connectionButtonClassName}
          aria-haspopup="dialog"
          aria-expanded={machineMenu?.kind === "connection"}
          disabled={!canOpenMachineMenu()}
          onClick={(event) => openMachineContextMenu(event, "connection")}
          onKeyDown={(event) => onMachineKeyDown(event, "connection")}
          title="Connection details"
        >
          <ChevronDown size={13} />
        </button>
        <button
          type="button"
          className={machineActionsButtonClassName}
          aria-haspopup="menu"
          aria-expanded={machineMenu?.kind === "actions"}
          disabled={machineActionDisabled()}
          onClick={(event) => openMachineContextMenu(event, "actions")}
          onKeyDown={(event) => onMachineKeyDown(event, "actions")}
          title="Machine actions"
        >
          <MoreVertical size={13} />
        </button>
      </div>
    );
  }

  return (
    <>
      <header className={globalTopbarClassName}>
        <div className={globalTopbarLeftClassName}>
          <div className={railBrandRowClassName}>
            <div className={topbarBrandClassName} aria-label="Whats Going On">
              <img src={projectLogoUrl} alt="" aria-hidden="true" />
              <span>WGO</span>
            </div>
            <button
              type="button"
              className={globalIconButtonClassName}
              onClick={onToggleMachinePanel}
              title={machinePanelCollapsed
                ? "Expand machine panel"
                : "Collapse machine panel"}
              aria-label={machinePanelCollapsed
                ? "Expand machine panel"
                : "Collapse machine panel"}
              aria-pressed={machinePanelCollapsed}
            >
              {machinePanelCollapsed
                ? <PanelLeftOpen size={12} />
                : <PanelLeftClose size={12} />}
            </button>
          </div>
          {machineTitleControls()}
        </div>
        <div className={topbarLeftDividerClassName} aria-hidden="true" />
        {machines.length > 1
          ? (
            <>
              {renderMachineLaunchers()}
              <div className={topbarLeftDividerClassName} aria-hidden="true" />
            </>
          )
          : null}
        <div className={globalTopbarCenterClassName} aria-hidden="true" />
        <div className={globalTopbarRightClassName}>
          <nav className={toolSwitcherClassName} aria-label="Workbench tools">
            {renderToolLaunchers()}
          </nav>
        </div>
        <button
          type="button"
          className={railAddMachineButtonClassName}
          onClick={onAddMachine}
          title="Add machine"
          aria-label="Add machine"
        >
          <Plus size={13} />
          <span>Add</span>
        </button>
      </header>
      {renderToolMenu()}
      {renderConnectionPopover()}
      {renderMachineActionsMenu()}
    </>
  );
}

function ConnectionPopover(
  { connection, daemonInfo, machine, menuRef, position }: {
    connection?: ConnectionState;
    daemonInfo: DaemonInfoState;
    machine?: Machine;
    menuRef: RefObject<HTMLDivElement | null>;
    position?: FloatingMenuPosition;
  },
) {
  const daemon = daemonInfo.phase === "ready"
    ? daemonInfo.daemonInfo
    : undefined;
  return (
    <FloatingMenu
      className={connectionPopoverClassName}
      menuRef={menuRef}
      position={position}
      role="dialog"
    >
      <div className={popoverHeaderClassName}>
        <div className={popoverTitleClassName}>
          {connection?.phase === "reachable"
            ? <CheckCircle2 size={14} className="text-wgo-success" />
            : <Radio size={14} className="text-wgo-text-3" />}
          <span>{machine?.name ?? "No machine"}</span>
        </div>
        <div className={popoverMetaClassName}>
          {connectionDetail(connection, daemonInfo)}
        </div>
      </div>
      <ConnectionRow
        label="Transport"
        value={connection?.phase === "reachable" ? "WebTransport" : "-"}
      />
      <ConnectionRow
        label="Endpoint"
        value={machine?.baseUrl.replace(/^https?:\/\//, "") ?? "-"}
      />
      <ConnectionRow label="OS" value={daemon?.os ?? "-"} />
      <ConnectionRow label="Version" value={daemon?.version ?? "-"} />
      <ConnectionRow
        label="Instance"
        value={daemon?.instanceId ?? daemonInfo.phase}
      />
      <ConnectionRow
        label="RPC"
        value={daemon ? `${daemon.supportedProcIds.length} procedures` : "-"}
      />
    </FloatingMenu>
  );
}

function ConnectionRow({ label, value }: { label: string; value: string }) {
  return (
    <div className={popoverRowClassName}>
      <span className={popoverLabelClassName}>{label}</span>
      <span className={popoverValueClassName}>{value}</span>
    </div>
  );
}

function connectionDetail(
  connection: ConnectionState | undefined,
  daemonInfo: DaemonInfoState,
): string {
  if (connection?.phase === "reachable") {
    const rtt = connection.rttMs === undefined
      ? "live"
      : `${connection.rttMs} ms`;
    return daemonInfo.phase === "ready"
      ? `Daemon ready · ${rtt}`
      : `Transport ready · daemon ${daemonInfo.phase}`;
  }
  if (connection?.phase === "idle") return "Checking daemon availability";
  return "Daemon unavailable";
}

interface ToolTabTarget {
  paneId: string;
  paneLabel: string;
  tab: WorkbenchTab;
}

function tabTargetsForPanes(panes: WorkbenchPane[]): ToolTabTarget[] {
  return panes.flatMap((pane, paneIndex) =>
    pane.tabs.map((tab) => ({
      paneId: pane.id,
      paneLabel: panes.length > 1 ? `Pane ${paneIndex + 1}` : "Current pane",
      tab,
    }))
  );
}

function latestTabTarget(
  targets: ToolTabTarget[],
  tool: WorkbenchTool,
): ToolTabTarget | undefined {
  for (let index = targets.length - 1; index >= 0; index--) {
    const target = targets[index];
    if (target.tab.tool === tool) return target;
  }
  return undefined;
}

function tabLabel(tab: WorkbenchTab): string {
  if (tab.tool === "terminal") {
    return tab.terminalLastKnownTitle ?? tab.title;
  }
  return tab.title;
}

function ToolIcon(
  { size, tool }: { size: number; tool: WorkbenchTool },
) {
  if (tool === "terminal") return <Terminal size={size} />;
  if (tool === "windows") return <AppWindow size={size} />;
  if (tool === "processes") return <Activity size={size} />;
  if (tool === "files") return <Folder size={size} />;
  return <Radio size={size} />;
}
