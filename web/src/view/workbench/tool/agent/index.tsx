import type {
  AgentConfigOption,
  AgentContent,
  AgentMessage,
  AgentSessionEvent,
  AgentSessionInfo,
  AgentToolCall,
  AgentTurnInfo,
  AgentTurnRecord,
  CreateAgentWorkspace,
} from "../../../../protocol/generated/rpc.ts";
import { createSignal, createMemo, createEffect, onCleanup } from "solid-js";
import { useAtomValue } from "../../../../solid/jotai.tsx";
import { useBunja } from "../../../../solid/bunja.tsx";
import {
  AlertCircle,
  ArrowUp,
  Bot,
  ChevronDown,
  ChevronRight,
  LoaderCircle,
  RefreshCw,
  SlidersHorizontal,
  Sparkles,
  Wrench,
} from "../../../../solid/icons.tsx";
import {
  attachAgentSession,
  createAgentTurn,
  listAgentSessionTurns,
  setAgentSessionConfig,
  subscribeAgentSession,
} from "../../../../protocol/generated/client.ts";
import { AgentAttachmentState } from "../../../../protocol/generated/rpc.ts";
import { agentsBunja, agentSessionTitle } from "../../../../state/agents.ts";
import { rpcSessionBunja } from "../../../../state/rpc-session.ts";
import { workbenchTabBunja } from "../../../../state/workbench.ts";
import { className } from "../../../class-name.ts";
type LivePhase = "connecting" | "live" | "error";
type ReconnectMode = "auto" | "manual";
const MAX_AUTO_RECONNECT_TIMEOUTS = 5;
const MAX_AUTO_RECONNECT_DELAY_MS = 8_000;
interface LiveSessionState {
  configOptions: AgentConfigOption[];
  error?: string;
  latestSeq: number;
  phase: LivePhase;
  session?: AgentSessionInfo;
  turns: AgentTurnRecord[];
  unboundMessages: AgentMessage[];
}
interface HistoryState {
  error?: string;
  loading: boolean;
  nextCursor?: string;
  throughSeq: number;
}
const shellClassName =
  "grid h-full min-h-0 grid-rows-[auto_minmax(0,1fr)_auto] bg-[rgba(253,253,253,0.84)] text-rieul-text";
const headerClassName = [
  "flex min-w-0 items-center gap-[10px] border-b border-b-black/6 px-[18px] py-[12px]",
  "bg-white/38 backdrop-blur-xl",
].join(" ");
const headerTitleClassName =
  "min-w-0 flex-1 overflow-hidden text-ellipsis whitespace-nowrap text-[13px] font-760";
const reconnectButtonClassName = [
  "inline-flex h-[26px] flex-none appearance-none items-center gap-[5px] rounded-[8px]",
  "border border-rieul-accent/16 bg-rieul-accent-muted px-[8px] text-[10px] font-700 text-rieul-accent",
  "cursor-pointer hover:brightness-98 disabled:cursor-default disabled:opacity-50",
].join(" ");
const scrollClassName =
  "min-h-0 overflow-y-auto overscroll-contain [scrollbar-width:thin]";
const conversationClassName =
  "mx-auto grid w-full max-w-[820px] content-start gap-[18px] px-[24px] py-[28px]";
const emptyStateClassName =
  "mx-auto grid max-w-[480px] place-items-center gap-[10px] py-[12vh] text-center";
const messageRowClassName = "flex min-w-0";
const messageBodyClassName = "grid min-w-0 flex-1";
const messageTextClassName =
  "whitespace-pre-wrap break-words text-[13px] leading-[1.65] text-rieul-text-2";
const userMessageClassName =
  "rounded-[14px] rounded-tr-[4px] border border-rieul-accent/10 bg-rieul-accent-muted px-[12px] py-[9px]";
const toolCardClassName =
  "grid gap-[5px] rounded-[10px] border border-black/7 bg-white/54 px-[10px] py-[8px]";
const toolTitleClassName =
  "flex min-w-0 items-center gap-[7px] text-[11px] font-680 text-rieul-text-2";
const toolMetaClassName = "text-[10px] text-rieul-text-3";
const composerWrapClassName =
  "border-t border-t-black/6 bg-white/46 px-[18px] pb-[16px] pt-[11px] backdrop-blur-xl";
const configBarClassName =
  "mx-auto mb-[8px] flex max-w-[820px] items-center gap-[7px] overflow-x-auto pb-[1px] [scrollbar-width:thin]";
const configControlClassName = [
  "inline-flex h-[30px] flex-none items-center gap-[6px] rounded-[9px] border border-black/8",
  "bg-white/72 px-[8px] text-[10px] text-rieul-text-3",
].join(" ");
const configSelectClassName =
  "max-w-[190px] appearance-none border-0 bg-transparent pr-[2px] text-[10px] font-680 text-rieul-text outline-none disabled:opacity-50";
const configToggleClassName = [
  "relative h-[16px] w-[28px] appearance-none rounded-full border-0 p-0 transition-colors",
  "after:absolute after:left-[2px] after:top-[2px] after:h-[12px] after:w-[12px] after:rounded-full after:content-['']",
  "after:bg-white after:shadow-sm after:transition-transform disabled:opacity-50",
].join(" ");
const composerClassName = [
  "mx-auto grid max-w-[820px] gap-[3px]",
  "rounded-[15px] border border-black/10 bg-white/82 p-[7px] shadow-[0_8px_24px_rgba(20,30,46,0.07)]",
  "focus-within:border-rieul-accent/38 focus-within:ring-2 focus-within:ring-rieul-accent/10",
].join(" ");
const composerFooterClassName =
  "flex min-w-0 flex-wrap items-center gap-x-[8px] gap-y-[4px] pl-[5px]";
const composerConfigGroupClassName =
  "flex min-w-0 flex-wrap items-center gap-[3px]";
const composerConfigControlClassName = [
  "inline-flex h-[30px] min-w-0 items-center gap-[4px] rounded-[8px] px-[5px]",
  "text-[10px] text-rieul-text-3 hover:bg-black/4",
].join(" ");
const composerConfigSelectClassName = [
  "min-w-0 max-w-[160px] appearance-none border-0 bg-transparent px-[2px]",
  "text-[10px] font-680 text-rieul-text outline-none disabled:opacity-50",
].join(" ");
const composerActionsClassName =
  "ml-auto flex min-w-0 flex-wrap items-center justify-end gap-[3px]";
