import { flush } from "solid-js";
import { useBunja } from "../../solid/bunja.tsx";

import { machineModalBunja } from "../../state/machine-modal.ts";
import { machineStoreBunja } from "../../state/machine-store.ts";
import { rpcSessionBunja } from "../../state/rpc-session.ts";
import { terminalShellsBunja } from "../../state/terminal-shells.ts";
import { workbenchBunja } from "../../state/workbench.ts";
import { machinePanelBunja } from "../machine-panel/state.ts";
import { layoutBunja } from "../state.tsx";
import { AgentRail } from "./agent-rail.tsx";
import { AppTopbar } from "./app-topbar.tsx";

export function TopBarRegion() {
  const layout = useBunja(layoutBunja);
  const machineStore = useBunja(machineStoreBunja);
  const machinePanel = useBunja(machinePanelBunja);
  const machineModal = useBunja(machineModalBunja);
  const rpcSession = useBunja(rpcSessionBunja);
  const terminalShellsState = useBunja(terminalShellsBunja);
  const workbench = useBunja(workbenchBunja);
  const selected = () => machineStore().selected();
  const machines = () => machineStore().machines();
  const selectedId = () => machineStore().selectedId();
  const connection = () => machinePanel().connection();
  const daemonInfo = () => rpcSession().daemonInfo();
  const activeTool = () => workbench().activeTool();
  const panes = () => workbench().panes();
  const terminalShells = () => terminalShellsState().terminalShells();
  const machinePanelCollapsed = () => layout().machinePanelCollapsed();

  function reconnectMachine(machineId: string) {
    machineStore().selectMachine(machineId);
    // Resolve the RPC scope after the selected machine has committed.
    flush();
    void rpcSession().reconnect();
  }

  function configureMachine(machineId: string) {
    machineModal().openConfigMachineModal(machineId);
  }

  function unpairMachine(machineId: string) {
    machineStore().clearMachineCredentials(machineId);
    machineStore().selectMachine(machineId);
    flush();
    rpcSession().resetController();
  }

  function deleteMachine(machineId: string) {
    machineModal().openDeleteMachineModal(machineId);
  }

  function addMachine() {
    machineModal().openAddMachineModal();
  }

  return (
    <AppTopbar
      connection={connection()}
      daemonInfo={daemonInfo()}
      agentRail={<AgentRail />}
      activeTool={activeTool()}
      machine={selected()}
      machinePanelCollapsed={machinePanelCollapsed()}
      machines={machines()}
      panes={panes()}
      selectedMachineId={selectedId()}
      terminalShells={terminalShells()}
      onAddMachine={addMachine}
      onOpenAgentTab={(event) => workbench().openAgentTab(event)}
      onOpenDaemonTab={() => workbench().openDaemonTab()}
      onOpenFilesTab={(event) => workbench().openFilesTab(event)}
      onOpenProcessesTab={() => workbench().openProcessesTab()}
      onOpenTerminalTab={(event) => workbench().openTerminalTab(event)}
      onOpenWindowsTab={() => workbench().openWindowsTab()}
      onSelectTab={(paneId, tabId) => workbench().selectTab(paneId, tabId)}
      onConfigureMachine={configureMachine}
      onDeleteMachine={deleteMachine}
      onReconnectMachine={reconnectMachine}
      onSelectMachine={(event) => machineStore().selectMachine(event)}
      onToggleMachinePanel={() => layout().toggleMachinePanel()}
      onUnpairMachine={unpairMachine}
      onUpdateMachineIcon={(machineId, icon) =>
        machineStore().updateMachine(machineId, (machine) => ({
          ...machine,
          icon,
        }))
      }
    />
  );
}
