import {
  Activity,
  AppWindow,
  CheckCircle2,
  CircuitBoard,
  Cpu,
  Folder,
  HardDrive,
  Laptop,
  Monitor,
  PanelLeftClose,
  PanelLeftOpen,
  PcCase,
  Plus,
  Radio,
  RefreshCw,
  Router,
  Server,
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
import { type Machine, type MachineIconName } from "../../state/machines.ts";
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
  "app-rail [grid-column:1] [grid-row:1] flex flex-col",
  "h-full min-h-0 min-w-0 overflow-visible",
  "box-border bg-transparent",
  "gap-[12px] py-[14px] pl-[12px] pr-0 leading-[1.45] text-wgo-text-2",
  "max-[680px]:[grid-row:2] max-[680px]:m-[8px]",
  "max-[680px]:h-[60px] max-[680px]:min-h-0 max-[680px]:flex-row",
  "max-[680px]:items-center max-[680px]:justify-between max-[680px]:gap-[8px]",
  "max-[680px]:rounded-[18px] max-[680px]:border max-[680px]:border-white/56",
  "max-[680px]:bg-[rgba(248,248,248,0.82)] max-[680px]:px-[8px] max-[680px]:py-[6px]",
  "max-[680px]:shadow-[0_12px_32px_rgba(18,25,38,0.18),inset_0_1px_0_rgba(255,255,255,0.82)]",
  "max-[680px]:backdrop-blur-2xl",
].join(" ");
const globalTopbarLeftClassName = [
  "grid min-w-0",
  "max-[680px]:hidden",
].join(" ");
const globalTopbarCenterClassName = "min-w-0 pointer-events-none hidden";
const globalTopbarRightClassName =
  "grid min-w-0 content-start gap-[12px] max-[680px]:flex-1";
