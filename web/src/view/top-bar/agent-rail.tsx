import { createMemo, createSignal } from "solid-js";

import type {
  AgentSessionSummary,
  CreateAgentWorkspace,
} from "../../protocol/generated/rpc.ts";
import { useBunja } from "../../solid/bunja.tsx";
import {
  Archive,
  Check,
  ChevronRight,
  FolderKanban,
  LoaderCircle,
  Plus,
  RefreshCw,
  X,
} from "../../solid/icons.tsx";
import { useAtomValue } from "../../solid/jotai.tsx";
import { agentsBunja, agentSessionTitle } from "../../state/agents.ts";
import {
  type WorkbenchAgentTabConfig,
  workbenchBunja,
} from "../../state/workbench.ts";
import { className } from "../class-name.ts";

const railClassName = [
  "app-rail-expanded mt-auto min-h-0 flex-1 flex-col gap-[9px] overflow-hidden",
  "rounded-[14px] border border-white/34 bg-[rgba(248,248,248,0.28)] p-[7px]",
  "shadow-[inset_0_1px_0_rgba(255,255,255,0.68),0_8px_18px_rgba(18,25,38,0.045)]",
  "backdrop-blur-2xl max-[680px]:min-h-[280px]",
].join(" ");
const sectionClassName = "grid min-h-0 gap-[4px]";
const sessionsSectionClassName =
  "grid min-h-[96px] flex-1 grid-rows-[auto_minmax(0,1fr)] gap-[4px]";
const headerClassName =
  "flex h-[24px] min-w-0 items-center gap-[6px] px-[4px] text-[11px] font-760 text-rieul-text-3";
const headerActionsClassName = "ml-auto flex items-center gap-[2px]";
const iconButtonClassName = [
  "inline-flex h-[22px] w-[22px] appearance-none items-center justify-center",
  "rounded-[7px] border-0 bg-transparent p-0 text-rieul-text-3",
  "cursor-pointer hover:bg-white/42 hover:text-rieul-text disabled:cursor-default disabled:opacity-40",
].join(" ");
const listClassName =
  "mx-[-8px] grid min-h-0 content-start gap-[2px] overflow-x-hidden overflow-y-auto px-[8px] pb-[14px] pt-[4px] [scrollbar-width:thin]";
const itemButtonClassName = [
  "group flex min-h-[31px] w-full min-w-0 appearance-none items-center gap-[7px]",
  "rounded-[9px] border border-transparent bg-transparent px-[7px] py-[5px]",
  "text-left text-[11px] text-rieul-text-2 [font-family:inherit]",
  "cursor-pointer hover:border-white/52 hover:bg-white/42",
  "[&.active]:border-white/68 [&.active]:bg-white/62 [&.active]:text-rieul-text",
].join(" ");
const itemTitleClassName =
  "min-w-0 flex-1 overflow-hidden text-ellipsis whitespace-nowrap font-680";
const nestedItemButtonClassName = "ml-[14px] !w-[calc(100%_-_14px)]";
const sessionItemClassName = [
  "group relative flex h-[31px] w-full min-w-0 items-center rounded-[10px]",
  "border border-transparent text-[11px] font-650 text-rieul-text-3/68",
  "rieul-transition hover:bg-white/20 hover:text-rieul-text-2",
  "[&.active]:border-white/74 [&.active]:bg-[rgba(255,255,255,0.72)] [&.active]:text-rieul-text",
  "[&.active]:shadow-[0_6px_14px_rgba(20,30,46,0.095),inset_0_1px_0_rgba(255,255,255,0.86),inset_0_-1px_0_rgba(32,48,70,0.035)]",
].join(" ");
const sessionOpenButtonClassName = [
  "inline-flex h-[29px] min-w-0 flex-1 appearance-none items-center",
  "rounded-[9px] border-0 bg-transparent py-0 pl-[8px] pr-[34px]",
  "cursor-pointer text-left text-inherit [font-family:inherit] rieul-transition",
  "hover:bg-white/18 hover:text-rieul-text",
].join(" ");
const sessionArchiveButtonClassName = [
  "absolute right-0 top-0 inline-flex h-[29px] w-[28px] appearance-none items-center justify-center",
  "rounded-[9px] border-0 bg-transparent p-0 text-inherit [font-family:inherit]",
  "pointer-events-none cursor-pointer opacity-0 rieul-transition",
  "group-hover:pointer-events-auto group-hover:opacity-72 group-focus-within:pointer-events-auto group-focus-within:opacity-72",
  "hover:!bg-white/28 hover:!text-rieul-text hover:!opacity-100",
  "disabled:cursor-default disabled:opacity-45",
].join(" ");
const formClassName =
  "grid gap-[5px] rounded-[9px] border border-white/54 bg-white/38 p-[6px]";
