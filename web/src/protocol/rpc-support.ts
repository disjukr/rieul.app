import { ProcId, procs } from "./generated/rpc.ts";

export const rpcCategories = [
  { id: "screen", label: "Screen" },
  { id: "files", label: "Files" },
  { id: "terminal", label: "Terminal" },
  { id: "processes", label: "Processes & windows" },
  { id: "commands", label: "Commands & jobs" },
  { id: "schedules", label: "Schedules" },
  { id: "agents", label: "Agents" },
  { id: "updates", label: "Updates" },
  { id: "daemon", label: "Daemon & clients" },
] as const;
type CategoryId = (typeof rpcCategories)[number]["id"];

// Explicit, exhaustive mapping: adding a schema procedure requires choosing
// its category. Retired/unknown IDs never inflate a current category's total.
export const rpcCategoryById: Record<ProcId, CategoryId> = {
  [ProcId.GetDaemonInfo]: "daemon",
  [ProcId.StartPairing]: "daemon",
  [ProcId.CompletePairing]: "daemon",
  [ProcId.RenewClientCredential]: "daemon",
  [ProcId.SubscribeRoots]: "files",
  [ProcId.SubscribeDirectory]: "files",
  [ProcId.ReadFile]: "files",
  [ProcId.WriteFile]: "files",
  [ProcId.CreateNodes]: "files",
  [ProcId.RenamePaths]: "files",
  [ProcId.DeletePaths]: "files",
  [ProcId.CreateTerminalSession]: "terminal",
  [ProcId.SubscribeTerminalSessions]: "terminal",
  [ProcId.SubscribeAvailableShells]: "terminal",
  [ProcId.AttachTerminalSession]: "terminal",
  [ProcId.TakeTerminalControl]: "terminal",
  [ProcId.WriteTerminalInput]: "terminal",
  [ProcId.CloseTerminalSession]: "terminal",
  [ProcId.SubscribeClients]: "daemon",
  [ProcId.SubscribeTrashItems]: "files",
  [ProcId.RestoreTrashItems]: "files",
  [ProcId.PurgeTrashItems]: "files",
  [ProcId.GetDaemonEnvironment]: "daemon",
  [ProcId.SubscribeProcesses]: "processes",
  [ProcId.SubscribeProcessDetail]: "processes",
  [ProcId.SubscribeWindows]: "processes",
  [ProcId.SubscribeWindowDetail]: "processes",
  [ProcId.SubscribeProcessResourcesInUse]: "processes",
  [ProcId.SubscribeProcessSocketsInUse]: "processes",
  [ProcId.SubscribeProcessModules]: "processes",
  [ProcId.RunCommand]: "commands",
  [ProcId.CreateJob]: "commands",
  [ProcId.SubscribeJobs]: "commands",
  [ProcId.SubscribeJobOutput]: "commands",
  [ProcId.KillJob]: "commands",
  [ProcId.DeleteJobs]: "commands",
  [ProcId.ClearJobs]: "commands",
  [ProcId.CreateSchedule]: "schedules",
  [ProcId.UpdateSchedule]: "schedules",
  [ProcId.SubscribeSchedules]: "schedules",
  [ProcId.DeleteSchedules]: "schedules",
  [ProcId.GetScheduleNextRuns]: "schedules",
  [ProcId.RemoveClient]: "daemon",
  [ProcId.KillProcess]: "processes",
  [ProcId.SubscribeAgentProviders]: "agents",
  [ProcId.CreateAgentProject]: "agents",
  [ProcId.SubscribeAgentProjects]: "agents",
  [ProcId.ListAgentSessions]: "agents",
  [ProcId.SubscribeAgentSessionCatalog]: "agents",
  [ProcId.SubscribeActiveAgentSessions]: "agents",
  [ProcId.CreateAgentSession]: "agents",
  [ProcId.SubscribeAgentSession]: "agents",
  [ProcId.CreateAgentTurn]: "agents",
  [ProcId.CancelAgentTurn]: "agents",
  [ProcId.RespondAgentPermission]: "agents",
  [ProcId.SetAgentSessionConfig]: "agents",
  [ProcId.UpdateAgentSession]: "agents",
  [ProcId.CloseAgentSession]: "agents",
  [ProcId.DeleteAgentSession]: "agents",
  [ProcId.RemoveAgentProject]: "agents",
  [ProcId.ListAgentSessionTurns]: "agents",
  [ProcId.ReadAgentTerminalOutput]: "agents",
  [ProcId.AttachAgentSession]: "agents",
  [ProcId.GetDesktopCapabilities]: "screen",
  [ProcId.AttachDesktop]: "screen",
  [ProcId.ConfigureDesktopViewports]: "screen",
  [ProcId.SetDesktopControl]: "screen",
  [ProcId.RenewDesktopLease]: "screen",
  [ProcId.DetachDesktop]: "screen",
  [ProcId.WriteDesktopInput]: "screen",
  [ProcId.SubscribeUpdateStatus]: "updates",
  [ProcId.CheckForUpdates]: "updates",
  [ProcId.InstallUpdateConfirmed]: "updates",
  [ProcId.GetClusterState]: "daemon",
  [ProcId.GetClusterRemovalProof]: "daemon",
  [ProcId.GetClusterRevocationIssues]: "daemon",
  [ProcId.LeaveCluster]: "daemon",
  [ProcId.CreateCluster]: "daemon",
  [ProcId.PrepareClusterJoin]: "daemon",
  [ProcId.AdmitClusterMember]: "daemon",
  [ProcId.FinishClusterJoin]: "daemon",
  [ProcId.CancelClusterJoin]: "daemon",
  [ProcId.RemoveClusterMember]: "daemon",
  [ProcId.ReadClusterHistory]: "daemon",
  [ProcId.PreparePrimaryTransfer]: "daemon",
  [ProcId.SealPrimaryTransfer]: "daemon",
  [ProcId.ActivateClusterPrimary]: "daemon",
  [ProcId.ApplyClusterHistory]: "daemon",
  [ProcId.BeginClusterClientAdoption]: "daemon",
  [ProcId.CompleteClusterClientAdoption]: "daemon",
  [ProcId.GetClusterClientAdoption]: "daemon",
  [ProcId.AdoptClusterClient]: "daemon",
  [ProcId.RevokeClusterClientGrant]: "daemon",
  [ProcId.GetClusterPeerChallenge]: "daemon",
  [ProcId.ExecuteClusterPeerRequest]: "daemon",
};
export function summarizeRpcSupport(supportedProcIds?: readonly number[]) {
  const known = supportedProcIds !== undefined;
  const supported = new Set(
    supportedProcIds?.filter((id) => Number.isSafeInteger(id) && id > 0),
  );
  const procedures = Object.values(procs).sort((a, b) => a.id - b.id);
  const currentIds = new Set<number>(procedures.map((proc) => proc.id));
  const categories = rpcCategories.map((category) => {
    const entries = procedures
      .filter((proc) => rpcCategoryById[proc.id] === category.id)
      .map((proc) => ({
        id: proc.id,
        name: proc.name,
        supported: known ? supported.has(proc.id) : undefined,
      }));
    const count = known
      ? entries.filter((entry) => entry.supported).length
      : undefined;
    return {
      ...category,
      entries,
      total: entries.length,
      supported: count,
      unsupported: count === undefined ? undefined : entries.length - count,
      percent:
        count === undefined || entries.length === 0
          ? undefined
          : Math.round((count / entries.length) * 100),
    };
  });
  return {
    known,
    categories,
    unknownIds: [...supported]
      .filter((id) => !currentIds.has(id))
      .sort((a, b) => a - b),
  };
}