const topbarBrandClassName = [
  "inline-flex h-[34px] min-w-0 items-center gap-[8px] rounded-[11px] px-[2px]",
  "text-[13px] font-780 text-wgo-text",
  "[&_img]:h-[23px] [&_img]:w-[23px] [&_img]:rounded-[7px]",
  "[&_img]:shadow-[0_1px_2px_rgba(18,25,38,0.1)]",
  "max-[680px]:hidden",
].join(" ");
const topbarLeftDividerClassName = "hidden";
const globalIconButtonClassName = [
  "inline-flex appearance-none items-center justify-center w-[28px] min-w-[28px] h-[28px] min-h-[28px]",
  "box-border cursor-pointer border border-transparent rounded-wgo-md bg-transparent text-wgo-text-3 p-0 leading-none",
  "[font-family:inherit]",
  "opacity-72 hover:opacity-100 hover:border-white/44 hover:bg-white/36 hover:text-wgo-text-2",
  "active:bg-wgo-active",
  "max-[680px]:hidden",
].join(" ");
const toolSwitcherClassName = [
  "rail-tool-switcher grid w-full min-w-0 content-start gap-[2px] rounded-[14px]",
  "border border-white/34 bg-[rgba(248,248,248,0.28)] p-[6px] backdrop-blur-2xl",
  "shadow-[inset_0_1px_0_rgba(255,255,255,0.68),0_8px_18px_rgba(18,25,38,0.045)]",
  "max-[680px]:flex max-[680px]:h-[44px] max-[680px]:items-center max-[680px]:justify-center",
  "max-[680px]:gap-[4px] max-[680px]:border-0 max-[680px]:bg-transparent",
  "max-[680px]:p-0 max-[680px]:shadow-none",
].join(" ");
const toolSplitClassName = [
  "inline-flex h-[31px] w-full min-w-0 items-center gap-0 rounded-[10px] px-[2px]",
  "border border-transparent text-[12px] font-650 text-wgo-text-3/68",
  "wgo-transition",
  "hover:bg-white/20 hover:text-wgo-text-2",
  "[&.active]:border-white/74 [&.active]:bg-[rgba(255,255,255,0.72)] [&.active]:text-wgo-text",
  "[&.active]:shadow-[0_6px_14px_rgba(20,30,46,0.095),inset_0_1px_0_rgba(255,255,255,0.86),inset_0_-1px_0_rgba(32,48,70,0.035)]",
  "max-[680px]:h-[44px] max-[680px]:flex-[1_1_0] max-[680px]:justify-center",
  "max-[680px]:rounded-[14px] max-[680px]:px-0",
].join(" ");
const toolNameButtonClassName = [
  "inline-flex h-[27px] min-w-0 flex-1 appearance-none items-center justify-start gap-[7px]",
  "rounded-[8px] border-0 bg-transparent px-[7px] py-0 text-inherit [font-family:inherit]",
  "cursor-pointer wgo-transition",
  "hover:bg-white/18 hover:text-wgo-text",
  "[&_svg]:flex-[0_0_auto] [&_svg]:opacity-86 [&_span]:min-w-0 [&_span]:overflow-hidden [&_span]:text-ellipsis [&_span]:whitespace-nowrap",
  "max-[680px]:h-full max-[680px]:justify-center max-[680px]:gap-0 max-[680px]:px-0",
].join(" ");
const toolNameLabelClassName = "app-rail-label max-[680px]:hidden";
const toolPlusButtonClassName = [
  "relative inline-flex h-[27px] w-[28px] min-w-[28px] appearance-none items-center justify-center",
  "rounded-[8px] border-0 bg-transparent p-0 text-inherit [font-family:inherit]",
  "before:content-[''] before:pointer-events-none before:absolute before:left-[-1px]",
  "before:top-[7px] before:bottom-[7px] before:w-px before:rounded-full",
  "before:bg-[rgba(18,25,38,0.16)]",
  "cursor-pointer opacity-52 wgo-transition hover:bg-white/30 hover:text-wgo-text hover:opacity-100",
  "[.active_&]:opacity-62",
  "max-[680px]:hidden",
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
const mobileMachineMenuClassName = [
  machineMenuClassName,
  "max-[680px]:w-[252px]",
].join(" ");
const machineMenuHeaderClassName =
  "px-[8px] pb-[5px] pt-[6px] text-[11px] font-760 tracking-[0] text-wgo-text-3";
const machineMenuDividerClassName =
  "mx-[5px] my-[5px] h-px bg-[rgba(18,25,38,0.12)] shadow-[0_1px_0_rgba(255,255,255,0.64)]";
const machineMenuDangerItemClassName = [
  "text-wgo-danger hover:bg-wgo-danger-soft hover:text-wgo-danger",
  "[&_svg]:text-wgo-danger",
].join(" ");
const statusDotClassName = "h-[6px] w-[6px] rounded-full";
const railBrandActionsClassName = "inline-flex items-center gap-[4px]";
const railStatusButtonClassName = [
  "inline-flex h-[28px] min-w-[22px] appearance-none items-center justify-center",
  "rounded-wgo-md border border-transparent bg-transparent p-0 [font-family:inherit]",
  "cursor-pointer opacity-82 wgo-transition",
  "hover:border-white/44 hover:bg-white/36 hover:opacity-100",
  "disabled:cursor-default disabled:opacity-45",
].join(" ");
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
  "grid min-w-0 grid-cols-[repeat(auto-fill,minmax(38px,1fr))] gap-[7px]",
  "rounded-[15px] border border-white/28 bg-[rgba(248,248,248,0.28)] p-[7px] backdrop-blur-xl",
  "max-[680px]:hidden",
].join(" ");
const railMachineButtonClassName = [
  "group relative inline-flex aspect-square min-w-0 appearance-none items-center justify-center",
  "rounded-[12px] border border-transparent bg-white/18 px-0",
  "text-[12px] font-650 text-wgo-text-3 [font-family:inherit]",
  "cursor-pointer wgo-transition hover:border-white/48 hover:bg-white/34 hover:text-wgo-text-2",
  "[&.active]:border-white/74 [&.active]:bg-white/70 [&.active]:text-wgo-text",
  "[&.active]:shadow-[inset_0_1px_0_rgba(255,255,255,0.86),0_6px_16px_rgba(18,25,38,0.08)]",
  "[&_svg]:[stroke-width:2]",
].join(" ");
const railAddMachineButtonClassName = [
  "inline-flex aspect-square min-w-0 appearance-none items-center justify-center",
  "rounded-[12px] border border-dashed border-white/34 bg-white/10 px-0",
  "text-wgo-text-3 [font-family:inherit]",
  "cursor-pointer wgo-transition hover:border-white/48 hover:bg-white/34 hover:text-wgo-text",
  "max-[680px]:mt-0 max-[680px]:h-[44px] max-[680px]:w-[44px] max-[680px]:min-w-[44px]",
  "max-[680px]:rounded-[14px] max-[680px]:px-0 max-[680px]:text-wgo-text-2",
  "max-[680px]:[&_span]:hidden",
].join(" ");
const mobileMachineButtonClassName = [
  "hidden h-[44px] w-[44px] min-w-[44px] appearance-none items-center justify-center",
  "relative rounded-[14px] border border-transparent bg-white/18 p-0 text-wgo-text-2",
  "[font-family:inherit] cursor-pointer wgo-transition",
  "hover:border-white/48 hover:bg-white/34 hover:text-wgo-text",
  "max-[680px]:inline-flex",
].join(" ");
const railMachineIconDotClassName = [
  "absolute bottom-[5px] right-[5px] h-[5px] w-[5px] rounded-full",
  "bg-wgo-text-3/42 group-[.active]:bg-wgo-accent",
].join(" ");
const iconPickerMenuClassName = [
  "grid grid-cols-[repeat(4,minmax(0,1fr))] gap-[5px] px-[5px] pb-[2px]",
].join(" ");
const iconPickerItemClassName = [
  "!h-[38px] !min-h-[38px] !justify-center !rounded-wgo-md !px-0",
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

const machineIconOptions: {
  icon: typeof Monitor;
  label: string;
  name: MachineIconName;
}[] = [
  { icon: Monitor, label: "Monitor", name: "monitor" },
  { icon: Laptop, label: "Laptop", name: "laptop" },
  { icon: Server, label: "Server", name: "server" },
  { icon: Cpu, label: "CPU", name: "cpu" },
  { icon: HardDrive, label: "Drive", name: "hard-drive" },
  { icon: Router, label: "Router", name: "router" },
  { icon: CircuitBoard, label: "Board", name: "circuit-board" },
  { icon: PcCase, label: "PC case", name: "pc-case" },
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
  onConfigureMachine: (machineId: string) => void;
  onDeleteMachine: (machineId: string) => void;
  onReconnectMachine: (machineId: string) => void;
  onSelectMachine: (machineId: string) => void;
  onToggleMachinePanel: () => void;
  onUnpairMachine: (machineId: string) => void;
  onUpdateMachineIcon: (machineId: string, icon: MachineIconName) => void;
}

type ToolMenuKind = "tabs" | "create";

interface ToolMenuState {
  kind: ToolMenuKind;
  position: FloatingMenuPosition;
  tool: WorkbenchTool;
}

interface MachineMenuState {
  kind: "connection" | "actions";
  machineId?: string;
  position: FloatingMenuPosition;
  source?: "desktop" | "mobile";
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
    onUpdateMachineIcon,
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

  function closeCreateToolMenu() {
    setToolMenu((current) => current?.kind === "create" ? undefined : current);
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
    machineId = selectedMachineId,
    source: MachineMenuState["source"] = "desktop",
  ) {
    const rect = target.getBoundingClientRect();
    const width = kind === "connection" ? 320 : source === "mobile" ? 252 : 216;
    setToolMenu(undefined);
    setMachineMenu({
      kind,
      machineId,
      position: clampFloatingMenuPosition(
        rect.right + 8,
        rect.top,
        {
          itemCount: kind === "connection" ? 7 : source === "mobile" ? 18 : 12,
          width,
        },
      ),
      source,
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

  function runMachineAction(
    machineId: string | undefined,
    action: (
      machineId: string,
    ) => void,
  ) {
    if (!machineId) return;
    closeMachineMenu();
    action(machineId);
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

  function openActionsMenu(target: HTMLElement, machineId = selectedMachineId) {
    openMachineMenu("actions", target, machineId);
  }

  function openMobileMachineMenu(target: HTMLElement) {
    openMachineMenu("actions", target, selectedMachineId, "mobile");
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

  function toolHasCreateOptions(tool: WorkbenchTool) {
    return tool === "files" || tool === "terminal";
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
    if (!toolHasCreateOptions(tool)) return;
    if (event.key === "ArrowDown") {
      event.preventDefault();
      openToolMenu(tool, "create", event.currentTarget);
    }
  }

  function menuMachine() {
    return machines.find((item) => item.id === machineMenu?.machineId) ??
      machine;
  }

  function deviceName(targetMachine = machine) {
    return targetMachine?.name ?? "No machine";
  }

  function isPaired(targetMachine = machine) {
    return Boolean(targetMachine?.clientId && targetMachine?.clientSecret);
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

  function openMachineLauncherContextMenu(
    event: MouseEvent<HTMLButtonElement>,
    machineId: string,
  ) {
    event.preventDefault();
    event.stopPropagation();
    onSelectMachine(machineId);
    openActionsMenu(event.currentTarget, machineId);
  }

  function onMachineLauncherKeyDown(
    event: KeyboardEvent<HTMLButtonElement>,
    machineId: string,
  ) {
    if (
      event.key !== "ContextMenu" && !(event.shiftKey && event.key === "F10")
    ) {
      return;
    }
    event.preventDefault();
    onSelectMachine(machineId);
    openActionsMenu(event.currentTarget, machineId);
  }

  function selectMachineIcon(machineId: string, icon: MachineIconName) {
    onUpdateMachineIcon(machineId, icon);
    closeMachineMenu();
  }

  function selectMachineFromMenu(machineId: string) {
    onSelectMachine(machineId);
    closeMachineMenu();
  }

  function addMachineFromMenu() {
    closeMachineMenu();
    onAddMachine();
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
    const targetMachine = menuMachine();
    const machineId = targetMachine?.id;
    const mobileMenu = machineMenu?.source === "mobile";
    const otherMachines = machines.filter((item) => item.id !== machineId);
    return (
      <FloatingMenu
        className={mobileMenu
          ? mobileMachineMenuClassName
          : machineMenuClassName}
        menuRef={machineMenuRef}
        position={position}
      >
        <div className={machineMenuHeaderClassName}>
          {deviceName(targetMachine)}
        </div>
        <FloatingMenuItem
          disabled={!machineId}
          onClick={() => runMachineAction(machineId, onReconnectMachine)}
        >
          <RefreshCw size={15} />
          Reconnect
        </FloatingMenuItem>
        <FloatingMenuItem
          disabled={!machineId}
          onClick={() => runMachineAction(machineId, onConfigureMachine)}
        >
          <Settings size={15} />
          Configure
        </FloatingMenuItem>
        <div className={machineMenuDividerClassName} aria-hidden="true" />
        <FloatingMenuItem
          disabled={!machineId || !isPaired(targetMachine)}
          onClick={() => runMachineAction(machineId, onUnpairMachine)}
        >
          <Unlink size={15} />
          Unpair
        </FloatingMenuItem>
        <div className={machineMenuDividerClassName} aria-hidden="true" />
        <div className={machineMenuHeaderClassName}>
          Icon
        </div>
        <div className={iconPickerMenuClassName} role="group">
          {machineIconOptions.map(({ icon: Icon, label, name }) => (
            <FloatingMenuItem
              key={name}
              className={iconPickerItemClassName}
              disabled={!machineId}
              onClick={() => machineId && selectMachineIcon(machineId, name)}
              title={label}
              aria-label={label}
            >
              <Icon size={17} />
            </FloatingMenuItem>
          ))}
        </div>
        <div className={machineMenuDividerClassName} aria-hidden="true" />
        {mobileMenu
          ? (
            <>
              <div className={machineMenuHeaderClassName}>
                Other Devices
              </div>
              {otherMachines.length === 0
                ? (
                  <FloatingMenuItem disabled>
                    <Monitor size={15} />
                    No Other Devices
                  </FloatingMenuItem>
                )
                : otherMachines.map((item) => (
                  <FloatingMenuItem
                    key={item.id}
                    onClick={() => selectMachineFromMenu(item.id)}
                  >
                    <MachineIcon name={item.icon} size={15} />
                    <span>{item.name}</span>
                  </FloatingMenuItem>
                ))}
              <FloatingMenuItem onClick={addMachineFromMenu}>
                <Plus size={15} />
                Add Machine
              </FloatingMenuItem>
              <div
                className={machineMenuDividerClassName}
                aria-hidden="true"
              />
            </>
          )
          : null}
        <FloatingMenuItem
          tone="danger"
          className={machineMenuDangerItemClassName}
          disabled={!machineId}
          onClick={() => runMachineAction(machineId, onDeleteMachine)}
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

  function canOpenMachineMenu() {
    return Boolean(machine);
  }

  function renderConnectionStatusButton() {
    return (
      <button
        type="button"
        className={railStatusButtonClassName}
        aria-haspopup="dialog"
        aria-expanded={machineMenu?.kind === "connection"}
        aria-label={`Connection: ${connectionDetail(connection, daemonInfo)}`}
        disabled={!canOpenMachineMenu()}
        onClick={(event) => openConnectionMenu(event.currentTarget)}
        onKeyDown={(event) => {
          if (event.key !== "ArrowDown") return;
          event.preventDefault();
          openConnectionMenu(event.currentTarget);
        }}
        title="Connection details"
      >
        {connectionIcon()}
      </button>
    );
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
          aria-haspopup={toolHasCreateOptions(tool) ? "menu" : undefined}
          aria-label={`New ${label} Tab`}
          onClick={() => openToolTabFromMenu(tool)}
          onFocus={(event) => {
            if (!toolHasCreateOptions(tool)) {
              closeCreateToolMenu();
              return;
            }
            showToolMenuOnFocus(tool, "create", event.currentTarget);
          }}
          onKeyDown={(event) => onToolPlusKeyDown(event, tool)}
          onMouseEnter={(event) => {
            if (!toolHasCreateOptions(tool)) {
              clearPendingToolMenu();
              closeCreateToolMenu();
              return;
            }
            scheduleToolMenu(tool, "create", event.currentTarget);
          }}
          onMouseLeave={clearPendingToolMenu}
          title={`New ${label} Tab`}
        >
          <Plus size={12} strokeWidth={2.3} />
        </button>
      </div>
    ));
  }

  function renderMachineLaunchers() {
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
            onContextMenu={(event) =>
              openMachineLauncherContextMenu(event, item.id)}
            onKeyDown={(event) => onMachineLauncherKeyDown(event, item.id)}
            title={item.name}
            aria-label={item.name}
            aria-haspopup="menu"
            aria-current={item.id === selectedMachineId ? "true" : undefined}
          >
            <MachineIcon name={item.icon} size={18} />
            <span className={railMachineIconDotClassName} />
          </button>
        ))}
        <button
          type="button"
          className={railAddMachineButtonClassName}
          onClick={onAddMachine}
          title="Add machine"
          aria-label="Add machine"
        >
          <Plus size={17} strokeWidth={2.2} />
        </button>
      </nav>
    );
  }

  function renderMobileMachineButton() {
    return (
      <button
        type="button"
        className={mobileMachineButtonClassName}
        aria-haspopup="menu"
        aria-expanded={machineMenu?.kind === "actions" &&
          machineMenu.source === "mobile"}
        aria-label="Device management"
        onClick={(event) => openMobileMachineMenu(event.currentTarget)}
        onKeyDown={(event) => {
          if (event.key !== "ArrowDown") return;
          event.preventDefault();
          openMobileMachineMenu(event.currentTarget);
        }}
        title="Device management"
      >
        <MachineIcon name={machine?.icon} size={18} />
        <span className={railMachineIconDotClassName} />
      </button>
    );
  }

  return (
    <>
      <header className={globalTopbarClassName}>
        <div className={globalTopbarLeftClassName}>
          <div className={railBrandRowClassName}>
            <div
              className={className(topbarBrandClassName, "app-rail-expanded")}
              aria-label="Whats Going On"
            >
              <img src={projectLogoUrl} alt="" aria-hidden="true" />
            </div>
            <div className={railBrandActionsClassName}>
              {renderConnectionStatusButton()}
              <button
                type="button"
                className={globalIconButtonClassName}
                onClick={onToggleMachinePanel}
                title={machinePanelCollapsed
                  ? "Expand sidebar"
                  : "Collapse sidebar"}
                aria-label={machinePanelCollapsed
                  ? "Expand sidebar"
                  : "Collapse sidebar"}
                aria-pressed={machinePanelCollapsed}
              >
                {machinePanelCollapsed
                  ? <PanelLeftOpen size={12} />
                  : <PanelLeftClose size={12} />}
              </button>
            </div>
          </div>
        </div>
        <div className={topbarLeftDividerClassName} aria-hidden="true" />
        {renderMachineLaunchers()}
        <div className={topbarLeftDividerClassName} aria-hidden="true" />
        {renderMobileMachineButton()}
        <div className={globalTopbarCenterClassName} aria-hidden="true" />
        <div className={globalTopbarRightClassName}>
          <nav className={toolSwitcherClassName} aria-label="Workbench tools">
            {renderToolLaunchers()}
          </nav>
        </div>
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

function MachineIcon(
  { name = "monitor", size }: { name?: MachineIconName; size: number },
) {
  const option = machineIconOptions.find((item) => item.name === name) ??
    machineIconOptions[0];
  const Icon = option.icon;
  return <Icon size={size} />;
}
