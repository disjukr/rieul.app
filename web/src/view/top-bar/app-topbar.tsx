import { style, theme } from "../../zyzz.config.ts";
import { Dynamic } from "@solidjs/web";
import { createMemo, createSignal } from "solid-js";
import type { AvailableShellInfo } from "../../protocol/generated/rpc.ts";
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
  MoreHorizontal,
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
} from "../../solid/icons.tsx";
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

const projectLogoUrl = new URL("../../assets/rieul.svg", import.meta.url).href;

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
  activeTool?: WorkbenchTool;
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

interface ToolMenuState {
  position: FloatingMenuPosition;
  tool: WorkbenchTool;
}

interface MachineMenuState {
  kind: "connection" | "actions";
  machineId?: string;
  position: FloatingMenuPosition;
  source?: "desktop" | "mobile";
}

export function AppTopbar(componentProps: AppTopbarProps) {
  const toolMenuRef = { current: null as HTMLDivElement | null | null };
  const machineMenuRef = { current: null as HTMLDivElement | null | null };
  const [toolMenu, setToolMenu] = createSignal<ToolMenuState | undefined>();
  const [machineMenu, setMachineMenu] = createSignal<
    MachineMenuState | undefined
  >();
  const defaultTerminalShell = createMemo(
    () =>
      componentProps.terminalShells.find((shell) => shell.isDefault) ??
      componentProps.terminalShells[0],
  );
  const openToolTab = createMemo(() => ({
    daemon: componentProps.onOpenDaemonTab,
    files: componentProps.onOpenFilesTab,
    processes: componentProps.onOpenProcessesTab,
    terminal: openDefaultTerminal,
    windows: componentProps.onOpenWindowsTab,
  }));
  const closeToolMenu = () => {
    setToolMenu(undefined);
  };
  useFloatingMenuDismiss(
    () => toolMenu() !== undefined,
    toolMenuRef,
    closeToolMenu,
    { closeOnScroll: true },
  );
  const closeMachineMenu = () => {
    setMachineMenu(undefined);
  };
  useFloatingMenuDismiss(
    () => machineMenu() !== undefined,
    machineMenuRef,
    closeMachineMenu,
    { closeOnScroll: true },
  );

  const tabTargets = createMemo(() => tabTargetsForPanes(componentProps.panes));

  function openToolMenu(tool: WorkbenchTool, target: HTMLElement) {
    const rect = target.getBoundingClientRect();
    setMachineMenu(undefined);
    setToolMenu({
      tool,
      position: clampFloatingMenuPosition(rect.right + 8, rect.top, {
        itemCount: 4,
        width: 244,
      }),
    });
  }

  function openMachineMenu(
    kind: "connection" | "actions",
    target: HTMLElement,
    machineId = componentProps.selectedMachineId,
    source: MachineMenuState["source"] = "desktop",
  ) {
    const rect = target.getBoundingClientRect();
    const width = kind === "connection" ? 320 : source === "mobile" ? 252 : 216;
    setToolMenu(undefined);
    setMachineMenu({
      kind,
      machineId,
      position: clampFloatingMenuPosition(rect.right + 8, rect.top, {
        itemCount: kind === "connection" ? 7 : source === "mobile" ? 18 : 12,
        width,
      }),
      source,
    });
  }

  function selectLatestToolTab(tool: WorkbenchTool) {
    const latest = latestTabTarget(tabTargets(), tool);
    if (!latest) {
      openToolTab()[tool]();
      revealWorkbenchOnMobile();
      return;
    }
    componentProps.onSelectTab(latest.paneId, latest.tab.id);
    revealWorkbenchOnMobile();
  }

  function runMachineAction(
    machineId: string | undefined,
    action: (machineId: string) => void,
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
    const shell = defaultTerminalShell();
    closeToolMenu();
    if (!shell) {
      componentProps.onOpenTerminalTab();
      revealWorkbenchOnMobile();
      return;
    }
    componentProps.onOpenTerminalTab(terminalTabConfigForShell(shell));
    revealWorkbenchOnMobile();
  }

  function openTerminalForShell(shell: AvailableShellInfo) {
    closeToolMenu();
    componentProps.onOpenTerminalTab(terminalTabConfigForShell(shell));
    revealWorkbenchOnMobile();
  }

  function openConnectionMenu(target: HTMLElement) {
    if (machineMenu()?.kind === "connection") {
      closeMachineMenu();
      return;
    }
    openMachineMenu("connection", target);
  }

  function openActionsMenu(
    target: HTMLElement,
    machineId = componentProps.selectedMachineId,
  ) {
    openMachineMenu("actions", target, machineId);
  }

  function openMobileMachineMenu(target: HTMLElement) {
    openMachineMenu(
      "actions",
      target,
      componentProps.selectedMachineId,
      "mobile",
    );
  }

  function openToolTabFromMenu(tool: WorkbenchTool) {
    closeToolMenu();
    openToolTab()[tool]();
    revealWorkbenchOnMobile();
  }

  function openFilesOption(filesView: "roots" | "home" | "trash") {
    closeToolMenu();
    componentProps.onOpenFilesTab({ filesView });
    revealWorkbenchOnMobile();
  }

  function revealWorkbenchOnMobile() {
    if (!isMobileRailViewport()) return;
    const shell = document.querySelector<HTMLElement>(".app-shell");
    shell?.scrollTo({ left: shell.clientWidth, behavior: "smooth" });
  }

  function isMobileRailViewport() {
    return globalThis.matchMedia("(max-width: 680px)").matches;
  }

  function toolMenuTitle(tool: WorkbenchTool) {
    return topbarTools.find((item) => item.tool === tool)?.label ?? tool;
  }

  function onToolNameKeyDown(
    event: KeyboardEvent & { currentTarget: HTMLButtonElement },
    tool: WorkbenchTool,
  ) {
    if (event.key === "ArrowDown") {
      event.preventDefault();
      selectLatestToolTab(tool);
    }
  }

  function menuMachine() {
    return (
      componentProps.machines.find(
        (item) => item.id === machineMenu()?.machineId,
      ) ?? componentProps.machine
    );
  }

  function deviceName(targetMachine = componentProps.machine) {
    return targetMachine?.name ?? "No machine";
  }

  function isPaired(targetMachine = componentProps.machine) {
    return Boolean(targetMachine?.clientId && targetMachine?.clientSecret);
  }

  function connectionIcon() {
    return (
      <span
        class={className(
          styles.statusDot().class,
          componentProps.connection?.phase === "reachable"
            ? styles.span().class
            : componentProps.connection?.phase === "idle"
              ? styles.span2().class
              : styles.span3().class,
        )}
      />
    );
  }

  function connectionPopoverPosition() {
    return machineMenu()?.kind === "connection"
      ? machineMenu()!.position
      : undefined;
  }

  function actionsPopoverPosition() {
    return machineMenu()?.kind === "actions"
      ? machineMenu()!.position
      : undefined;
  }

  function openMachineLauncherContextMenu(
    event: MouseEvent & { currentTarget: HTMLButtonElement },
    machineId: string,
  ) {
    event.preventDefault();
    event.stopPropagation();
    componentProps.onSelectMachine(machineId);
    openActionsMenu(event.currentTarget, machineId);
  }

  function onMachineLauncherKeyDown(
    event: KeyboardEvent & { currentTarget: HTMLButtonElement },
    machineId: string,
  ) {
    if (
      event.key !== "ContextMenu" &&
      !(event.shiftKey && event.key === "F10")
    ) {
      return;
    }
    event.preventDefault();
    componentProps.onSelectMachine(machineId);
    openActionsMenu(event.currentTarget, machineId);
  }

  function selectMachineIcon(machineId: string, icon: MachineIconName) {
    componentProps.onUpdateMachineIcon(machineId, icon);
    closeMachineMenu();
  }

  function selectMachineFromMenu(machineId: string) {
    componentProps.onSelectMachine(machineId);
    closeMachineMenu();
  }

  function addMachineFromMenu() {
    closeMachineMenu();
    componentProps.onAddMachine();
  }

  function renderToolMenu() {
    if (!toolMenu()) return null;
    return (
      <FloatingMenu
        className={styles.topbarMenu().class}
        menuRef={toolMenuRef}
        position={toolMenu()!.position}
      >
        <div {...styles.topbarMenuHeader()}>
          New {toolMenuTitle(toolMenu()!.tool)}
        </div>
        {toolMenu()!.tool === "files" ? (
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
        ) : toolMenu()!.tool === "terminal" ? (
          componentProps.terminalShells.length === 0 ? (
            <FloatingMenuItem disabled>
              <Terminal size={14} />
              No shells available
            </FloatingMenuItem>
          ) : (
            componentProps.terminalShells.map((shell) => (
              <FloatingMenuItem onClick={() => openTerminalForShell(shell)}>
                <Terminal size={14} />
                <span>{shell.name}</span>
                {shell.isDefault ? (
                  <span {...styles.topbarMenuMeta()}>Default</span>
                ) : null}
              </FloatingMenuItem>
            ))
          )
        ) : (
          <FloatingMenuItem
            onClick={() => openToolTabFromMenu(toolMenu()!.tool)}
          >
            <ToolIcon tool={toolMenu()!.tool} size={14} />
            New {toolMenuTitle(toolMenu()!.tool)} Tab
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
    const mobileMenu = machineMenu()?.source === "mobile";
    const otherMachines = componentProps.machines.filter(
      (item) => item.id !== machineId,
    );
    return (
      <FloatingMenu
        className={
          mobileMenu
            ? [styles.machineMenu().class, styles.mobileMenuWidth().class].join(
                " ",
              )
            : styles.machineMenu().class
        }
        menuRef={machineMenuRef}
        position={position}
      >
        <div {...styles.machineMenuHeader()}>{deviceName(targetMachine)}</div>
        <FloatingMenuItem
          disabled={!machineId}
          onClick={() =>
            runMachineAction(machineId, componentProps.onReconnectMachine)
          }
        >
          <RefreshCw size={15} />
          Reconnect
        </FloatingMenuItem>
        <FloatingMenuItem
          disabled={!machineId}
          onClick={() =>
            runMachineAction(machineId, componentProps.onConfigureMachine)
          }
        >
          <Settings size={15} />
          Configure
        </FloatingMenuItem>
        <div {...styles.machineMenuDivider()} aria-hidden="true" />
        <FloatingMenuItem
          disabled={!machineId || !isPaired(targetMachine)}
          onClick={() =>
            runMachineAction(machineId, componentProps.onUnpairMachine)
          }
        >
          <Unlink size={15} />
          Unpair
        </FloatingMenuItem>
        <div {...styles.machineMenuDivider()} aria-hidden="true" />
        <div {...styles.machineMenuHeader()}>Icon</div>
        <div {...styles.iconPickerMenu()} role="group">
          {machineIconOptions.map(({ icon: Icon, label, name }) => (
            <FloatingMenuItem
              className={styles.iconPickerItem().class}
              disabled={!machineId}
              onClick={() => machineId && selectMachineIcon(machineId, name)}
              title={label}
              aria-label={label}
            >
              <Icon size={17} />
            </FloatingMenuItem>
          ))}
        </div>
        <div {...styles.machineMenuDivider()} aria-hidden="true" />
        {mobileMenu ? (
          <>
            <div {...styles.machineMenuHeader()}>Other Devices</div>
            {otherMachines.length === 0 ? (
              <FloatingMenuItem disabled>
                <Monitor size={15} />
                No Other Devices
              </FloatingMenuItem>
            ) : (
              otherMachines.map((item) => (
                <FloatingMenuItem
                  onClick={() => selectMachineFromMenu(item.id)}
                >
                  <MachineIcon name={item.icon} size={15} />
                  <span>{item.name}</span>
                </FloatingMenuItem>
              ))
            )}
            <FloatingMenuItem onClick={addMachineFromMenu}>
              <Plus size={15} />
              Add Machine
            </FloatingMenuItem>
            <div {...styles.machineMenuDivider()} aria-hidden="true" />
          </>
        ) : null}
        <FloatingMenuItem
          tone="danger"
          className={styles.machineMenuDangerItem().class}
          disabled={!machineId}
          onClick={() =>
            runMachineAction(machineId, componentProps.onDeleteMachine)
          }
        >
          <Trash2 size={15} />
          Delete
        </FloatingMenuItem>
      </FloatingMenu>
    );
  }

  function renderConnectionPopover() {
    const connectionPosition = connectionPopoverPosition();
    if (!connectionPosition) return null;
    return (
      <ConnectionPopover
        connection={componentProps.connection}
        daemonInfo={componentProps.daemonInfo}
        machine={componentProps.machine}
        menuRef={machineMenuRef}
        position={connectionPosition}
      />
    );
  }

  function canOpenMachineMenu() {
    return Boolean(componentProps.machine);
  }

  function renderConnectionStatusButton() {
    return (
      <button
        type="button"
        {...styles.railStatusButton()}
        aria-haspopup="dialog"
        aria-expanded={machineMenu()?.kind === "connection" ? "true" : "false"}
        aria-label={`Connection: ${connectionDetail(componentProps.connection, componentProps.daemonInfo)}`}
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
        class={className(
          "group",
          styles.toolSplit().class,
          componentProps.activeTool === tool && "active",
        )}
      >
        <button
          type="button"
          {...styles.toolNameButton()}
          aria-haspopup="menu"
          aria-label={label}
          onClick={() => selectLatestToolTab(tool)}
          onContextMenu={(event) => {
            event.preventDefault();
            openToolMenu(tool, event.currentTarget);
          }}
          onKeyDown={(event) => onToolNameKeyDown(event, tool)}
          title={label}
        >
          <Icon size={13} />
          <span class={"app-rail-label"}>{label}</span>
        </button>
        {hasToolMenu(tool) ? (
          <button
            type="button"
            {...styles.toolMenuButton({ className: "app-rail-expanded" })}
            aria-label={`${label} menu`}
            aria-haspopup="menu"
            aria-expanded={toolMenu()?.tool === tool ? "true" : "false"}
            onClick={(event) => {
              event.stopPropagation();
              openToolMenu(tool, event.currentTarget);
            }}
            title={`${label} menu`}
          >
            <MoreHorizontal size={14} />
          </button>
        ) : null}
      </div>
    ));
  }

  function renderMachineLaunchers() {
    return (
      <nav
        {...styles.railMachineList({ className: "app-rail-section" })}
        aria-label="Machines"
      >
        {componentProps.machines.map((item) => (
          <button
            type="button"
            class={className(
              styles.railMachineButton({ className: "group" }).class,
              item.id === componentProps.selectedMachineId && "active",
            )}
            onClick={() => componentProps.onSelectMachine(item.id)}
            onContextMenu={(event) =>
              openMachineLauncherContextMenu(event, item.id)
            }
            onKeyDown={(event) => onMachineLauncherKeyDown(event, item.id)}
            title={item.name}
            aria-label={item.name}
            aria-haspopup="menu"
            aria-current={
              item.id === componentProps.selectedMachineId ? "true" : undefined
            }
          >
            <MachineIcon name={item.icon} size={18} />
            <span {...styles.railMachineIconDot()} />
          </button>
        ))}
        <button
          type="button"
          {...styles.railAddMachineButton()}
          onClick={() => componentProps.onAddMachine()}
          title="Add machine"
          aria-label="Add machine"
        >
          <Plus size={17} stroke-width={2.2} />
        </button>
      </nav>
    );
  }

  function renderMobileMachineButton() {
    return (
      <button
        type="button"
        {...styles.mobileMachineButton()}
        aria-haspopup="menu"
        aria-expanded={
          machineMenu()?.kind === "actions" &&
          machineMenu()!.source === "mobile"
            ? "true"
            : "false"
        }
        aria-label="Device management"
        onClick={(event) => openMobileMachineMenu(event.currentTarget)}
        onKeyDown={(event) => {
          if (event.key !== "ArrowDown") return;
          event.preventDefault();
          openMobileMachineMenu(event.currentTarget);
        }}
        title="Device management"
      >
        <MachineIcon name={componentProps.machine?.icon} size={18} />
        <span {...styles.railMachineIconDot()} />
      </button>
    );
  }

  return (
    <>
      <header {...styles.globalTopbar({ className: "app-rail" })}>
        <div {...styles.globalTopbarLeft({ className: "app-rail-section" })}>
          <div {...styles.railBrandRow()}>
            <div
              class={className(styles.topbarBrand().class, "app-rail-expanded")}
              aria-label="Rieul"
            >
              <img src={projectLogoUrl} alt="" aria-hidden="true" />
            </div>
            <div
              {...styles.railMachineName({ className: "app-rail-expanded" })}
            >
              {deviceName()}
            </div>
            <div {...styles.railBrandActions()}>
              {renderConnectionStatusButton()}
              <button
                type="button"
                {...styles.globalIconButton()}
                onClick={() => componentProps.onToggleMachinePanel()}
                title={
                  componentProps.machinePanelCollapsed
                    ? "Expand sidebar"
                    : "Collapse sidebar"
                }
                aria-label={
                  componentProps.machinePanelCollapsed
                    ? "Expand sidebar"
                    : "Collapse sidebar"
                }
                aria-pressed={
                  componentProps.machinePanelCollapsed ? "true" : "false"
                }
              >
                {componentProps.machinePanelCollapsed ? (
                  <PanelLeftOpen size={12} />
                ) : (
                  <PanelLeftClose size={12} />
                )}
              </button>
            </div>
          </div>
        </div>
        <div {...styles.topbarLeftDivider()} aria-hidden="true" />
        {renderMachineLaunchers()}
        <div {...styles.topbarLeftDivider()} aria-hidden="true" />
        {renderMobileMachineButton()}
        <div {...styles.globalTopbarCenter()} aria-hidden="true" />
        <div {...styles.globalTopbarRight({ className: "app-rail-section" })}>
          <nav
            {...styles.toolSwitcher({ className: "rail-tool-switcher" })}
            aria-label="Workbench tools"
          >
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

function ConnectionPopover(componentProps: {
  connection?: ConnectionState;
  daemonInfo: DaemonInfoState;
  machine?: Machine;
  menuRef: { current: HTMLDivElement | null };
  position?: FloatingMenuPosition;
}) {
  const daemon = createMemo(() =>
    componentProps.daemonInfo.phase === "ready"
      ? componentProps.daemonInfo.daemonInfo
      : undefined,
  );
  return (
    <FloatingMenu
      className={styles.connectionPopover().class}
      menuRef={componentProps.menuRef}
      position={componentProps.position}
      role="dialog"
      aria-label={`${componentProps.machine?.name ?? "Machine"} connection`}
    >
      <div {...styles.popoverHeader()}>
        <div {...styles.popoverTitle()}>
          {componentProps.connection?.phase === "reachable" ? (
            <CheckCircle2 size={14} className={styles.checkCircle2().class} />
          ) : (
            <Radio size={14} className={styles.radio().class} />
          )}
          <span>{componentProps.machine?.name ?? "No machine"}</span>
        </div>
        <div {...styles.popoverMeta()}>
          {connectionDetail(
            componentProps.connection,
            componentProps.daemonInfo,
          )}
        </div>
      </div>
      <ConnectionRow
        label="Transport"
        value={
          componentProps.connection?.phase === "reachable"
            ? "WebTransport"
            : "-"
        }
      />
      <ConnectionRow
        label="Endpoint"
        value={
          componentProps.machine?.baseUrl.replace(/^https?:\/\//, "") ?? "-"
        }
      />
      <ConnectionRow label="OS" value={daemon()?.os ?? "-"} />
      <ConnectionRow label="Version" value={daemon()?.version ?? "-"} />
      <ConnectionRow
        label="Instance"
        value={daemon()?.instanceId ?? componentProps.daemonInfo.phase}
      />
      <ConnectionRow
        label="RPC"
        value={
          daemon() ? `${daemon()!.supportedProcIds.length} procedures` : "-"
        }
      />
    </FloatingMenu>
  );
}

function ConnectionRow(componentProps: { label: string; value: string }) {
  return (
    <div {...styles.popoverRow()}>
      <span {...styles.popoverLabel()}>{componentProps.label}</span>
      <span {...styles.popoverValue()}>{componentProps.value}</span>
    </div>
  );
}

function connectionDetail(
  connection: ConnectionState | undefined,
  daemonInfo: DaemonInfoState,
): string {
  if (connection?.phase === "reachable") {
    const rtt =
      connection.rttMs === undefined ? "live" : `${connection.rttMs} ms`;
    return daemonInfo.phase === "ready"
      ? `Daemon ready · ${rtt}`
      : `Transport ready · daemon ${daemonInfo.phase}`;
  }
  if (connection?.phase === "idle") return "Checking daemon availability";
  return "Daemon unavailable";
}

interface ToolTabTarget {
  paneId: string;
  tab: WorkbenchTab;
}

function tabTargetsForPanes(panes: WorkbenchPane[]): ToolTabTarget[] {
  return panes.flatMap((pane) =>
    pane.tabs.map((tab) => ({
      paneId: pane.id,
      tab,
    })),
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

function ToolIcon(props: { size: number; tool: WorkbenchTab["tool"] }) {
  const icons = {
    terminal: Terminal,
    windows: AppWindow,
    processes: Activity,
    files: Folder,
    daemon: Radio,
  };
  return (
    <Dynamic
      component={props.tool === "agent" ? Radio : icons[props.tool]}
      size={props.size}
    />
  );
}

function hasToolMenu(tool: WorkbenchTool): boolean {
  return tool === "files" || tool === "terminal";
}

function MachineIcon(componentProps: { name?: MachineIconName; size: number }) {
  const option = createMemo(
    () =>
      machineIconOptions.find(
        (item) => item.name === (componentProps.name ?? "monitor"),
      ) ?? machineIconOptions[0],
  );
  return <Dynamic component={option().icon} size={componentProps.size} />;
}

namespace styles {
  export const mobileMenuWidth = style({
    "@media (max-width: 680px)": {
      width: "252px",
    },
  });

  export const globalTopbar = style({
    gridColumn: "1",
    gridRow: "1",
    position: "relative",
    boxSizing: "border-box",
    height: "100%",
    minHeight: "0",
    minWidth: "0",
    display: "flex",
    flexDirection: "column",
    gap: "12px",
    overflow: "hidden",
    backgroundColor: "transparent",
    paddingTop: "14px",
    paddingBottom: "14px",
    paddingLeft: "12px",
    paddingRight: "0",
    color: theme.textSecondary,
    lineHeight: 1.45,
    "@media (max-width: 680px)": {
      gridColumn: "1",
      gridRow: "1",
      height: "100%",
      width: "100%",
      alignItems: "stretch",
      justifyContent: "flex-start",
      gap: "14px",
      overflowX: "hidden",
      overflowY: "auto",
      paddingLeft: "14px",
      paddingRight: "14px",
      paddingTop: "14px",
      paddingBottom: "14px",
    },
  });
  export const globalTopbarLeft = style({
    display: "grid",
    minWidth: "0",
  });
  export const globalTopbarCenter = style({
    pointerEvents: "none",
    display: "none",
    minWidth: "0",
  });
  export const globalTopbarRight = style({
    display: "grid",
    minWidth: "0",
    alignContent: "flex-start",
    gap: "12px",
  });
  export const topbarBrand = style({
    selectors: {
      "& img": {
        height: "23px",
        width: "23px",
      },
    },
    height: "34px",
    minWidth: "0",
    display: "inline-flex",
    alignItems: "center",
    gap: "8px",
    paddingLeft: "2px",
    paddingRight: "2px",
    fontSize: "13px",
    color: theme.textPrimary,
    fontWeight: 780,
  });
  export const topbarLeftDivider = style({
    display: "none",
  });
  export const globalIconButton = style({
    fontFamily: "inherit",
    boxSizing: "border-box",
    height: "28px",
    minHeight: "28px",
    minWidth: "28px",
    width: "28px",
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
        borderColor: "rgb(255 255 255 / 0.44)",
        backgroundColor: "rgb(255 255 255 / 0.36)",
        color: theme.textSecondary,
        opacity: 1,
      },
      "&:active": {
        backgroundColor: theme.bgActive,
      },
    },
    borderRadius: theme.radiusMd,
    backgroundColor: "transparent",
    padding: "0",
    color: theme.textTertiary,
    lineHeight: 1,
    opacity: 0.72,
    "@media (max-width: 680px)": {
      display: "none",
    },
  });
  export const toolSwitcher = style({
    display: "grid",
    minWidth: "0",
    width: "100%",
    alignContent: "flex-start",
    gap: "2px",
    borderWidth: "1px",
    borderColor: "rgb(255 255 255 / 0.34)",
    borderRadius: "14px",
    backgroundColor: "rgba(248, 248, 248, 0.28)",
    padding: "6px",
    boxShadow:
      "0 0 rgb(0 0 0 / 0), 0 0 rgb(0 0 0 / 0), inset 0 1px 0 rgba(255,255,255,0.68),0 8px 18px rgba(18,25,38,0.045)",
    WebkitBackdropFilter: "blur(40px)",
    backdropFilter: "blur(40px)",
    "@media (max-width: 680px)": {
      gap: "6px",
    },
  });
  export const toolSplit = style({
    transition:
      "background var(--rieul-duration-fast,100ms) var(--rieul-ease-out,cubic-bezier(0.16,1,0.3,1)),color var(--rieul-duration-fast,100ms) var(--rieul-ease-out,cubic-bezier(0.16,1,0.3,1)),border-color var(--rieul-duration-fast,100ms) var(--rieul-ease-out,cubic-bezier(0.16,1,0.3,1)),box-shadow var(--rieul-duration-fast,100ms) var(--rieul-ease-out,cubic-bezier(0.16,1,0.3,1))",
    height: "31px",
    minWidth: "0",
    width: "100%",
    display: "inline-flex",
    alignItems: "center",
    borderWidth: "1px",
    selectors: {
      "&.active": {
        borderColor: "rgb(255 255 255 / 0.74)",
        backgroundColor: "rgba(255, 255, 255, 0.72)",
        color: theme.textPrimary,
        boxShadow:
          "0 0 rgb(0 0 0 / 0), 0 0 rgb(0 0 0 / 0), 0 6px 14px rgba(20,30,46,0.095),inset 0 1px 0 rgba(255,255,255,0.86),inset 0 -1px 0 rgba(32,48,70,0.035)",
      },
      "&:hover": {
        backgroundColor: "rgb(255 255 255 / 0.2)",
        color: theme.textSecondary,
      },
    },
    borderColor: "transparent",
    borderRadius: "10px",
    fontSize: "12px",
    color: theme.textTertiary,
    fontWeight: 650,
    "@media (max-width: 680px)": {
      height: "42px",
      justifyContent: "flex-start",
    },
  });
  export const toolNameButton = style({
    transition:
      "background var(--rieul-duration-fast,100ms) var(--rieul-ease-out,cubic-bezier(0.16,1,0.3,1)),color var(--rieul-duration-fast,100ms) var(--rieul-ease-out,cubic-bezier(0.16,1,0.3,1)),border-color var(--rieul-duration-fast,100ms) var(--rieul-ease-out,cubic-bezier(0.16,1,0.3,1)),box-shadow var(--rieul-duration-fast,100ms) var(--rieul-ease-out,cubic-bezier(0.16,1,0.3,1))",
    fontFamily: "inherit",
    selectors: {
      "& span": {
        minWidth: "0",
        overflow: "hidden",
        textOverflow: "ellipsis",
        whiteSpace: "nowrap",
      },
      "& svg": {
        flex: "0 0 auto",
        opacity: 0.86,
      },
      "&:hover": {
        backgroundColor: "rgb(255 255 255 / 0.18)",
        color: theme.textPrimary,
      },
    },
    minWidth: "0",
    height: "29px",
    display: "inline-flex",
    flex: "1 1 0%",
    cursor: "pointer",
    WebkitAppearance: "none",
    appearance: "none",
    alignItems: "center",
    justifyContent: "flex-start",
    gap: "7px",
    borderWidth: "0px",
    borderRadius: "9px",
    backgroundColor: "transparent",
    paddingLeft: "8px",
    paddingRight: "8px",
    paddingTop: "0",
    paddingBottom: "0",
    color: "inherit",
    "@media (max-width: 680px)": {
      height: "100%",
      justifyContent: "flex-start",
      gap: "8px",
      paddingLeft: "9px",
      paddingRight: "9px",
    },
  });
  export const toolMenuButton = style({
    transition:
      "background var(--rieul-duration-fast,100ms) var(--rieul-ease-out,cubic-bezier(0.16,1,0.3,1)),color var(--rieul-duration-fast,100ms) var(--rieul-ease-out,cubic-bezier(0.16,1,0.3,1)),border-color var(--rieul-duration-fast,100ms) var(--rieul-ease-out,cubic-bezier(0.16,1,0.3,1)),box-shadow var(--rieul-duration-fast,100ms) var(--rieul-ease-out,cubic-bezier(0.16,1,0.3,1))",
    fontFamily: "inherit",
    height: "29px",
    minWidth: "28px",
    width: "28px",
    display: "inline-flex",
    cursor: "pointer",
    WebkitAppearance: "none",
    appearance: "none",
    alignItems: "center",
    justifyContent: "center",
    borderWidth: "0px",
    borderRadius: "9px",
    backgroundColor: "transparent",
    selectors: {
      "&:hover": {
        backgroundColor: "rgb(255 255 255 / 0.18)",
        color: theme.textPrimary,
        opacity: 1,
      },
      "&:focus-visible": {
        backgroundColor: "rgb(255 255 255 / 0.18)",
        color: theme.textPrimary,
        opacity: 1,
        outlineWidth: "0px",
      },
    },
    padding: "0",
    color: "inherit",
    opacity: 0.72,
    "@media (max-width: 680px)": {
      height: "100%",
    },
  });
  export const topbarMenu = style({
    borderWidth: "1px",
    borderColor: "rgb(255 255 255 / 0.42)",
    backgroundColor: theme.materialFloatingBg,
    boxShadow:
      "0 0 rgb(0 0 0 / 0), 0 0 rgb(0 0 0 / 0), 0 24px 70px rgb(18 25 38 / 22%),0 4px 16px rgb(18 25 38 / 10%),inset 0 1px 0 rgb(255 255 255 / 82%)",
    WebkitBackdropFilter: "blur(40px)",
    backdropFilter: "blur(40px)",
    zIndex: 60,
    width: "244px",
    gap: "2px",
    borderRadius: theme.radiusLg,
    padding: "4px",
    color: theme.textPrimary,
  });
  export const topbarMenuHeader = style({
    paddingLeft: "8px",
    paddingRight: "8px",
    paddingTop: "6px",
    paddingBottom: "6px",
    fontSize: "11px",
    color: theme.textTertiary,
    fontWeight: 740,
  });
  export const topbarMenuMeta = style({
    marginLeft: "auto",
    maxWidth: "92px",
    minWidth: "0",
    overflow: "hidden",
    textOverflow: "ellipsis",
    whiteSpace: "nowrap",
    fontSize: "12px",
    color: theme.textTertiary,
  });
  export const machineMenu = style({
    borderWidth: "1px",
    borderColor: "rgb(255 255 255 / 0.42)",
    backgroundColor: theme.materialFloatingBg,
    boxShadow:
      "0 0 rgb(0 0 0 / 0), 0 0 rgb(0 0 0 / 0), 0 24px 70px rgb(18 25 38 / 22%),0 4px 16px rgb(18 25 38 / 10%),inset 0 1px 0 rgb(255 255 255 / 82%)",
    WebkitBackdropFilter: "blur(40px)",
    backdropFilter: "blur(40px)",
    zIndex: 60,
    width: "216px",
    gap: "3px",
    borderRadius: theme.radiusLg,
    padding: "5px",
    color: theme.textPrimary,
  });
  export const machineMenuHeader = style({
    paddingLeft: "8px",
    paddingRight: "8px",
    paddingBottom: "5px",
    paddingTop: "6px",
    fontSize: "11px",
    color: theme.textTertiary,
    fontWeight: 760,
    letterSpacing: "0",
  });
  export const machineMenuDivider = style({
    marginLeft: "5px",
    marginRight: "5px",
    marginTop: "5px",
    marginBottom: "5px",
    height: "1px",
    backgroundColor: "rgba(18, 25, 38, 0.12)",
    boxShadow:
      "0 0 rgb(0 0 0 / 0), 0 0 rgb(0 0 0 / 0), 0 1px 0 rgba(255, 255, 255, 0.64)",
  });
  export const machineMenuDangerItem = style({
    selectors: {
      "&:hover": {
        backgroundColor: theme.dangerSoft,
        color: theme.danger,
      },
      "& svg": {
        color: theme.danger,
      },
    },
    color: theme.danger,
  });
  export const statusDot = style({
    height: "6px",
    width: "6px",
    borderRadius: "9999px",
  });
  export const railBrandActions = style({
    display: "inline-flex",
    alignItems: "center",
    gap: "4px",
  });
  export const railStatusButton = style({
    transition:
      "background var(--rieul-duration-fast,100ms) var(--rieul-ease-out,cubic-bezier(0.16,1,0.3,1)),color var(--rieul-duration-fast,100ms) var(--rieul-ease-out,cubic-bezier(0.16,1,0.3,1)),border-color var(--rieul-duration-fast,100ms) var(--rieul-ease-out,cubic-bezier(0.16,1,0.3,1)),box-shadow var(--rieul-duration-fast,100ms) var(--rieul-ease-out,cubic-bezier(0.16,1,0.3,1))",
    fontFamily: "inherit",
    height: "28px",
    minWidth: "22px",
    display: "inline-flex",
    selectors: {
      "&:disabled": {
        cursor: "default",
        opacity: 0.45,
      },
      "&:hover": {
        borderColor: "rgb(255 255 255 / 0.44)",
        backgroundColor: "rgb(255 255 255 / 0.36)",
        opacity: 1,
      },
    },
    cursor: "pointer",
    WebkitAppearance: "none",
    appearance: "none",
    alignItems: "center",
    justifyContent: "center",
    borderWidth: "1px",
    borderColor: "transparent",
    borderRadius: theme.radiusMd,
    backgroundColor: "transparent",
    padding: "0",
    opacity: 0.82,
  });
  export const connectionPopover = style({
    borderWidth: "1px",
    borderColor: "rgb(255 255 255 / 0.42)",
    backgroundColor: theme.materialFloatingBg,
    boxShadow:
      "0 0 rgb(0 0 0 / 0), 0 0 rgb(0 0 0 / 0), 0 24px 70px rgb(18 25 38 / 22%),0 4px 16px rgb(18 25 38 / 10%),inset 0 1px 0 rgb(255 255 255 / 82%)",
    WebkitBackdropFilter: "blur(40px)",
    backdropFilter: "blur(40px)",
    zIndex: 60,
    width: "320px",
    gap: "0",
    borderRadius: theme.radiusXl,
    padding: "0",
    color: theme.textPrimary,
  });
  export const popoverHeader = style({
    display: "grid",
    gap: "8px",
    borderBottomWidth: "1px",
    borderBottomColor: "rgb(0 0 0 / 0.06)",
    paddingLeft: "12px",
    paddingRight: "12px",
    paddingTop: "11px",
    paddingBottom: "11px",
  });
  export const popoverTitle = style({
    minWidth: "0",
    display: "flex",
    alignItems: "center",
    gap: "8px",
    fontSize: "13px",
    fontWeight: 760,
  });
  export const popoverMeta = style({
    minWidth: "0",
    overflow: "hidden",
    textOverflow: "ellipsis",
    whiteSpace: "nowrap",
    fontSize: "12px",
    color: theme.textTertiary,
    fontWeight: 650,
  });
  export const popoverRow = style({
    display: "grid",
    gridTemplateColumns: "92px minmax(0,1fr)",
    minHeight: "32px",
    alignItems: "center",
    gap: "10px",
    borderBottomWidth: "1px",
    selectors: {
      "&:last-child": {
        borderBottomWidth: "0px",
      },
    },
    borderBottomColor: "rgb(0 0 0 / 0.05)",
    paddingLeft: "12px",
    paddingRight: "12px",
    fontSize: "12px",
  });
  export const popoverLabel = style({
    color: theme.textTertiary,
    fontWeight: 650,
  });
  export const popoverValue = style({
    minWidth: "0",
    overflow: "hidden",
    textOverflow: "ellipsis",
    whiteSpace: "nowrap",
    textAlign: "right",
    color: theme.textSecondary,
    fontWeight: 720,
  });
  export const railBrandRow = style({
    minWidth: "0",
    display: "flex",
    alignItems: "center",
    justifyContent: "space-between",
    gap: "6px",
  });
  export const railMachineName = style({
    minWidth: "0",
    flex: "1 1 0%",
    overflow: "hidden",
    textOverflow: "ellipsis",
    whiteSpace: "nowrap",
    fontSize: "13px",
    color: theme.textSecondary,
    fontWeight: 720,
  });
  export const railMachineList = style({
    display: "grid",
    gridTemplateColumns: "repeat(auto-fill,38px)",
    minWidth: "0",
    justifyContent: "flex-start",
    gap: "7px",
    borderWidth: "1px",
    borderColor: "rgb(255 255 255 / 0.28)",
    borderRadius: "15px",
    backgroundColor: "rgba(248, 248, 248, 0.28)",
    padding: "7px",
    WebkitBackdropFilter: "blur(24px)",
    backdropFilter: "blur(24px)",
    "@media (max-width: 680px)": {
      gridTemplateColumns: "repeat(auto-fill,48px)",
      gap: "8px",
      padding: "8px",
    },
  });
  export const railMachineButton = style({
    transition:
      "background var(--rieul-duration-fast,100ms) var(--rieul-ease-out,cubic-bezier(0.16,1,0.3,1)),color var(--rieul-duration-fast,100ms) var(--rieul-ease-out,cubic-bezier(0.16,1,0.3,1)),border-color var(--rieul-duration-fast,100ms) var(--rieul-ease-out,cubic-bezier(0.16,1,0.3,1)),box-shadow var(--rieul-duration-fast,100ms) var(--rieul-ease-out,cubic-bezier(0.16,1,0.3,1))",
    selectors: {
      "& svg": {
        strokeWidth: 2,
      },
      "&.active": {
        borderColor: "rgb(255 255 255 / 0.74)",
        backgroundColor: "rgb(255 255 255 / 0.7)",
        color: theme.textPrimary,
        boxShadow:
          "0 0 rgb(0 0 0 / 0), 0 0 rgb(0 0 0 / 0), inset 0 1px 0 rgba(255,255,255,0.86),0 6px 16px rgba(18,25,38,0.08)",
      },
      "&:hover": {
        borderColor: "rgb(255 255 255 / 0.48)",
        backgroundColor: "rgb(255 255 255 / 0.34)",
        color: theme.textSecondary,
      },
    },
    fontFamily: "inherit",
    position: "relative",
    height: "38px",
    minWidth: "38px",
    width: "38px",
    display: "inline-flex",
    cursor: "pointer",
    WebkitAppearance: "none",
    appearance: "none",
    alignItems: "center",
    justifyContent: "center",
    borderWidth: "1px",
    borderColor: "transparent",
    borderRadius: "12px",
    backgroundColor: "rgb(255 255 255 / 0.18)",
    paddingLeft: "0",
    paddingRight: "0",
    fontSize: "12px",
    color: theme.textTertiary,
    fontWeight: 650,
    "@media (max-width: 680px)": {
      height: "48px",
      minWidth: "48px",
      width: "48px",
    },
  });
  export const railAddMachineButton = style({
    transition:
      "background var(--rieul-duration-fast,100ms) var(--rieul-ease-out,cubic-bezier(0.16,1,0.3,1)),color var(--rieul-duration-fast,100ms) var(--rieul-ease-out,cubic-bezier(0.16,1,0.3,1)),border-color var(--rieul-duration-fast,100ms) var(--rieul-ease-out,cubic-bezier(0.16,1,0.3,1)),box-shadow var(--rieul-duration-fast,100ms) var(--rieul-ease-out,cubic-bezier(0.16,1,0.3,1))",
    fontFamily: "inherit",
    height: "38px",
    minWidth: "38px",
    width: "38px",
    display: "inline-flex",
    cursor: "pointer",
    WebkitAppearance: "none",
    appearance: "none",
    alignItems: "center",
    justifyContent: "center",
    borderWidth: "1px",
    borderColor: "rgb(255 255 255 / 0.34)",
    selectors: {
      "&:hover": {
        borderColor: "rgb(255 255 255 / 0.48)",
        backgroundColor: "rgb(255 255 255 / 0.34)",
        color: theme.textPrimary,
      },
    },
    borderRadius: "12px",
    borderStyle: "dashed",
    backgroundColor: "rgb(255 255 255 / 0.1)",
    paddingLeft: "0",
    paddingRight: "0",
    color: theme.textTertiary,
    "@media (max-width: 680px)": {
      marginTop: "0",
      selectors: {
        "& span": {
          display: "none",
        },
      },
      height: "44px",
      minWidth: "44px",
      width: "44px",
      borderRadius: "14px",
      paddingLeft: "0",
      paddingRight: "0",
      color: theme.textSecondary,
    },
  });
  export const mobileMachineButton = style({
    transition:
      "background var(--rieul-duration-fast,100ms) var(--rieul-ease-out,cubic-bezier(0.16,1,0.3,1)),color var(--rieul-duration-fast,100ms) var(--rieul-ease-out,cubic-bezier(0.16,1,0.3,1)),border-color var(--rieul-duration-fast,100ms) var(--rieul-ease-out,cubic-bezier(0.16,1,0.3,1)),box-shadow var(--rieul-duration-fast,100ms) var(--rieul-ease-out,cubic-bezier(0.16,1,0.3,1))",
    fontFamily: "inherit",
    position: "relative",
    display: "none",
    height: "44px",
    minWidth: "44px",
    width: "44px",
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
        backgroundColor: "rgb(255 255 255 / 0.34)",
        color: theme.textPrimary,
      },
    },
    borderRadius: "14px",
    backgroundColor: "rgb(255 255 255 / 0.18)",
    padding: "0",
    color: theme.textSecondary,
  });
  export const railMachineIconDot = style({
    position: "absolute",
    bottom: "5px",
    right: "5px",
    height: "5px",
    width: "5px",
    borderRadius: "9999px",
    selectors: {
      ".group.active &": {
        backgroundColor: theme.accent,
      },
    },
    backgroundColor: theme.textTertiary,
  });
  export const iconPickerMenu = style({
    display: "grid",
    gridTemplateColumns: "repeat(4,minmax(0,1fr))",
    gap: "5px",
    paddingLeft: "5px",
    paddingRight: "5px",
    paddingBottom: "2px",
  });
  export const iconPickerItem = style({
    height: "38px !important",
    minHeight: "38px !important",
    justifyContent: "center !important",
    borderRadius: "var(--rieul-radius-md) !important",
    paddingLeft: "0 !important",
    paddingRight: "0 !important",
  });
  export const span = style({
    backgroundColor: theme.success,
  });
  export const span2 = style({
    backgroundColor: theme.warning,
  });
  export const span3 = style({
    backgroundColor: theme.danger,
  });
  export const checkCircle2 = style({
    color: theme.success,
  });
  export const radio = style({
    color: theme.textTertiary,
  });
}