const composerSettingsTriggerClassName = [
  "inline-flex h-[30px] max-w-[280px] appearance-none items-center gap-[5px] rounded-[8px]",
  "border-0 bg-transparent px-[7px] text-[10px] font-680 text-rieul-text cursor-pointer",
  "hover:bg-black/4 disabled:cursor-default disabled:opacity-50",
].join(" ");
const composerSettingsPopoverClassName = [
  "absolute bottom-[calc(100%+7px)] right-0 z-20 grid min-w-[240px] max-w-[min(360px,calc(100vw-48px))] gap-[5px]",
  "rounded-[13px] border border-black/9 bg-white/92 p-[7px] shadow-[0_14px_36px_rgba(20,30,46,0.14)] backdrop-blur-xl",
].join(" ");
const textareaClassName = [
  "max-h-[180px] min-h-[36px] w-full resize-none border-0 bg-transparent px-[7px] py-[8px]",
  "text-[13px] leading-[1.45] text-rieul-text outline-none [font-family:inherit]",
  "placeholder:text-rieul-text-3/66 disabled:cursor-not-allowed disabled:opacity-60",
].join(" ");
const sendButtonClassName = [
  "inline-flex h-[34px] w-[34px] appearance-none items-center justify-center rounded-[11px]",
  "border border-transparent bg-rieul-accent text-white p-0 cursor-pointer",
  "hover:brightness-105 disabled:cursor-default disabled:bg-rieul-text-3/22 disabled:text-white/76",
].join(" ");
const composerHintClassName =
  "mx-auto mt-[6px] max-w-[820px] px-[4px] text-[10px] text-rieul-text-3";
const errorBannerClassName =
  "mx-auto flex max-w-[820px] items-start gap-[8px] rounded-[10px] bg-rieul-danger-soft px-[10px] py-[8px] text-[11px] text-rieul-danger";
const turnFailureClassName = [
  "grid gap-[6px] rounded-[12px] border border-rieul-danger/18",
  "bg-rieul-danger-soft px-[11px] py-[10px] text-rieul-danger",
].join(" ");
const turnFailureTitleClassName =
  "flex items-center gap-[7px] text-[11px] font-760";
const turnFailureMessageClassName =
  "whitespace-pre-wrap break-words text-[11px] leading-[1.55]";
const turnFailureMetaClassName =
  "flex flex-wrap gap-x-[10px] gap-y-[3px] text-[10px] opacity-72";
const landingShellClassName =
  "grid h-full min-h-0 place-items-center overflow-y-auto bg-[rgba(253,253,253,0.84)] p-[24px]";
const landingCardClassName =
  "grid w-full max-w-[440px] gap-[16px] rounded-[20px] border border-black/7 bg-white/72 p-[22px] shadow-[0_20px_50px_rgba(20,30,46,0.08)]";
