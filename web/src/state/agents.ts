import {
  createSignal,
  createMemo,
  createEffect,
  createRoot,
  getOwner,
  runWithOwner,
  untrack,
} from "solid-js";
import { bunja } from "bunja";
import {
  createAgentProject,
  createAgentSession,
  listAgentSessions,
  subscribeAgentProjects,
  subscribeAgentProviders,
  updateAgentSession,
} from "../protocol/generated/client.ts";
import {
  type AgentProjectInfo,
  type AgentProjectsTableEvent,
  AgentProviderAvailability,
  type AgentProviderInfo,
  type AgentProvidersTableEvent,
  AgentSessionArchiveFilter,
  type AgentSessionInfo,
  type AgentSessionSummary,
  type CreateAgentWorkspace,
} from "../protocol/generated/rpc.ts";
import { machineBunja } from "./machine-store.ts";
import type { Machine } from "./machines.ts";
export type AgentCatalogPhase = "idle" | "loading" | "ready" | "error";
export function agentSessionTitle(
  session: Pick<AgentSessionSummary, "title" | "lastMessagePreview">,
): string {
  return session.title ?? session.lastMessagePreview ?? "New session";
}
import { rpcSessionBunja } from "./rpc-session.ts";
export const agentsBunja = bunja(() => {
  const machineState = bunja.use(machineBunja);
  const rpcSession = bunja.use(rpcSessionBunja);
  const [providers, setProviders] = createSignal<AgentProviderInfo[]>([]);
  const [projects, setProjects] = createSignal<AgentProjectInfo[]>([]);
  const [sessions, setSessions] = createSignal<AgentSessionSummary[]>([]);
  const [phase, setPhase] = createSignal<AgentCatalogPhase>("idle");
  const [error, setError] = createSignal<string | undefined>(undefined);
  const availableProviders = createMemo(() =>
    providers().filter(
      (provider) =>
        provider.availability === AgentProviderAvailability.Available,
    ),
  );
  const subscriptionKey = createMemo(() =>
    agentSubscriptionKey(
      machineState.machine(),
      machineState.isPaired(),
      rpcSession.daemonInstanceId(),
    ),
  );
  let refreshVersion = 0;
  let lifetime = 0;
  let active = false;
  const isCurrent = (version: number) => active && version === lifetime;
  const owner = getOwner();
  bunja.effect(() => {
    active = true;
    let stopCurrent: (() => void) | undefined;
    function start() {
      stopCurrent?.();
      stopCurrent = undefined;
      refreshVersion += 1;
      lifetime += 1;
      setProviders([]);
      setProjects([]);
      setSessions([]);
      setError(undefined);
      const machine = untrack(machineState.machine);
      const paired = untrack(machineState.isPaired);
      const daemonInstanceId = untrack(rpcSession.daemonInstanceId);
      if (!machine || !paired || !daemonInstanceId) {
        setPhase("idle");
        return;
      }
      setPhase("loading");
      let cancelled = false;
      let providerStream: AsyncGenerator<AgentProvidersTableEvent> | undefined;
      let projectStream: AsyncGenerator<AgentProjectsTableEvent> | undefined;
      stopCurrent = () => {
        cancelled = true;
        void providerStream?.return(undefined);
        void projectStream?.return(undefined);
      };
      void (async () => {
        try {
          const transport = await rpcSession.webTransport();
          if (cancelled) return;
          providerStream = subscribeAgentProviders(transport);
          for await (const event of providerStream) {
            if (cancelled) break;
            setProviders((current) => applyProviderEvent(current, event));
          }
        } catch (error) {
          if (!cancelled) reportError(error);
        }
      })();
      void (async () => {
        try {
          const transport = await rpcSession.webTransport();
          if (cancelled) return;
          projectStream = subscribeAgentProjects(transport);
          for await (const event of projectStream) {
            if (cancelled) break;
            setProjects((current) => applyProjectEvent(current, event));
          }
        } catch (error) {
          if (!cancelled) reportError(error);
        }
      })();
      void refreshSessions();
    }
    const dispose = runWithOwner(owner, () =>
      createRoot((dispose) => {
        createEffect(subscriptionKey, () => start());
        return dispose;
      }),
    );
    return () => {
      active = false;
      lifetime += 1;
      refreshVersion += 1;
      dispose();
      stopCurrent?.();
    };
  });
  async function refreshSessions() {
    const version = ++refreshVersion;
    const generation = lifetime;
    try {
      const response = await listAgentSessions(
        await rpcSession.webTransport(),
        {
          archived: AgentSessionArchiveFilter.ActiveOnly,
          limit: 100,
          workspace: { type: "any" },
        },
      );
      if (!isCurrent(generation) || version !== refreshVersion) return;
      setSessions(response.rows);
      setError(undefined);
      setPhase("ready");
    } catch (error) {
      if (isCurrent(generation) && version === refreshVersion) {
        reportError(error);
      }
    }
  }
  async function addProject(rootPath: string): Promise<AgentProjectInfo> {
    const generation = lifetime;
    const project = await createAgentProject(await rpcSession.webTransport(), {
      rootPath,
    });
    if (!isCurrent(generation)) return project;
    setProjects((current) =>
      upsertById(current, project, (item) => item.projectId),
    );
    return project;
  }
  async function addSession(
    providerId: string,
    workspace: CreateAgentWorkspace,
  ): Promise<AgentSessionInfo> {
    const generation = lifetime;
    const session = await createAgentSession(await rpcSession.webTransport(), {
      creationRequestId: crypto.randomUUID(),
      providerId,
      workspace,
    });
    if (!isCurrent(generation)) return session;
    setSessions((current) =>
      upsertById(current, session.summary, (item) => item.sessionId),
    );
    return session;
  }
  async function archiveSession(sessionId: string): Promise<AgentSessionInfo> {
    const generation = lifetime;
    const session = await updateAgentSession(await rpcSession.webTransport(), {
      archived: true,
      sessionId,
    });
    if (!isCurrent(generation)) return session;
    setSessions((current) =>
      current.filter((item) => item.sessionId !== sessionId),
    );
    return session;
  }
  function reportError(error: unknown) {
    setError(error instanceof Error ? error.message : String(error));
    setPhase("error");
  }
  return {
    addProject,
    addSession,
    archiveSession,
    availableProviders,
    error,
    phase,
    projects,
    providers,
    refreshSessions,
    sessions,
  };
});
function agentSubscriptionKey(
  machine: Machine | undefined,
  selectedIsPaired: boolean,
  daemonInstanceId: string | undefined,
): string {
  if (!machine || !selectedIsPaired || !daemonInstanceId) return "idle";
  return [
    machine.id,
    machine.baseUrl,
    machine.clientId ?? "",
    machine.clientSecret ?? "",
    daemonInstanceId,
  ].join("\n");
}
function applyProviderEvent(
  current: AgentProviderInfo[],
  event: AgentProvidersTableEvent,
): AgentProviderInfo[] {
  return event.type === "snapshot"
    ? event.rows
    : applyPatch(
        current,
        event.removes,
        event.upserts,
        (item) => item.providerId,
      );
}
function applyProjectEvent(
  current: AgentProjectInfo[],
  event: AgentProjectsTableEvent,
): AgentProjectInfo[] {
  return event.type === "snapshot"
    ? event.rows
    : applyPatch(
        current,
        event.removes,
        event.upserts,
        (item) => item.projectId,
      );
}
function applyPatch<T>(
  current: T[],
  removes: string[],
  upserts: T[],
  id: (item: T) => string,
): T[] {
  const removed = new Set(removes);
  const next = current.filter((item) => !removed.has(id(item)));
  for (const item of upserts) {
    const index = next.findIndex((currentItem) => id(currentItem) === id(item));
    if (index < 0) next.push(item);
    else next[index] = item;
  }
  return next;
}
function upsertById<T>(current: T[], item: T, id: (item: T) => string): T[] {
  const itemId = id(item);
  const index = current.findIndex((currentItem) => id(currentItem) === itemId);
  if (index < 0) return [item, ...current];
  return current.map((currentItem, currentIndex) =>
    currentIndex === index ? item : currentItem,
  );
}