const fieldClassName = [
  "h-[28px] min-w-0 rounded-[7px] border border-black/8 bg-white/66 px-[7px]",
  "text-[11px] text-rieul-text outline-none [font-family:inherit]",
  "focus:border-rieul-accent/48 focus:ring-2 focus:ring-rieul-accent/12",
].join(" ");
const formActionsClassName = "flex justify-end gap-[3px]";
const emptyClassName =
  "px-[8px] py-[10px] text-[10px] leading-[1.45] text-rieul-text-3";
const errorClassName =
  "rounded-[8px] bg-rieul-danger-soft px-[7px] py-[5px] text-[10px] text-rieul-danger";

export function AgentRail() {
  const agents = useBunja(agentsBunja);
  const workbench = useBunja(workbenchBunja);
  const projects = useAtomValue(() => agents().projectsAtom);
  const sessions = useAtomValue(() => agents().sessionsAtom);
  const availableProviders = useAtomValue(
    () => agents().availableProvidersAtom,
  );
  const phase = useAtomValue(() => agents().phaseAtom);
  const error = useAtomValue(() => agents().errorAtom);
  const activeAgentSessionId = useAtomValue(
    () => workbench().activeAgentSessionIdAtom,
  );
  const [form, setForm] = createSignal<"project" | "session" | undefined>();
  const [rootPath, setRootPath] = createSignal("");
  const [providerId, setProviderId] = createSignal("");
  const [workspaceValue, setWorkspaceValue] = createSignal("task");
  const [submitting, setSubmitting] = createSignal(false);
  const [actionError, setActionError] = createSignal<string>();
  const [archivingSessionIds, setArchivingSessionIds] = createSignal<
    Set<string>
  >((() => new Set())());
  const [collapsedProjects, setCollapsedProjects] = createSignal<Set<string>>(
    (() => new Set())(),
  );

  const effectiveProviderId = createMemo(
    () => providerId() || availableProviders()[0]?.providerId || "",
  );
  const groupedSessions = createMemo(() => {
    const known = new Set(projects().map((project) => project.projectId));
    const projectSessions = new Map<string, AgentSessionSummary[]>();
    const standaloneSessions: AgentSessionSummary[] = [];
    for (const session of sessions()) {
      const id = linkedProjectId(session);
      if (!id || !known.has(id)) standaloneSessions.push(session);
      else {
        const rows = projectSessions.get(id) ?? [];
        rows.push(session);
        projectSessions.set(id, rows);
      }
    }
    return { projectSessions, standaloneSessions };
  });

  async function submitProject() {
    const value = rootPath().trim();
    if (!value || submitting()) return;
    setSubmitting(true);
    setActionError(undefined);
    try {
      await agents().addProject(value);
      setRootPath("");
      setForm(undefined);
    } catch (cause) {
      setActionError(errorMessage(cause));
    } finally {
      setSubmitting(false);
    }
  }

  async function submitSession() {
    if (!effectiveProviderId() || submitting()) return;
    const workspace: CreateAgentWorkspace =
      workspaceValue() === "task"
        ? { type: "task", source: { type: "empty" } }
        : { type: "project", projectId: workspaceValue() };
    setSubmitting(true);
    setActionError(undefined);
    try {
      const session = await agents().addSession(
        effectiveProviderId(),
        workspace,
      );
      workbench().openAgentTab({
        sessionId: session.summary.sessionId,
        title: agentSessionTitle(session.summary),
      });
      setForm(undefined);
    } catch (cause) {
      setActionError(errorMessage(cause));
    } finally {
      setSubmitting(false);
    }
  }

  async function archiveSession(session: AgentSessionSummary) {
    if (archivingSessionIds().has(session.sessionId)) return;
    setArchivingSessionIds((current) =>
      new Set(current).add(session.sessionId),
    );
    setActionError(undefined);
    try {
      await agents().archiveSession(session.sessionId);
    } catch (cause) {
      setActionError(errorMessage(cause));
    } finally {
      setArchivingSessionIds((current) => {
        const next = new Set(current);
        next.delete(session.sessionId);
        return next;
      });
    }
  }

  return (
    <aside class={railClassName} aria-label="Agent projects and sessions">
      <section class={sectionClassName}>
        <div class={headerClassName}>
          <span>Projects</span>
          <div class={headerActionsClassName}>
            <button
              type="button"
              class={iconButtonClassName}
              onClick={() =>
                setForm((current) =>
                  current === "project" ? undefined : "project",
                )
              }
              aria-label="Add project"
              title="Add project"
            >
              {form() === "project" ? <X size={12} /> : <Plus size={12} />}
            </button>
          </div>
        </div>
        {form() === "project" ? (
          <form
            class={formClassName}
            onSubmit={(event) => {
              event.preventDefault();
              void submitProject();
            }}
          >
            <input
              class={fieldClassName}
              value={rootPath()}
              onInput={(event) => setRootPath(event.currentTarget.value)}
              placeholder="Absolute project path"
              aria-label="Project root path"
              autofocus
            />
            <div class={formActionsClassName}>
              <button
                type="submit"
                class={iconButtonClassName}
                disabled={!rootPath().trim() || submitting()}
                aria-label="Save project"
              >
                {submitting() ? (
                  <LoaderCircle size={12} className="animate-spin" />
                ) : (
                  <Check size={12} />
                )}
              </button>
            </div>
          </form>
        ) : null}
        <div class={className(listClassName, "max-h-[240px]")}>
          {projects().map((project) => {
            const children =
              groupedSessions().projectSessions.get(project.projectId) ?? [];
            const collapsed = collapsedProjects().has(project.projectId);
            return (
              <div class="grid gap-[2px]">
                <button
                  type="button"
                  class={itemButtonClassName}
                  onClick={() =>
                    setCollapsedProjects((current) =>
                      toggleSetValue(current, project.projectId),
                    )
                  }
                  title={project.title}
                  aria-expanded={!collapsed ? "true" : "false"}
                >
                  <FolderKanban size={12} className="flex-none opacity-66" />
                  <span class={itemTitleClassName}>{project.title}</span>
                  <ChevronRight
                    size={11}
                    className={className(
                      "flex-none opacity-55 transition-transform",
                      !collapsed && "rotate-90",
                    )}
                  />
                </button>
                {!collapsed
                  ? children.map((session) => (
                      <SessionButton
                        session={session}
                        nested
                        active={session.sessionId === activeAgentSessionId()}
                        archiving={archivingSessionIds().has(session.sessionId)}
                        onOpen={() => openSession(workbench(), session)}
                        onArchive={() => archiveSession(session)}
                      />
                    ))
                  : null}
              </div>
            );
          })}
        </div>
      </section>

      <section class={sessionsSectionClassName}>
        <div>
          <div class={headerClassName}>
            <span>Recents</span>
            <div class={headerActionsClassName}>
              <button
                type="button"
                class={iconButtonClassName}
                onClick={() => void agents().refreshSessions()}
                disabled={phase() === "loading"}
                aria-label="Refresh sessions"
                title="Refresh sessions"
              >
                <RefreshCw
                  size={11}
                  className={phase() === "loading" ? "animate-spin" : undefined}
                />
              </button>
              <button
                type="button"
                class={iconButtonClassName}
                onClick={() =>
                  setForm((current) =>
                    current === "session" ? undefined : "session",
                  )
                }
                disabled={availableProviders().length === 0}
                aria-label="New agent session"
                title="New agent session"
              >
                {form() === "session" ? <X size={12} /> : <Plus size={12} />}
              </button>
            </div>
          </div>
          {form() === "session" ? (
            <form
              class={formClassName}
              onSubmit={(event) => {
                event.preventDefault();
                void submitSession();
              }}
            >
              <select
                class={fieldClassName}
                value={effectiveProviderId()}
                onInput={(event) => setProviderId(event.currentTarget.value)}
                aria-label="Agent provider"
              >
                {availableProviders().map((provider) => (
                  <option value={provider.providerId}>{provider.title}</option>
                ))}
              </select>
              <select
                class={fieldClassName}
                value={workspaceValue()}
                onInput={(event) =>
                  setWorkspaceValue(event.currentTarget.value)
                }
                aria-label="Session workspace"
              >
                <option value="task">Task · isolated workspace</option>
                {projects().map((project) => (
                  <option value={project.projectId}>
                    Project · {project.title}
                  </option>
                ))}
              </select>
              <div class={formActionsClassName}>
                <button
                  type="submit"
                  class={iconButtonClassName}
                  disabled={!effectiveProviderId() || submitting()}
                  aria-label="Create session"
                >
                  {submitting() ? (
                    <LoaderCircle size={12} className="animate-spin" />
                  ) : (
                    <Check size={12} />
                  )}
                </button>
              </div>
            </form>
          ) : null}
        </div>
        <div class={listClassName}>
          {error() || actionError() ? (
            <div class={errorClassName}>{error() ?? actionError()}</div>
          ) : null}
          {groupedSessions().standaloneSessions.length === 0 &&
          !error() &&
          !actionError() ? (
            <div class={emptyClassName}>
              {availableProviders().length === 0
                ? "No available agent provider."
                : "No recent sessions."}
            </div>
          ) : null}
          {groupedSessions().standaloneSessions.map((session) => (
            <SessionButton
              session={session}
              active={session.sessionId === activeAgentSessionId()}
              archiving={archivingSessionIds().has(session.sessionId)}
              onOpen={() => openSession(workbench(), session)}
              onArchive={() => archiveSession(session)}
            />
          ))}
        </div>
      </section>
    </aside>
  );
}