const landingFieldsClassName = "grid gap-[8px]";
const fieldClassName = [
  "h-[38px] min-w-0 rounded-[10px] border border-black/9 bg-white/78 px-[10px]",
  "text-[12px] text-rieul-text outline-none [font-family:inherit]",
  "focus:border-rieul-accent/42 focus:ring-2 focus:ring-rieul-accent/10",
].join(" ");
const primaryButtonClassName = [
  "inline-flex h-[38px] appearance-none items-center justify-center gap-[7px] rounded-[11px]",
  "border border-rieul-accent/12 bg-rieul-accent px-[14px] text-[12px] font-720 text-white",
  "cursor-pointer hover:brightness-105 disabled:cursor-default disabled:opacity-45",
].join(" ");
export function AgentTool() {
  const tabState = useBunja(workbenchTabBunja);
  const tab = useAtomValue(() => tabState().tabAtom);
  const sessionId = createMemo(() => tab()?.agentSessionId);
  return (
    <>
      {(() => {
        if (!sessionId()) return <AgentLanding />;
        return <AgentConversation sessionId={sessionId()!} />;
      })()}
    </>
  );
}
function AgentLanding() {
  const agents = useBunja(agentsBunja);
  const tabState = useBunja(workbenchTabBunja);
  const providers = useAtomValue(() => agents().availableProvidersAtom);
  const projects = useAtomValue(() => agents().projectsAtom);
  const [providerId, setProviderId] = createSignal("");
  const [workspaceValue, setWorkspaceValue] = createSignal("task");
  const [creating, setCreating] = createSignal(false);
  const [error, setError] = createSignal<string>();
  let alive = true;
  onCleanup(() => {
    alive = false;
  });
  const effectiveProviderId = createMemo(
    () => providerId() || providers()[0]?.providerId || "",
  );
  async function createSession() {
    if (!effectiveProviderId() || creating()) return;
    const workspace: CreateAgentWorkspace =
      workspaceValue() === "task"
        ? {
            type: "task",
            source: {
              type: "empty",
            },
          }
        : {
            type: "project",
            projectId: workspaceValue(),
          };
    const source = agents();
    const destination = tabState();
    setCreating(true);
    setError(undefined);
    try {
      const session = await source.addSession(effectiveProviderId(), workspace);
      if (!alive) return;
      destination.setAgentSession(
        session.summary.sessionId,
        agentSessionTitle(session.summary),
      );
    } catch (cause) {
      if (alive) setError(errorMessage(cause));
    } finally {
      if (alive) setCreating(false);
    }
  }
  return (
    <>
      {(() => {
        return (
          <div class={landingShellClassName}>
            <section class={landingCardClassName}>
              <div class="grid gap-[8px]">
                <div class="inline-flex h-[38px] w-[38px] items-center justify-center rounded-[13px] bg-rieul-accent-muted text-rieul-accent">
                  <Sparkles size={18} />
                </div>
                <div class="grid gap-[3px]">
                  <h2 class="m-0 text-[18px] font-780 tracking-[-0.02em]">
                    Start an agent session
                  </h2>
                  <p class="m-0 text-[12px] leading-[1.5] text-rieul-text-3">
                    Pick an agent and choose a project or an isolated task
                    workspace.
                  </p>
                </div>
              </div>
              {providers().length === 0 ? (
                <div class={errorBannerClassName}>
                  <AlertCircle size={14} className="mt-px flex-none" />
                  No available agent provider was found in the daemon
                  configuration.
                </div>
              ) : (
                <div class={landingFieldsClassName}>
                  <select
                    class={fieldClassName}
                    value={effectiveProviderId()}
                    onChange={(event) =>
                      setProviderId(event.currentTarget.value)
                    }
                    aria-label="Agent provider"
                  >
                    {providers().map((provider) => (
                      <option value={provider.providerId}>
                        {provider.title}
                      </option>
                    ))}
                  </select>
                  <select
                    class={fieldClassName}
                    value={workspaceValue()}
                    onChange={(event) =>
                      setWorkspaceValue(event.currentTarget.value)
                    }
                    aria-label="Agent workspace"
                  >
                    <option value="task">Task · isolated workspace</option>
                    {projects().map((project) => (
                      <option value={project.projectId}>
                        Project · {project.title}
                      </option>
                    ))}
                  </select>
                </div>
              )}
              {error() ? (
                <div class={errorBannerClassName}>
                  <AlertCircle size={14} className="mt-px flex-none" />
                  {error()}
                </div>
              ) : null}
              <button
                type="button"
                class={primaryButtonClassName}
                onClick={() => void createSession()}
                disabled={!effectiveProviderId() || creating()}
              >
                {creating() ? (
                  <LoaderCircle size={14} className="animate-spin" />
                ) : (
                  <Bot size={14} />
                )}
                {creating() ? "Starting…" : "Create session"}
              </button>
            </section>
          </div>
        );
      })()}
    </>
  );
}
function AgentConversation(props: { sessionId: string }) {
  const agents = useBunja(agentsBunja);
  const rpcSession = useBunja(rpcSessionBunja);
  const tabState = useBunja(workbenchTabBunja);
  const daemonInstanceId = useAtomValue(
    () => rpcSession().daemonInstanceIdAtom,
  );
  const sessions = useAtomValue(() => agents().sessionsAtom);
  const [state, setState] = createSignal<LiveSessionState>(() =>
    initialLiveState(),
  );
  const [draft, setDraft] = createSignal("");
  const [sending, setSending] = createSignal(false);
  const [reconnecting, setReconnecting] = createSignal(false);
  const [manualReconnectRequired, setManualReconnectRequired] =
    createSignal(false);
  const [autoReconnectRetryVersion, setAutoReconnectRetryVersion] =
    createSignal(0);
  const [subscriptionVersion, setSubscriptionVersion] = createSignal(0);
  const [changingConfigId, setChangingConfigId] = createSignal<string>();
  const [history, setHistory] = createSignal<HistoryState>(() =>
    initialHistoryState(),
  );
  const scrollRef = {
    current: null as HTMLDivElement | null,
  };
  const composerRef = {
    current: null as HTMLTextAreaElement | null,
  };
  const stickToBottomRef = {
    current: true,
  };
  const reconnectTimeoutCountRef = {
    current: 0,
  };
  const reconnectAttemptIdRef = {
    current: 0,
  };
  let generation = 0;
  let alive = true;
  onCleanup(() => {
    alive = false;
    generation++;
  });
  createEffect(
    createMemo(
      () =>
        [
          daemonInstanceId(),
          props.sessionId,
          subscriptionVersion(),
          rpcSession(),
          agents(),
        ] as const,
      {
        equals: (a, b) =>
          a.length === b.length &&
          a.every((value, index) => Object.is(value, b[index])),
      },
    ),
    ([, sessionId, , sessionModel, agentsModel]) => {
      generation++;
      let cancelled = false;
      let stream: AsyncGenerator<AgentSessionEvent> | undefined;
      setState(initialLiveState());
      setHistory(initialHistoryState());
      setSending(false);
      setChangingConfigId(undefined);
      void (async () => {
        try {
          const transport = await sessionModel.webTransport();
          if (cancelled) return;
          stream = subscribeAgentSession(transport, {
            sessionId,
          });
          for await (const event of stream) {
            if (cancelled) break;
            setState((current) => reduceSessionEvent(current, event));
            if (event.type === "snapshot") {
              const throughSeq = event.snapshot.latestSeq;
              setHistory({
                loading: true,
                throughSeq,
              });
              try {
                const page = await listAgentSessionTurns(transport, {
                  sessionId,
                  throughSeq,
                  limit: 50,
                });
                if (cancelled) break;
                setState((current) => mergeTurnHistory(current, page.turns));
                setHistory({
                  loading: false,
                  nextCursor: page.nextCursor,
                  throughSeq,
                });
              } catch (cause) {
                if (cancelled) break;
                setHistory({
                  error: errorMessage(cause),
                  loading: false,
                  throughSeq,
                });
              }
            }
            if (
              event.type === "sessionUpsert" ||
              (event.type === "turnUpsert" && isFinishedTurn(event.turn))
            ) {
              void agentsModel.refreshSessions();
            }
          }
        } catch (cause) {
          if (!cancelled) {
            setState((current) => ({
              ...current,
              error: errorMessage(cause),
              phase: "error",
            }));
          }
        }
      })();
      return () => {
        cancelled = true;
        generation++;
        void stream?.return(undefined);
      };
    },
  );
  const messages = createMemo(() =>
    [
      ...state().turns.flatMap((turn) => turn.messages),
      ...state().unboundMessages,
    ].sort((left, right) => left.createdAtMs - right.createdAtMs),
  );
  const conversationVersion = createMemo(() =>
    [
      state().latestSeq,
      messages().length,
      messages().at(-1)?.content.length ?? 0,
    ].join(":"),
  );
  createEffect(conversationVersion, (_value) => {
    const viewport = scrollRef.current;
    if (!viewport || !stickToBottomRef.current) return;
    viewport.scrollTo({
      top: viewport.scrollHeight,
    });
  });
  createEffect(draft, (_value) => {
    const composer = composerRef.current;
    if (!composer) return;
    composer.style.height = "auto";
    composer.style.height = `${Math.min(composer.scrollHeight, 180)}px`;
  });
  const summary = createMemo(
    () =>
      state().session?.summary ??
      sessions().find((session) => session.sessionId === props.sessionId),
  );
  const title = createMemo(() =>
    summary() ? agentSessionTitle(summary()!) : "New session",
  );
  const attached = createMemo(
    () => summary()?.attachment === AgentAttachmentState.Attached,
  );
  const turnBusy = createMemo(() =>
    state().turns.some(
      (record) =>
        record.turn.state.type === "queued" ||
        record.turn.state.type === "running" ||
        record.turn.state.type === "awaitingPermission",
    ),
  );
  const canSend = createMemo(
    () =>
      state().phase === "live" &&
      attached() &&
      !turnBusy() &&
      !sending() &&
      draft().trim().length > 0,
  );
  const canReconnect = createMemo(
    () =>
      state().phase === "live" &&
      !attached() &&
      (summary()?.attachment === AgentAttachmentState.Dormant ||
        summary()?.attachment === AgentAttachmentState.Failed),
  );
  createEffect(
    () => props.sessionId,
    () => {
      reconnectTimeoutCountRef.current = 0;
      reconnectAttemptIdRef.current += 1;
      setManualReconnectRequired(false);
      setAutoReconnectRetryVersion(0);
      setReconnecting(false);
      return () => {
        reconnectAttemptIdRef.current += 1;
      };
    },
  );
  createEffect(
    createMemo(
      () => [
        autoReconnectRetryVersion(),
        canReconnect(),
        manualReconnectRequired(),
        reconnecting(),
        props.sessionId,
      ],
      {
        equals: (a, b) =>
          a.length === b.length &&
          a.every((value, index) => Object.is(value, b[index])),
      },
    ),
    ([, can, manual, reconnectingNow]) => {
      if (!can || reconnectingNow || manual) return;
      const timeoutCount = reconnectTimeoutCountRef.current;
      const timer = globalThis.setTimeout(
        () => void reconnect("auto"),
        autoReconnectDelayMs(timeoutCount),
      );
      return () => globalThis.clearTimeout(timer);
    },
  );
  createEffect(
    createMemo(
      () => [props.sessionId, title(), summary(), tabState()] as const,
      {
        equals: (a, b) =>
          a.length === b.length &&
          a.every((value, index) => Object.is(value, b[index])),
      },
    ),
    ([sessionId, currentTitle, currentSummary, tab]) => {
      if (!currentSummary) return;
      tab.setAgentSession(sessionId, currentTitle);
    },
  );
  async function loadEarlierHistory() {
    const requestGeneration = generation;
    const sessionId = props.sessionId;
    const sessionModel = rpcSession();
    if (history().loading || !history().nextCursor) return;
    const pageRequest = history();
    const viewport = scrollRef.current;
    const previousHeight = viewport?.scrollHeight ?? 0;
    setHistory((current) => ({
      ...current,
      error: undefined,
      loading: true,
    }));
    try {
      const transport = await sessionModel.webTransport();
      if (!alive || generation !== requestGeneration) return;
      const page = await listAgentSessionTurns(transport, {
        sessionId,
        throughSeq: pageRequest.throughSeq,
        cursor: pageRequest.nextCursor,
        limit: 50,
      });
      if (!alive || generation !== requestGeneration) return;
      stickToBottomRef.current = false;
      setState((current) => mergeTurnHistory(current, page.turns));
      setHistory((current) => ({
        ...current,
        loading: false,
        nextCursor: page.nextCursor,
      }));
      requestAnimationFrame(() => {
        if (!alive || generation !== requestGeneration || !viewport) return;
        viewport.scrollTop += viewport.scrollHeight - previousHeight;
      });
    } catch (cause) {
      if (!alive || generation !== requestGeneration) return;
      setHistory((current) => ({
        ...current,
        error: errorMessage(cause),
        loading: false,
      }));
    }
  }
  async function reconnect(mode: ReconnectMode) {
    const requestGeneration = generation;
    const sessionId = props.sessionId;
    const sessionModel = rpcSession();
    const agentsModel = agents();
    if (!canReconnect() || reconnecting()) return;
    const attemptId = ++reconnectAttemptIdRef.current;
    setReconnecting(true);
    setState((current) => ({
      ...current,
      error: undefined,
    }));
    try {
      const transport = await sessionModel.webTransport();
      if (!alive || generation !== requestGeneration) return;
      const session = await attachAgentSession(transport, {
        sessionId,
      });
      if (
        !alive ||
        generation !== requestGeneration ||
        attemptId !== reconnectAttemptIdRef.current
      )
        return;
      reconnectTimeoutCountRef.current = 0;
      setManualReconnectRequired(false);
      setState((current) => ({
        ...current,
        session,
      }));
      setSubscriptionVersion((version) => version + 1);
      void agentsModel.refreshSessions();
    } catch (cause) {
      if (!alive || generation !== requestGeneration) return;
      if (
        !alive ||
        generation !== requestGeneration ||
        attemptId !== reconnectAttemptIdRef.current
      )
        return;
      if (mode === "auto" && isTimeoutError(cause)) {
        const timeoutCount = reconnectTimeoutCountRef.current + 1;
        reconnectTimeoutCountRef.current = timeoutCount;
        if (timeoutCount >= MAX_AUTO_RECONNECT_TIMEOUTS) {
          setManualReconnectRequired(true);
          setState((current) => ({
            ...current,
            error:
              "Reconnect timed out five times. Reconnect manually to try again.",
          }));
        } else {
          setAutoReconnectRetryVersion((version) => version + 1);
        }
      } else {
        reconnectTimeoutCountRef.current = 0;
        setManualReconnectRequired(true);
        setState((current) => ({
          ...current,
          error: errorMessage(cause),
        }));
      }
    } finally {
      if (
        alive &&
        generation === requestGeneration &&
        attemptId === reconnectAttemptIdRef.current
      ) {
        setReconnecting(false);
      }
    }
  }
  async function sendTurn(event?: SubmitEvent) {
    const requestGeneration = generation;
    const sessionId = props.sessionId;
    const sessionModel = rpcSession();
    const agentsModel = agents();
    event?.preventDefault();
    const text = draft().trim();
    if (!text || !canSend()) return;
    setSending(true);
    try {
      const transport = await sessionModel.webTransport();
      if (!alive || generation !== requestGeneration) return;
      const turn = await createAgentTurn(transport, {
        clientRequestId: crypto.randomUUID(),
        content: [
          {
            type: "text",
            text,
          },
        ],
        sessionId,
      });
      if (!alive || generation !== requestGeneration) return;
      setState((current) => upsertTurn(current, turn));
      setDraft("");
      stickToBottomRef.current = true;
      void agentsModel.refreshSessions();
    } catch (cause) {
      if (!alive || generation !== requestGeneration) return;
      setState((current) => ({
        ...current,
        error: errorMessage(cause),
      }));
    } finally {
      if (alive && generation === requestGeneration) setSending(false);
    }
  }
  async function changeConfig(
    option: AgentConfigOption,
    value: string | boolean,
  ) {
    const requestGeneration = generation;
    const sessionId = props.sessionId;
    const sessionModel = rpcSession();
    if (changingConfigId() || turnBusy()) return;
    setChangingConfigId(option.configId);
    try {
      const transport = await sessionModel.webTransport();
      if (!alive || generation !== requestGeneration) return;
      const response = await setAgentSessionConfig(transport, {
        sessionId,
        configId: option.configId,
        value:
          typeof value === "boolean"
            ? {
                type: "boolean",
                value,
              }
            : {
                type: "string",
                value,
              },
      });
      if (!alive || generation !== requestGeneration) return;
      setState((current) =>
        response.seq < current.latestSeq
          ? current
          : {
              ...current,
              configOptions: response.configOptions,
              error: undefined,
              latestSeq: response.seq,
            },
      );
    } catch (cause) {
      if (!alive || generation !== requestGeneration) return;
      setState((current) => ({
        ...current,
        error: errorMessage(cause),
      }));
    } finally {
      if (alive && generation === requestGeneration)
        setChangingConfigId(undefined);
    }
  }
  function onComposerKeyDown(
    event: KeyboardEvent & {
      currentTarget: HTMLTextAreaElement;
    },
  ) {
    if (event.key !== "Enter" || event.shiftKey || event.isComposing) {
      return;
    }
    event.preventDefault();
    void sendTurn();
  }
  const modeOptions = createMemo(() =>
    state().configOptions.filter(
      (option) =>
        option.category?.type === "mode" && !isCollaborationModeOption(option),
    ),
  );
  const rightComposerOptions = createMemo(() => [
    ...state().configOptions.filter(
      (option) => option.category?.type === "model",
    ),
    ...state().configOptions.filter(
      (option) => option.category?.type === "modelConfig",
    ),
    ...state().configOptions.filter(
      (option) => option.category?.type === "thoughtLevel",
    ),
  ]);
  const otherOptions = createMemo(() =>
    state().configOptions.filter(
      (option) =>
        !isCollaborationModeOption(option) &&
        (option.category === undefined || option.category.type === "other"),
    ),
  );
  const configDisabled = createMemo(
    () => state().phase !== "live" || !attached() || turnBusy(),
  );
  return (
    <>
      {(() => {
        return (
          <div class={shellClassName}>
            <header class={headerClassName}>
              <span class={headerTitleClassName}>{title()}</span>
              {canReconnect() && manualReconnectRequired() ? (
                <button
                  type="button"
                  class={reconnectButtonClassName}
                  onClick={() => void reconnect("manual")}
                  disabled={reconnecting()}
                >
                  {reconnecting() ? (
                    <LoaderCircle size={11} className="animate-spin" />
                  ) : (
                    <RefreshCw size={11} />
                  )}
                  Reconnect
                </button>
              ) : null}
            </header>

            <div
              ref={(element) => (scrollRef.current = element)}
              class={scrollClassName}
              onScroll={(event) => {
                const viewport = event.currentTarget;
                stickToBottomRef.current =
                  viewport.scrollHeight -
                    viewport.scrollTop -
                    viewport.clientHeight <
                  80;
              }}
            >
              <div class={conversationClassName}>
                {history().error ? (
                  <div class={errorBannerClassName}>
                    <AlertCircle size={14} className="mt-px flex-none" />
                    Could not load earlier conversation: {history().error}
                  </div>
                ) : null}
                {history().nextCursor ? (
                  <button
                    type="button"
                    class={`${reconnectButtonClassName} mx-auto`}
                    onClick={() => void loadEarlierHistory()}
                    disabled={history().loading}
                  >
                    {history().loading ? (
                      <LoaderCircle size={11} className="animate-spin" />
                    ) : (
                      <ChevronRight size={11} className="-rotate-90" />
                    )}
                    Load earlier messages
                  </button>
                ) : null}
                {state().error ? (
                  <div class={errorBannerClassName}>
                    <AlertCircle size={14} className="mt-px flex-none" />
                    {state().error}
                  </div>
                ) : null}
                {state().session?.failure ? (
                  <div class={errorBannerClassName}>
                    <AlertCircle size={14} className="mt-px flex-none" />
                    <span class="grid gap-[2px]">
                      <strong>Agent process failed</strong>
                      <span>{state().session!.failure!.message}</span>
                    </span>
                  </div>
                ) : null}
                {messages().length === 0 && history().loading ? (
                  <div class="flex items-center justify-center gap-[8px] py-[12vh] text-[11px] text-rieul-text-3">
                    <LoaderCircle size={13} className="animate-spin" />
                    Loading conversation…
                  </div>
                ) : messages().length === 0 ? (
                  <div class={emptyStateClassName}>
                    <div class="inline-flex h-[46px] w-[46px] items-center justify-center rounded-[16px] bg-rieul-accent-muted text-rieul-accent">
                      <Sparkles size={20} />
                    </div>
                    <div class="text-[15px] font-760">
                      What would you like to work on?
                    </div>
                    <p class="m-0 max-w-[380px] text-[11px] leading-[1.55] text-rieul-text-3">
                      Messages and agent activity will stream here as the turn
                      runs.
                    </p>
                  </div>
                ) : (
                  messages().map((message) => (
                    <AgentMessageView message={message} />
                  ))
                )}
                {state()
                  .turns.flatMap((turn) => turn.toolCalls)
                  .map((toolCall) => (
                    <AgentToolCallView toolCall={toolCall} />
                  ))}
                {state().turns.map((record) =>
                  record.turn.state.type === "failed" ? (
                    <AgentTurnFailureView record={record} />
                  ) : null,
                )}
                {turnBusy() ? (
                  <div class="flex items-center gap-[8px] text-[11px] text-rieul-text-3">
                    <LoaderCircle size={13} className="animate-spin" />
                    Agent is working…
                  </div>
                ) : null}
              </div>
            </div>

            <form class={composerWrapClassName} onSubmit={sendTurn}>
              {otherOptions().length > 0 ? (
                <AgentConfigBar
                  options={otherOptions()}
                  changingConfigId={changingConfigId()}
                  disabled={configDisabled()}
                  onChange={(option, value) => void changeConfig(option, value)}
                />
              ) : null}
              <div class={composerClassName}>
                <textarea
                  ref={(element) => (composerRef.current = element)}
                  class={textareaClassName}
                  value={draft()}
                  onInput={(event) => setDraft(event.currentTarget.value)}
                  onKeyDown={onComposerKeyDown}
                  placeholder={composerPlaceholder(state(), turnBusy())}
                  disabled={
                    state().phase !== "live" || !attached() || turnBusy()
                  }
                  rows={1}
                  aria-label="Message agent"
                />
                <div class={composerFooterClassName}>
                  <AgentComposerConfigGroup
                    options={modeOptions()}
                    changingConfigId={changingConfigId()}
                    disabled={configDisabled()}
                    onChange={(option, value) =>
                      void changeConfig(option, value)
                    }
                  />
                  <div class={composerActionsClassName}>
                    <AgentComposerSettings
                      options={rightComposerOptions()}
                      changingConfigId={changingConfigId()}
                      disabled={configDisabled()}
                      onChange={(option, value) =>
                        void changeConfig(option, value)
                      }
                    />
                    <button
                      type="submit"
                      class={sendButtonClassName}
                      disabled={!canSend()}
                      aria-label="Send message"
                      title="Send message"
                    >
                      {sending() ? (
                        <LoaderCircle size={15} className="animate-spin" />
                      ) : (
                        <ArrowUp size={15} strokeWidth={2.4} />
                      )}
                    </button>
                  </div>
                </div>
              </div>
              <div class={composerHintClassName}>
                Enter to send · Shift+Enter for a new line
              </div>
            </form>
          </div>
        );
      })()}
    </>
  );
}
function AgentComposerSettings(props: {
  options: AgentConfigOption[];
  changingConfigId?: string;
  disabled: boolean;
  onChange: (option: AgentConfigOption, value: string | boolean) => void;
}) {
  const [open, setOpen] = createSignal(false);
  const rootRef = {
    current: null as HTMLDivElement | null,
  };
  const summaryOptions = createMemo(() =>
    [
      props.options.find((option) => option.category?.type === "model"),
      props.options.find((option) => option.category?.type === "thoughtLevel"),
    ].filter((option): option is AgentConfigOption => option !== undefined),
  );
  createEffect(open, (isOpen) => {
    if (!isOpen) return;
    function closeOnOutsidePointer(event: PointerEvent) {
      if (!rootRef.current?.contains(event.target as Node)) setOpen(false);
    }
    function closeOnEscape(event: globalThis.KeyboardEvent) {
      if (event.key === "Escape") setOpen(false);
    }
    document.addEventListener("pointerdown", closeOnOutsidePointer);
    document.addEventListener("keydown", closeOnEscape);
    return () => {
      document.removeEventListener("pointerdown", closeOnOutsidePointer);
      document.removeEventListener("keydown", closeOnEscape);
    };
  });
  return (
    <>
      {(() => {
        if (props.options.length === 0) return null;
        const summary = createMemo(() =>
          summaryOptions().length > 0
            ? summaryOptions().map(agentConfigCurrentLabel).join(" · ")
            : "Settings",
        );
        return (
          <div
            ref={(element) => (rootRef.current = element)}
            class="relative flex-none"
          >
            <button
              type="button"
              class={composerSettingsTriggerClassName}
              aria-expanded={open() ? "true" : "false"}
              aria-haspopup="dialog"
              title={summary()}
              onClick={() => setOpen((current) => !current)}
            >
              <span class="min-w-0 overflow-hidden text-ellipsis whitespace-nowrap">
                {summary()}
              </span>
              {props.changingConfigId ? (
                <LoaderCircle size={10} className="flex-none animate-spin" />
              ) : (
                <ChevronDown
                  size={11}
                  className={`flex-none text-rieul-text-3 transition-transform ${open() ? "rotate-180" : ""}`}
                />
              )}
            </button>
            {open() ? (
              <div
                class={composerSettingsPopoverClassName}
                role="dialog"
                aria-label="Model and effort settings"
              >
                {props.options.map((option) => (
                  <AgentConfigControl
                    option={option}
                    changing={props.changingConfigId === option.configId}
                    disabled={
                      props.disabled || props.changingConfigId !== undefined
                    }
                    expanded
                    onChange={(value) => props.onChange(option, value)}
                  />
                ))}
              </div>
            ) : null}
          </div>
        );
      })()}
    </>
  );
}
function AgentComposerConfigGroup(props: {
  options: AgentConfigOption[];
  changingConfigId?: string;
  disabled: boolean;
  onChange: (option: AgentConfigOption, value: string | boolean) => void;
}) {
  return (
    <>
      {(() => {
        if (props.options.length === 0) return null;
        return (
          <div class={composerConfigGroupClassName}>
            {props.options.map((option) => (
              <AgentConfigControl
                option={option}
                changing={props.changingConfigId === option.configId}
                disabled={
                  props.disabled || props.changingConfigId !== undefined
                }
                compact
                onChange={(value) => props.onChange(option, value)}
              />
            ))}
          </div>
        );
      })()}
    </>
  );
}
function AgentConfigBar(props: {
  options: AgentConfigOption[];
  changingConfigId?: string;
  disabled: boolean;
  onChange: (option: AgentConfigOption, value: string | boolean) => void;
}) {
  return (
    <>
      {(() => {
        return (
          <div class={configBarClassName} aria-label="Agent session settings">
            <SlidersHorizontal
              size={12}
              className="flex-none text-rieul-text-3"
            />
            {props.options.map((option) => (
              <AgentConfigControl
                option={option}
                changing={props.changingConfigId === option.configId}
                disabled={
                  props.disabled || props.changingConfigId !== undefined
                }
                onChange={(value) => props.onChange(option, value)}
              />
            ))}
          </div>
        );
      })()}
    </>
  );
}
function AgentConfigControl(props: {
  option: AgentConfigOption;
  changing: boolean;
  disabled: boolean;
  compact?: boolean;
  expanded?: boolean;
  onChange: (value: string | boolean) => void;
}) {
  const controlClassName = createMemo(() =>
    props.compact
      ? composerConfigControlClassName
      : `${configControlClassName} ${props.expanded ? "w-full justify-between" : ""}`,
  );
  return (
    <>
      {(() => {
        if (props.option.input.type === "select") {
          return (
            <label class={controlClassName()} title={props.option.description}>
              {props.compact ? null : (
                <span class="whitespace-nowrap">{props.option.title}</span>
              )}
              <span class="ml-auto flex min-w-0 items-center gap-[5px]">
                <select
                  class={
                    props.compact
                      ? composerConfigSelectClassName
                      : configSelectClassName
                  }
                  value={props.option.input.currentValue}
                  disabled={props.disabled}
                  onChange={(event) =>
                    props.onChange(event.currentTarget.value)
                  }
                  aria-label={props.option.title}
                >
                  <AgentConfigSelectOptions option={props.option} />
                </select>
                <span class="inline-flex w-[11px] flex-none justify-center">
                  {props.changing ? (
                    <LoaderCircle size={10} className="animate-spin" />
                  ) : props.compact ? (
                    <ChevronDown size={11} className="text-rieul-text-3" />
                  ) : null}
                </span>
              </span>
            </label>
          );
        }
        if (props.option.input.type === "boolean") {
          return (
            <label class={controlClassName()} title={props.option.description}>
              <span class="whitespace-nowrap">{props.option.title}</span>
              <span class="ml-auto flex items-center gap-[5px]">
                <button
                  type="button"
                  role="switch"
                  aria-checked={
                    props.option.input.currentValue ? "true" : "false"
                  }
                  aria-label={props.option.title}
                  class={`${configToggleClassName} ${props.option.input.currentValue ? "bg-rieul-accent after:translate-x-[12px]" : "bg-rieul-text-3/24"}`}
                  disabled={props.disabled}
                  onClick={() =>
                    props.onChange(!props.option.input.currentValue)
                  }
                />
                <span class="inline-flex w-[11px] flex-none justify-center">
                  {props.changing ? (
                    <LoaderCircle size={10} className="animate-spin" />
                  ) : null}
                </span>
              </span>
            </label>
          );
        }
        return null;
      })()}
    </>
  );
}
function agentConfigCurrentLabel(option: AgentConfigOption) {
  if (option.input.type === "select") {
    return (
      option.input.options.find(
        (value) => value.value === option.input.currentValue,
      )?.title ?? option.input.currentValue
    );
  }
  if (option.input.type === "boolean") {
    return `${option.title} ${option.input.currentValue ? "On" : "Off"}`;
  }
  return option.title;
}
function isCollaborationModeOption(option: AgentConfigOption) {
  return [option.configId, option.title].some(
    (value) =>
      value.toLowerCase().replaceAll(/[^a-z0-9]/g, "") === "collaborationmode",
  );
}
function AgentConfigSelectOptions(props: { option: AgentConfigOption }) {
  return (
    <>
      {(() => {
        const input = props.option.input;
        if (input.type !== "select") return null;
        const ungrouped = createMemo(() =>
          input.options.filter((value) => !value.group),
        );
        const groups = createMemo(
          () =>
            new Map<
              string,
              {
                title: string;
                options: typeof input.options;
              }
            >(),
        );
        for (const value of input.options) {
          if (!value.group) continue;
          const group = groups().get(value.group.groupId) ?? {
            title: value.group.title,
            options: [],
          };
          group.options.push(value);
          groups().set(value.group.groupId, group);
        }
        return (
          <>
            {ungrouped().map((value) => (
              <option value={value.value} title={value.description}>
                {value.title}
              </option>
            ))}
            {[...groups()].map(([_groupId, group]) => (
              <optgroup label={group.title}>
                {group.options.map((value) => (
                  <option value={value.value} title={value.description}>
                    {value.title}
                  </option>
                ))}
              </optgroup>
            ))}
          </>
        );
      })()}
    </>
  );
}
function AgentMessageView(props: { message: AgentMessage }) {
  const role = createMemo(() => props.message.role.type);
  const isUser = createMemo(() => role() === "user");
  const isThought = createMemo(() => role() === "thought");
  return (
    <>
      {(() => {
        return (
          <article
            class={className(
              messageRowClassName,
              isUser() && "justify-end",
              isThought() && "opacity-72",
            )}
          >
            <div
              class={className(
                messageBodyClassName,
                isUser() && "max-w-[76%] justify-self-end",
              )}
            >
              <div class={isUser() ? userMessageClassName : undefined}>
                {mergeAdjacentTextContent(props.message.content).map(
                  (content, _index) => (
                    <AgentContentView content={content} />
                  ),
                )}
              </div>
            </div>
          </article>
        );
      })()}
    </>
  );
}
function AgentContentView(props: { content: AgentContent }) {
  return (
    <>
      {(() => {
        if (props.content.type === "text") {
          return <div class={messageTextClassName}>{props.content.text}</div>;
        }
        if (props.content.type === "embeddedText") {
          return (
            <details class="my-[5px] rounded-[9px] border border-black/7 bg-white/52 px-[9px] py-[7px]">
              <summary class="cursor-pointer text-[11px] font-680 text-rieul-text-2">
                {props.content.uri}
              </summary>
              <pre class="mb-0 max-h-[260px] overflow-auto whitespace-pre-wrap text-[11px] leading-[1.5] text-rieul-text-3">
                {props.content.text}
              </pre>
            </details>
          );
        }
        if (props.content.type === "resourceLink") {
          const href = safeResourceHref(props.content.uri);
          if (!href) {
            return (
              <span class="text-[12px] text-rieul-text-3">
                {props.content.name ?? props.content.uri}
              </span>
            );
          }
          return (
            <a
              class="inline-flex items-center gap-[4px] text-[12px] text-rieul-accent hover:underline"
              href={href}
              target="_blank"
              rel="noreferrer"
            >
              <ChevronRight size={11} />
              {props.content.name ?? props.content.uri}
            </a>
          );
        }
        return (
          <div class="text-[11px] italic text-rieul-text-3">
            Image content · {props.content.mimeType}
          </div>
        );
      })()}
    </>
  );
}
function safeResourceHref(uri: string): string | undefined {
  try {
    const url = new URL(uri);
    return url.protocol === "https:" || url.protocol === "http:"
      ? url.href
      : undefined;
  } catch {
    return undefined;
  }
}
function mergeAdjacentTextContent(content: AgentContent[]): AgentContent[] {
  const merged: AgentContent[] = [];
  for (const item of content) {
    const previous = merged.at(-1);
    if (item.type === "text" && previous?.type === "text") {
      merged[merged.length - 1] = {
        type: "text",
        text: previous.text + item.text,
      };
    } else {
      merged.push(item);
    }
  }
  return merged;
}
function AgentToolCallView(props: { toolCall: AgentToolCall }) {
  return (
    <>
      {(() => {
        return (
          <article class={toolCardClassName}>
            <div class={toolTitleClassName}>
              <Wrench size={12} className="flex-none text-rieul-text-3" />
              <span class="min-w-0 flex-1 overflow-hidden text-ellipsis whitespace-nowrap">
                {props.toolCall.title}
              </span>
              <span class="text-[10px] font-620 text-rieul-text-3">
                {props.toolCall.status.type}
              </span>
            </div>
            {props.toolCall.locations.map((location, _index) => (
              <div class={toolMetaClassName}>
                {location.path}
                {location.line === undefined ? "" : `:${location.line}`}
              </div>
            ))}
          </article>
        );
      })()}
    </>
  );
}
function AgentTurnFailureView(props: { record: AgentTurnRecord }) {
  return (
    <>
      {(() => {
        if (props.record.turn.state.type !== "failed") return null;
        const failure = props.record.turn.state.failure;
        return (
          <article class={turnFailureClassName} role="alert">
            <div class={turnFailureTitleClassName}>
              <AlertCircle size={13} className="flex-none" />
              <span>Turn failed</span>
            </div>
            <div class={turnFailureMessageClassName}>{failure.message}</div>
            <div class={turnFailureMetaClassName}>
              {failure.code ? <span>Code: {failure.code}</span> : null}
              <span>
                {failure.retryable
                  ? "You can retry this turn."
                  : "Retry is not recommended."}
              </span>
            </div>
          </article>
        );
      })()}
    </>
  );
}
function initialLiveState(): LiveSessionState {
  return {
    configOptions: [],
    latestSeq: 0,
    phase: "connecting",
    turns: [],
    unboundMessages: [],
  };
}
function initialHistoryState(): HistoryState {
  return {
    loading: false,
    throughSeq: 0,
  };
}
function reduceSessionEvent(
  current: LiveSessionState,
  event: AgentSessionEvent,
): LiveSessionState {
  if (event.type === "snapshot") {
    return {
      latestSeq: event.snapshot.latestSeq,
      phase: "live",
      session: event.snapshot.session,
      configOptions: event.snapshot.configOptions,
      turns: event.snapshot.activeTurn ? [event.snapshot.activeTurn] : [],
      unboundMessages: [],
    };
  }
  if (event.seq <= current.latestSeq) return current;
  const next = {
    ...current,
    latestSeq: event.seq,
    phase: "live" as const,
  };
  if (event.type === "sessionUpsert") {
    return {
      ...next,
      session: event.session,
    };
  }
  if (event.type === "turnUpsert") return upsertTurn(next, event.turn);
  if (event.type === "messageUpsert") {
    return upsertMessage(next, event.message);
  }
  if (event.type === "messageContentAppend") {
    return appendMessageContent(next, event.messageId, event.content);
  }
  if (event.type === "toolCallUpsert") {
    return upsertToolCall(next, event.toolCall);
  }
  if (event.type === "toolCallContentAppend") {
    return {
      ...next,
      turns: next.turns.map((record) => ({
        ...record,
        toolCalls: record.toolCalls.map((toolCall) =>
          toolCall.toolCallId === event.toolCallId
            ? {
                ...toolCall,
                content: [...toolCall.content, event.content],
              }
            : toolCall,
        ),
      })),
    };
  }
  if (event.type === "permissionUpsert") {
    return {
      ...next,
      turns: next.turns.map((record) =>
        record.turn.turnId === event.permission.turnId
          ? {
              ...record,
              permissions: upsertById(
                record.permissions,
                event.permission,
                (item) => item.permissionRequestId,
              ),
            }
          : record,
      ),
    };
  }
  if (event.type === "planReplace") {
    const activeIndex = latestTurnIndex(next.turns);
    return activeIndex < 0
      ? next
      : {
          ...next,
          turns: next.turns.map((record, index) =>
            index === activeIndex
              ? {
                  ...record,
                  plan: event.plan,
                }
              : record,
          ),
        };
  }
  if (event.type === "terminalUpsert") {
    const activeIndex = latestTurnIndex(next.turns);
    return activeIndex < 0
      ? next
      : {
          ...next,
          turns: next.turns.map((record, index) =>
            index === activeIndex
              ? {
                  ...record,
                  terminals: upsertById(
                    record.terminals,
                    event.terminal,
                    (item) => item.terminalId,
                  ),
                }
              : record,
          ),
        };
  }
  if (event.type === "configOptionsReplace") {
    return {
      ...next,
      configOptions: event.options,
    };
  }
  return next;
}
function upsertTurn(
  current: LiveSessionState,
  turn: AgentTurnInfo,
): LiveSessionState {
  const existing = current.turns.find(
    (record) => record.turn.turnId === turn.turnId,
  );
  const record: AgentTurnRecord = existing
    ? {
        ...existing,
        turn,
      }
    : {
        messages: [],
        permissions: [],
        terminals: [],
        toolCalls: [],
        turn,
      };
  return {
    ...current,
    turns: upsertById(current.turns, record, (item) => item.turn.turnId),
  };
}
function mergeTurnHistory(
  current: LiveSessionState,
  history: AgentTurnRecord[],
): LiveSessionState {
  const turns = new Map(history.map((record) => [record.turn.turnId, record]));
  for (const record of current.turns) {
    turns.set(record.turn.turnId, record);
  }
  return {
    ...current,
    turns: [...turns.values()].sort(
      (left, right) =>
        left.turn.createdAtMs - right.turn.createdAtMs ||
        left.turn.turnId.localeCompare(right.turn.turnId),
    ),
  };
}
function upsertMessage(
  current: LiveSessionState,
  message: AgentMessage,
): LiveSessionState {
  if (!message.turnId) {
    return {
      ...current,
      unboundMessages: upsertById(
        current.unboundMessages,
        message,
        (item) => item.messageId,
      ),
    };
  }
  const withTurn = current.turns.some(
    (record) => record.turn.turnId === message.turnId,
  )
    ? current
    : upsertTurn(current, {
        createdAtMs: message.createdAtMs,
        sessionId: current.session?.summary.sessionId ?? "",
        state: {
          type: "running",
        },
        turnId: message.turnId,
      });
  return {
    ...withTurn,
    turns: withTurn.turns.map((record) =>
      record.turn.turnId === message.turnId
        ? {
            ...record,
            messages: upsertById(
              record.messages,
              message,
              (item) => item.messageId,
            ),
          }
        : record,
    ),
  };
}
function appendMessageContent(
  current: LiveSessionState,
  messageId: string,
  content: AgentContent,
): LiveSessionState {
  return {
    ...current,
    turns: current.turns.map((record) => ({
      ...record,
      messages: record.messages.map((message) =>
        message.messageId === messageId
          ? {
              ...message,
              content: [...message.content, content],
            }
          : message,
      ),
    })),
    unboundMessages: current.unboundMessages.map((message) =>
      message.messageId === messageId
        ? {
            ...message,
            content: [...message.content, content],
          }
        : message,
    ),
  };
}
function upsertToolCall(
  current: LiveSessionState,
  toolCall: AgentToolCall,
): LiveSessionState {
  const withTurn = current.turns.some(
    (record) => record.turn.turnId === toolCall.turnId,
  )
    ? current
    : upsertTurn(current, {
        createdAtMs: Date.now(),
        sessionId: current.session?.summary.sessionId ?? "",
        state: {
          type: "running",
        },
        turnId: toolCall.turnId,
      });
  return {
    ...withTurn,
    turns: withTurn.turns.map((record) =>
      record.turn.turnId === toolCall.turnId
        ? {
            ...record,
            toolCalls: upsertById(
              record.toolCalls,
              toolCall,
              (item) => item.toolCallId,
            ),
          }
        : record,
    ),
  };
}
function latestTurnIndex(turns: AgentTurnRecord[]): number {
  if (turns.length === 0) return -1;
  return turns.reduce(
    (latest, turn, index) =>
      turn.turn.createdAtMs > turns[latest].turn.createdAtMs ? index : latest,
    0,
  );
}
function isFinishedTurn(turn: AgentTurnInfo): boolean {
  return (
    turn.state.type === "completed" ||
    turn.state.type === "cancelled" ||
    turn.state.type === "failed"
  );
}
function upsertById<T>(current: T[], item: T, id: (value: T) => string): T[] {
  const itemId = id(item);
  const index = current.findIndex((value) => id(value) === itemId);
  if (index < 0) return [...current, item];
  return current.map((value, currentIndex) =>
    currentIndex === index ? item : value,
  );
}
function composerPlaceholder(
  state: LiveSessionState,
  turnBusy: boolean,
): string {
  if (state.phase === "connecting") return "Connecting to the session…";
  if (state.phase === "error") return "Session unavailable";
  if (turnBusy) return "Wait for the current turn to finish…";
  if (state.session?.summary.attachment !== AgentAttachmentState.Attached) {
    return "The agent process is not attached";
  }
  return "Message the agent…";
}
function autoReconnectDelayMs(timeoutCount: number): number {
  if (timeoutCount <= 0) return 0;
  return Math.min(1_000 * 2 ** (timeoutCount - 1), MAX_AUTO_RECONNECT_DELAY_MS);
}
function isTimeoutError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /\b(?:timed out|timeout)\b/i.test(message);
}
function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
