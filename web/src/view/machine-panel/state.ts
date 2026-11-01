import { latest } from "solid-js";
import { bunja } from "bunja";
import type { AvailableShellInfo } from "../../protocol/generated/rpc.ts";
import { machineMenuBunja } from "../../state/machine-menu.ts";
import { machineStoreBunja } from "../../state/machine-store.ts";
import type { Machine } from "../../state/machines.ts";
import { rpcSessionBunja } from "../../state/rpc-session.ts";
import { terminalShellsBunja } from "../../state/terminal-shells.ts";
import {
  workbenchBunja,
  type WorkbenchFilesView,
} from "../../state/workbench.ts";
import { layoutBunja } from "../state.tsx";

const machineMenuWidth = 176;

export const machinePanelBunja = bunja(() => {
  const layout = bunja.use(layoutBunja);
  const machineStore = bunja.use(machineStoreBunja);
  const machineMenu = bunja.use(machineMenuBunja);
  const rpcSession = bunja.use(rpcSessionBunja);
  const terminalShells = bunja.use(terminalShellsBunja);
  const workbench = bunja.use(workbenchBunja);

  function openMachineTitleMenu(
    event: MouseEvent & { currentTarget: HTMLButtonElement },
    machine: Machine,
  ) {
    event.preventDefault();
    event.stopPropagation();
    if (latest(machineMenu.machineMenu)?.machineId === machine.id) {
      machineMenu.closeMachineMenu();
      return;
    }
    const rect = event.currentTarget.getBoundingClientRect();
    machineMenu.openMachineMenu(
      machine.id,
      rect.right - machineMenuWidth,
      rect.bottom,
    );
  }

  function openTerminalShell(shell?: AvailableShellInfo) {
    const selectedShell = shell ?? latest(terminalShells.defaultShell);
    if (!selectedShell) return;
    workbench.openTerminalTab({
      launch: {
        command: selectedShell.command,
        args: selectedShell.args,
      },
      title: selectedShell.name,
    });
  }

  function openFilesView(filesView: WorkbenchFilesView) {
    workbench.openFilesTab({ filesView });
  }

  return {
    activeTool: workbench.activeTool,
    connection: rpcSession.connection,
    machine: machineStore.selected,
    machinePanelCollapsed: layout.machinePanelCollapsed,
    machinePanelMaxWidth: layout.machinePanelMaxWidth,
    machinePanelMinWidth: layout.machinePanelMinWidth,
    machinePanelWidth: layout.machinePanelWidth,
    openMachineTitleMenu,
    openFilesView,
    openTerminalShell,
    resizeMachinePanelWithKeyboard: layout.resizeMachinePanelWithKeyboard,
    selectTool: workbench.selectTool,
    startMachinePanelResize: layout.startMachinePanelResize,
    defaultShell: terminalShells.defaultShell,
    terminalShells: terminalShells.terminalShells,
  };
});