function SessionButton(componentProps: {
  session: AgentSessionSummary;
  nested?: boolean;
  active?: boolean;
  archiving?: boolean;
  onOpen: () => void;
  onArchive: () => void;
}) {
  const title = createMemo(() => agentSessionTitle(componentProps.session));
  return (
    <div
      class={className(
        sessionItemClassName,
        (componentProps.nested ?? false) && nestedItemButtonClassName,
        (componentProps.active ?? false) && "active",
      )}
    >
      <button
        type="button"
        class={sessionOpenButtonClassName}
        onClick={() => componentProps.onOpen()}
        title={title()}
        aria-current={(componentProps.active ?? false) ? "page" : undefined}
      >
        <span class={itemTitleClassName}>{title()}</span>
      </button>
      <button
        type="button"
        class={sessionArchiveButtonClassName}
        onClick={() => componentProps.onArchive()}
        disabled={componentProps.archiving ?? false}
        aria-label={`Archive ${title()}`}
        title="Archive session"
      >
        {(componentProps.archiving ?? false) ? (
          <LoaderCircle size={12} className="animate-spin" />
        ) : (
          <Archive size={12} />
        )}
      </button>
    </div>
  );
}

function openSession(
  workbench: {
    openAgentTab: (config?: WorkbenchAgentTabConfig) => void;
  },
  session: AgentSessionSummary,
) {
  workbench.openAgentTab({
    sessionId: session.sessionId,
    title: agentSessionTitle(session),
  });
}

function linkedProjectId(session: AgentSessionSummary): string | undefined {
  return session.workspace.type === "project"
    ? session.workspace.projectId
    : session.workspace.sourceProjectId;
}

function toggleSetValue(current: Set<string>, value: string): Set<string> {
  const next = new Set(current);
  if (next.has(value)) next.delete(value);
  else next.add(value);
  return next;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
