import type {
  ClientsTableEvent,
  TerminalSessionInfo,
  TerminalSessionsTableEvent,
} from "../../../../protocol/generated/rpc.ts";
import type { ConnectionState } from "../../../../state/types.ts";
import type { BreadcrumbItem } from "../../../ui/breadcrumb.tsx";
import { createSignal, createMemo, createEffect } from "solid-js";
import { useAtomValue } from "../../../../solid/jotai.tsx";
import { useBunja } from "../../../../solid/bunja.tsx";
import { nowBunja } from "../../../../state/now.ts";
import {
  AlertTriangle,
  CheckCircle2,
  ChevronRight,
  Info,
  Loader2,
  SquareTerminal,
  Trash2,
  WifiOff,
} from "../../../../solid/icons.tsx";
import {
  closeTerminalSession,
  removeClient,
  renewClientCredential,
  subscribeClients,
  subscribeTerminalSessions,
} from "../../../../protocol/generated/client.ts";
import { procs } from "../../../../protocol/generated/rpc.ts";
import type { ClientInfo } from "../../../../protocol/generated/rpc.ts";
import { machineStoreBunja } from "../../../../state/machine-store.ts";
import { rpcSessionBunja } from "../../../../state/rpc-session.ts";
import {
  workbenchBunja,
  workbenchTabBunja,
} from "../../../../state/workbench.ts";
import { Button } from "../../../ui/button.tsx";
import { Breadcrumb } from "../../../ui/breadcrumb.tsx";
import {
  PropertyList,
  PropertyListItem,
  PropertyValue,
} from "../../../ui/property-list.tsx";
function procName(procId: number): string {
  return procs[procId as keyof typeof procs]?.name ?? `Proc ${procId}`;
}
const daemonToolClassName = [
  "grid h-full min-h-0 w-full [grid-template-rows:auto_minmax(0,1fr)]",
  "overflow-hidden bg-white",
  "text-[#20242d]",
].join(" ");
const daemonContentClassName = "min-h-0 overflow-auto p-[1rem]";
const statusPillClassName = [
  "inline-flex flex-[0_0_auto] items-center gap-[0.5rem] min-w-0 rounded-[999px]",
  "bg-[#eef3fb] px-[9px] py-[4px] text-[1rem] font-700 text-[#344054]",
  "[&_svg]:flex-[0_0_auto]",
  "[&.reachable]:bg-[#ecfdf3] [&.reachable]:text-[#027a48]",
  "[&.offline]:bg-[#fff1f3] [&.offline]:text-[#b42318]",
].join(" ");
const daemonHeaderClassName = [
  "flex h-[2rem] min-h-[2rem] min-w-0 items-center justify-between gap-[1rem]",
  "overflow-hidden border-b border-b-[#d8dde7] bg-[#fbfcfe] px-[0.5rem]",
].join(" ");
const summaryNoteClassName = "text-[#667085]";
const procSectionClassName = "mt-[18px] min-w-0";
const procSectionTitleClassName =
  "mb-[8px] text-[1rem] font-800 text-[#667085]";
const sectionTitleButtonClassName = [
  "mb-[8px] inline-flex h-[24px] appearance-none items-center gap-[3px] rounded-[0.5rem]",
  "cursor-pointer border-transparent bg-transparent px-[4px] text-[1rem]",
  "font-800 text-[#667085] [font-family:inherit]",
  "hover:bg-[#eef3fb] hover:text-[#344054]",
  "[&_svg]:flex-[0_0_auto]",
].join(" ");
const clientsSectionClassName = "mt-[18px] min-w-0";
const clientOverviewCardClassName = [
  "min-w-0 rounded-[8px] border border-[#d8dde7] bg-[#fbfcfe]",
  "grid gap-[8px] px-[1rem] py-[1rem] text-[14px] text-[#667085]",
].join(" ");
const clientOverviewCurrentButtonClassName = [
  "grid min-w-0 appearance-none gap-[3px] rounded-[0.5rem] px-[8px] py-[7px] text-left",
  "cursor-pointer text-[#344054] hover:bg-[#eef3fb]",
  "[font-family:inherit]",
  "[&_strong]:min-w-0 [&_strong]:overflow-hidden [&_strong]:text-ellipsis",
  "[&_strong]:whitespace-nowrap [&_strong]:text-[14px] [&_strong]:font-750",
  "[&_span]:min-w-0 [&_span]:overflow-hidden [&_span]:text-ellipsis",
  "[&_span]:whitespace-nowrap [&_span]:text-[12px] [&_span]:text-[#667085]",
].join(" ");
const clientOverviewMetaClassName =
  "px-[8px] text-[1rem] font-650 text-[#667085]";
const clientOverviewMetaButtonClassName = [
  "inline min-h-0 appearance-none justify-self-start gap-0 border-0 rounded-0",
  "cursor-pointer bg-transparent p-0 text-left text-[1rem] font-650 text-[#667085]",
  "[font-family:inherit]",
  "hover:border-transparent hover:bg-transparent hover:text-[#344054]",
].join(" ");
const clientListClassName = [
  "grid content-start gap-[0.5rem] min-w-0 rounded-[8px]",
  "border border-[#d8dde7] bg-[#fbfcfe] p-[0.5rem]",
].join(" ");
const clientListItemClassName = [
  "grid min-w-0 grid-cols-[minmax(0,1fr)_auto] items-center rounded-[0.5rem]",
  "border border-transparent bg-white",
].join(" ");
const clientButtonClassName = [
  "grid min-w-0 appearance-none gap-[3px] rounded-l-[0.5rem] px-[1rem] py-[8px] text-left",
  "cursor-pointer text-[#344054] hover:bg-[#eef3fb]",
  "[font-family:inherit]",
  "[&.selected]:bg-[#e8eef7] [&.selected]:text-[#20242d]",
  "[&_strong]:min-w-0 [&_strong]:overflow-hidden [&_strong]:text-ellipsis",
  "[&_strong]:whitespace-nowrap [&_strong]:text-[14px] [&_strong]:font-750",
  "[&_span]:min-w-0 [&_span]:overflow-hidden [&_span]:text-ellipsis",
  "[&_span]:whitespace-nowrap [&_span]:text-[12px] [&_span]:text-[#667085]",
].join(" ");
const clientListRemoveButtonClassName = "mr-[0.5rem]";
const clientListConfirmationClassName = [
  "col-span-2 flex min-w-0 flex-wrap items-center gap-[0.5rem]",
  "border-t border-t-[#edf0f5] px-[1rem] py-[0.5rem]",
].join(" ");
const clientListConfirmationMessageClassName =
  "mr-auto text-[1rem] text-[#667085]";
const clientListErrorClassName = "mr-auto text-[1rem] text-[#b42318]";
const clientNameRowClassName = "flex min-w-0 items-center gap-[0.5rem]";
const currentClientBadgeClassName = [
  "flex-[0_0_auto] rounded-[999px] bg-[#dff6e7] px-[0.5rem] py-[1px]",
  "text-[1rem] not-italic font-800 text-[#027a48]",
].join(" ");
const clientInfoCurrentClientBadgeClassName = [
  "flex-[0_0_auto] rounded-[999px] bg-[#dff6e7] px-[0.5rem] py-[1px]",
  "text-[1rem] not-italic text-[#027a48]",
].join(" ");
const clientDetailPageClassName = "grid min-w-0 gap-[14px]";
const clientDetailSectionClassName = [
  "min-w-0 overflow-hidden rounded-[8px] border border-[#d8dde7] bg-white",
].join(" ");
const clientDetailSectionHeaderClassName = [
  "flex min-h-[48px] min-w-0 items-center justify-between gap-[1rem]",
  "border-b border-b-[#d8dde7] bg-[#fbfcfe] px-[1rem] py-[9px]",
  "[&_h2]:m-0 [&_h2]:min-w-0 [&_h2]:overflow-hidden",
  "[&_h2]:text-ellipsis [&_h2]:whitespace-nowrap",
  "[&_h2]:text-[1rem] [&_h2]:font-800",
  "[&_h2]:text-[#667085]",
  "[&_span]:flex-[0_0_auto] [&_span]:text-[1rem]",
  "[&_span]:font-650 [&_span]:text-[#667085]",
].join(" ");
const clientIdValueClassName = "flex min-w-0 flex-wrap items-center gap-[7px]";
const credentialExpiryRemainingClassName = "text-[1rem] text-[#667085]";
const credentialCreatedAgeClassName = credentialExpiryRemainingClassName;
const renewCredentialButtonClassName = "!min-h-[28px] !px-[9px] !text-[1rem]";
const renewCredentialMessageClassName = "text-[1rem] text-[#667085]";
const renewCredentialErrorClassName = "text-[1rem] text-[#b42318]";
const clientDangerZoneClassName = [
  "flex min-w-0 flex-wrap items-center gap-[0.5rem] border-t border-t-[#edf0f5]",
  "px-[1rem] py-[0.75rem]",
].join(" ");
const clientDangerMessageClassName = "mr-auto text-[1rem] text-[#667085]";
const clientDangerErrorClassName = "mr-auto text-[1rem] text-[#b42318]";
const terminalSessionListClassName = [
  "grid min-w-0",
  "[&_article]:grid [&_article]:min-w-0",
  "[&_article]:grid-cols-[minmax(0,1fr)_auto_auto]",
  "[&_article]:gap-x-[1rem] [&_article]:gap-y-[4px]",
  "[&_article]:items-center",
  "[&_article]:border-b [&_article]:border-b-[#edf0f5]",
  "[&_article]:px-[1rem] [&_article]:py-[1rem]",
  "[&_article:last-child]:border-b-0",
  "[&_strong]:min-w-0 [&_strong]:overflow-hidden [&_strong]:text-ellipsis",
  "[&_strong]:whitespace-nowrap [&_strong]:font-750",
  "[&_span]:text-[#667085]",
  "[&_small]:col-span-3 [&_small]:min-w-0 [&_small]:[overflow-wrap:anywhere]",
  "[&_small]:text-[1rem] [&_small]:text-[#667085]",
].join(" ");
const terminalSessionActionsClassName =
  "flex min-w-0 items-center justify-end gap-[0.5rem]";
const terminalSessionCloseButtonClassName =
  "!min-h-[24px] !px-[1rem] !text-[1rem]";
const clientDetailStateClassName = "p-[1rem] text-[#667085]";
const procTableClassName = [
  "grid overflow-hidden border border-[#d8dde7] rounded-[8px]",
  "bg-white",
  "[&_div]:grid [&_div]:grid-cols-[72px_minmax(0,1fr)]",
  "[&_div]:min-w-0 [&_div]:border-b [&_div]:border-b-[#edf0f5]",
  "[&_div:last-child]:border-b-0",
  "[&_span]:min-w-0 [&_span]:px-[1rem] [&_span]:py-[8px]",
  "[&_span]:text-[14px] [&_span]:[overflow-wrap:anywhere]",
  "[&_span:first-child]:bg-[#fbfcfe] [&_span:first-child]:font-700",
  "[&_span:first-child]:text-[#667085]",
].join(" ");
const messageStateClassName = [
  "grid h-full min-h-[220px] place-items-center text-center",
  "[&_div]:grid [&_div]:justify-items-center [&_div]:gap-[8px]",
  "[&_svg]:text-[#98a2b3]",
  "[&_strong]:text-[15px] [&_strong]:text-[#20242d]",
  "[&_p]:m-0 [&_p]:max-w-[420px] [&_p]:text-[14px] [&_p]:text-[#667085]",
].join(" ");
interface ClientsState {
  clients: ClientInfo[];
  message?: string;
  phase: "idle" | "loading" | "ready" | "error";
}
interface TerminalSessionsState {
  message?: string;
  phase: "idle" | "loading" | "ready" | "error";
  sessions: TerminalSessionInfo[];
}
export function DaemonTool() {
  const machines = useBunja(machineStoreBunja);
  const rpcSession = useBunja(rpcSessionBunja);
  const tabState = useBunja(workbenchTabBunja);
  const workbench = useBunja(workbenchBunja);
  const daemonInfo = useAtomValue(() => rpcSession().daemonInfoAtom);
  const readyDaemonInfo = createMemo(() => {
    const value = daemonInfo();
    return value.phase === "ready" ? value.daemonInfo : undefined;
  });
  const daemonServerTimeMs = useAtomValue(
    () => rpcSession().daemonServerTimeMsAtom,
  );
  const daemonUptimeSeconds = useAtomValue(
    () => rpcSession().daemonUptimeSecondsAtom,
  );
  const connection = useAtomValue(() => rpcSession().connectionAtom);
  const daemonInstanceId = useAtomValue(
    () => rpcSession().daemonInstanceIdAtom,
  );
  const machine = useAtomValue(() => machines().selectedAtom);
  const isPaired = useAtomValue(() => machines().selectedIsPairedAtom);
  const tab = useAtomValue(() => tabState().tabAtom);
  const connectionLabel = createMemo(() =>
    formatDaemonConnectionLabel(connection()),
  );
  const [clientsState, setClientsState] = createSignal<ClientsState>({
    clients: [],
    phase: "idle",
  });
  const [terminalSessionsState, setTerminalSessionsState] =
    createSignal<TerminalSessionsState>({
      phase: "idle",
      sessions: [],
    });
  const clientsRef = {
    current: [] as ClientInfo[],
  };
  const clientDetailId = createMemo(() => tab()?.daemonClientDetailId);
  const clientsPageOpen = createMemo(
    () =>
      tab()?.daemonClientsPageOpen === true || clientDetailId() !== undefined,
  );
  const clientDetailIdRef = {
    current: undefined as string | undefined,
  };
  createEffect(
    createMemo(() => [clientDetailId()] as const, {
      equals: (a, b) =>
        a.length === b.length &&
        a.every((value, index) => Object.is(value, b[index])),
    }),
    ([snapshotClientDetailId]) => {
      clientDetailIdRef.current = snapshotClientDetailId;
    },
  );
  createEffect(
    createMemo(
      () =>
        [
          daemonInfo().phase,
          isPaired(),
          machine()?.baseUrl,
          machine()?.clientId,
          machine()?.clientSecret,
          machine()?.id,
          daemonInstanceId(),
          rpcSession(),
          tabState(),
        ] as const,
      {
        equals: (a, b) =>
          a.length === b.length &&
          a.every((value, index) => Object.is(value, b[index])),
      },
    ),
    ([
      snapshotDaemonInfoPhase,
      snapshotIsPaired,
      ,
      ,
      ,
      snapshotMachineId,
      ,
      snapshotRpcSession,
      snapshotTabState,
    ]) => {
      if (!snapshotMachineId) {
        clientsRef.current = [];
        setClientsState({
          clients: [],
          phase: "idle",
        });
        snapshotTabState.setDaemonClientDetailId(undefined);
        snapshotTabState.setDaemonClientsPageOpen(false);
        return;
      }
      if (!snapshotIsPaired) {
        clientsRef.current = [];
        setClientsState({
          clients: [],
          message: "Pairing required to view clients",
          phase: "error",
        });
        snapshotTabState.setDaemonClientDetailId(undefined);
        snapshotTabState.setDaemonClientsPageOpen(false);
        return;
      }
      if (snapshotDaemonInfoPhase !== "ready") {
        clientsRef.current = [];
        setClientsState({
          clients: [],
          phase: "idle",
        });
        return;
      }
      let cancelled = false;
      let iterator: AsyncGenerator<ClientsTableEvent> | undefined;
      setClientsState((current) => ({
        ...current,
        phase: "loading",
      }));
      void (async () => {
        try {
          const transport = await snapshotRpcSession.webTransport();
          if (cancelled) return;
          iterator = subscribeClients(transport);
          for await (const event of iterator) {
            if (cancelled) return;
            const clients = applyClientsEvent(clientsRef.current, event);
            clientsRef.current = clients;
            setClientsState({
              clients,
              phase: "ready",
            });
            const currentClientDetailId = clientDetailIdRef.current;
            if (
              currentClientDetailId &&
              !clients.some(
                (client) => client.clientId === currentClientDetailId,
              )
            ) {
              snapshotTabState.setDaemonClientDetailId(undefined);
              snapshotTabState.setDaemonClientsPageOpen(true);
            }
          }
        } catch (err) {
          if (cancelled) return;
          clientsRef.current = [];
          setClientsState({
            clients: [],
            message: errorMessage(err),
            phase: "error",
          });
        }
      })();
      return () => {
        cancelled = true;
        void iterator?.return(undefined);
      };
    },
  );
  createEffect(
    createMemo(
      () =>
        [
          daemonInfo().phase,
          isPaired(),
          machine()?.baseUrl,
          machine()?.clientId,
          machine()?.clientSecret,
          machine()?.id,
          daemonInstanceId(),
          rpcSession(),
          tabState(),
        ] as const,
      {
        equals: (a, b) =>
          a.length === b.length &&
          a.every((value, index) => Object.is(value, b[index])),
      },
    ),
    ([
      snapshotDaemonInfoPhase,
      snapshotIsPaired,
      ,
      ,
      ,
      snapshotMachineId,
      ,
      snapshotRpcSession,
      ,
    ]) => {
      if (!snapshotMachineId || snapshotDaemonInfoPhase !== "ready") {
        setTerminalSessionsState({
          phase: "idle",
          sessions: [],
        });
        return;
      }
      if (!snapshotIsPaired) {
        setTerminalSessionsState({
          phase: "idle",
          sessions: [],
        });
        return;
      }
      let cancelled = false;
      let iterator: AsyncGenerator<TerminalSessionsTableEvent> | undefined;
      setTerminalSessionsState((current) => ({
        ...current,
        phase: "loading",
      }));
      void (async () => {
        try {
          const transport = await snapshotRpcSession.webTransport();
          if (cancelled) return;
          iterator = subscribeTerminalSessions(transport);
          for await (const event of iterator) {
            if (cancelled) return;
            setTerminalSessionsState((current) => ({
              phase: "ready",
              sessions: applyTerminalSessionsEvent(current.sessions, event),
            }));
          }
        } catch (err) {
          if (cancelled) return;
          setTerminalSessionsState({
            message: errorMessage(err),
            phase: "error",
            sessions: [],
          });
        }
      })();
      return () => {
        cancelled = true;
        void iterator?.return(undefined);
      };
    },
  );
  function openRootPage() {
    tabState().setDaemonClientDetailId(undefined);
    tabState().setDaemonClientsPageOpen(false);
  }
  function openClientsPage() {
    tabState().setDaemonClientDetailId(undefined);
    tabState().setDaemonClientsPageOpen(true);
  }
  function openClientDetail(clientId: string) {
    tabState().setDaemonClientsPageOpen(true);
    tabState().setDaemonClientDetailId(clientId);
  }
  async function renewSelectedClientCredential() {
    if (!machine()) return;
    const renewal = await renewClientCredential(
      await rpcSession().webTransport(),
    );
    if (machine()!.clientId === clientDetailId()) {
      machines().setMachineCredentialExpiry(
        machine()!.id,
        renewal.clientCredentialExpiresAtUnix,
      );
    }
  }
  async function closeSelectedTerminalSession(terminalSessionId: string) {
    if (!machine()) return;
    await closeTerminalSession(await rpcSession().webTransport(), {
      terminalSessionId,
    });
  }
  async function removeSelectedClient(clientId: string) {
    if (!machine()) return;
    await removeClient(await rpcSession().webTransport(), {
      clientId,
    });
    if (machine()!.clientId === clientId) {
      machines().clearMachineCredentials(machine()!.id);
    }
  }
  function openTerminalSession(session: TerminalSessionInfo) {
    workbench().openTerminalTab({
      cwd: session.lastKnownCwd,
      launch: session.launch,
      terminalSessionId: session.terminalSessionId,
      terminalTitle: session.lastKnownTitle,
      title: terminalSessionTabTitle(session),
    });
  }
  return (
    <>
      {(() => {
        return (
          <section class={daemonToolClassName}>
            <div class={daemonHeaderClassName}>
              <DaemonBreadcrumb
                clientsPageOpen={clientsPageOpen()}
                clientDetailId={clientDetailId()}
                onOpenClients={openClientsPage}
                onOpenRoot={openRootPage}
              />
              {clientsPageOpen() ? null : (
                <span class={`${statusPillClassName} ${connection().phase}`}>
                  {connection().phase === "reachable" ? (
                    <CheckCircle2 size={13} />
                  ) : connection().phase === "offline" ? (
                    <WifiOff size={13} />
                  ) : (
                    <Info size={13} />
                  )}
                  {connectionLabel()}
                </span>
              )}
            </div>
            <div class={daemonContentClassName}>
              {daemonInfo().phase === "ready" ? (
                <DaemonInfoView
                  endpoint={machine()?.baseUrl}
                  instanceId={readyDaemonInfo()!.instanceId}
                  os={readyDaemonInfo()!.os}
                  serverTimeMs={daemonServerTimeMs()}
                  startedAtMs={readyDaemonInfo()!.startedAtMs}
                  supportedProcIds={readyDaemonInfo()!.supportedProcIds}
                  uptimeSeconds={daemonUptimeSeconds()}
                  version={readyDaemonInfo()!.version}
                  clientsPageOpen={clientsPageOpen()}
                  clientsState={clientsState()}
                  clientDetailId={clientDetailId()}
                  currentClientId={machine()?.clientId}
                  terminalSessionsState={terminalSessionsState()}
                  onOpenClient={openClientDetail}
                  onOpenClients={openClientsPage}
                  onCloseTerminalSession={closeSelectedTerminalSession}
                  onOpenTerminalSession={openTerminalSession}
                  onRemoveClient={removeSelectedClient}
                  onRenewCurrentClientCredential={renewSelectedClientCredential}
                />
              ) : (
                <DaemonInfoStateView
                  hasMachine={machine() !== undefined}
                  phase={
                    daemonInfo().phase === "ready"
                      ? "idle"
                      : (daemonInfo().phase as "idle" | "error" | "loading")
                  }
                  message={(() => {
                    const value = daemonInfo();
                    return value.phase === "error" ? value.message : undefined;
                  })()}
                />
              )}
            </div>
          </section>
        );
      })()}
    </>
  );
}
function formatDaemonConnectionLabel(connection: ConnectionState): string {
  if (connection.phase === "reachable") {
    if (connection.rttMs === undefined) return "Connected";
    return `Connected - latency ${connection.rttMs} ms`;
  }
  if (connection.phase === "idle") return "No machine selected";
  return "Unconnected";
}
interface DaemonBreadcrumbProps {
  clientsPageOpen: boolean;
  clientDetailId?: string;
  onOpenClients: () => void;
  onOpenRoot: () => void;
}
function DaemonBreadcrumb(props: DaemonBreadcrumbProps) {
  const clientLabel = createMemo(() => props.clientDetailId || "Client detail");
  return (
    <>
      {(() => {
        const items: BreadcrumbItem[] = [
          {
            label: "Daemon",
            onClick: props.clientsPageOpen ? props.onOpenRoot : undefined,
          },
        ];
        if (props.clientDetailId) {
          items.push(
            {
              label: "Clients",
              onClick: props.onOpenClients,
            },
            {
              label: clientLabel(),
              title: clientLabel(),
            },
          );
        } else if (props.clientsPageOpen) {
          items.push({
            label: "Clients",
          });
        } else {
          items.push({
            label: "Overview",
            muted: true,
          });
        }
        return (
          <Breadcrumb
            ariaLabel="Daemon location"
            className="flex-[1_1_auto]"
            items={items}
          />
        );
      })()}
    </>
  );
}
function applyTerminalSessionsEvent(
  current: TerminalSessionInfo[],
  event: TerminalSessionsTableEvent,
): TerminalSessionInfo[] {
  if (event.type === "snapshot") return event.rows;
  const removed = new Set(event.removes.map((row) => row.terminalSessionId));
  const next = current.filter(
    (session) => !removed.has(session.terminalSessionId),
  );
  for (const session of event.upserts) {
    const index = next.findIndex(
      (currentSession) =>
        currentSession.terminalSessionId === session.terminalSessionId,
    );
    if (index >= 0) next[index] = session;
    else next.push(session);
  }
  return next;
}
function applyClientsEvent(
  current: ClientInfo[],
  event: ClientsTableEvent,
): ClientInfo[] {
  if (event.type === "snapshot") return event.rows;
  const removed = new Set(event.removes.map((row) => row.clientId));
  const next = current.filter((client) => !removed.has(client.clientId));
  for (const client of event.upserts) {
    const index = next.findIndex(
      (currentClient) => currentClient.clientId === client.clientId,
    );
    if (index >= 0) next[index] = client;
    else next.push(client);
  }
  return next;
}
interface DaemonInfoViewProps {
  clientsPageOpen: boolean;
  clientDetailId?: string;
  clientsState: ClientsState;
  currentClientId?: string;
  endpoint?: string;
  instanceId: string;
  onCloseTerminalSession: (terminalSessionId: string) => Promise<void>;
  onOpenClient: (clientId: string) => void;
  onOpenTerminalSession: (session: TerminalSessionInfo) => void;
  onRemoveClient: (clientId: string) => Promise<void>;
  os: string;
  onRenewCurrentClientCredential: () => Promise<void>;
  serverTimeMs?: number;
  startedAtMs: number;
  supportedProcIds: number[];
  terminalSessionsState: TerminalSessionsState;
  onOpenClients: () => void;
  uptimeSeconds?: number;
  version: string;
}
function DaemonInfoView(props: DaemonInfoViewProps) {
  const clientDetail = createMemo(() =>
    props.clientDetailId
      ? props.clientsState.clients.find(
          (client) => client.clientId === props.clientDetailId,
        )
      : undefined,
  );
  return (
    <>
      {(() => {
        if (clientDetail()) {
          return (
            <ClientDetailPage
              client={clientDetail()!}
              currentClientId={props.currentClientId}
              onRenewCurrentClientCredential={
                props.onRenewCurrentClientCredential
              }
              onCloseTerminalSession={props.onCloseTerminalSession}
              onOpenTerminalSession={props.onOpenTerminalSession}
              onRemoveClient={props.onRemoveClient}
              sessions={props.terminalSessionsState.sessions.filter(
                (session) =>
                  session.creatorClientId === clientDetail()!.clientId,
              )}
              state={props.terminalSessionsState}
            />
          );
        }
        if (props.clientDetailId && props.clientsState.phase !== "ready") {
          return (
            <ClientDetailPendingPage
              message={clientDetailPendingMessage(props.clientsState)}
            />
          );
        }
        if (props.clientsPageOpen) {
          return (
            <ClientsPage
              clientsState={props.clientsState}
              currentClientId={props.currentClientId}
              onOpenClient={props.onOpenClient}
              onRemoveClient={props.onRemoveClient}
            />
          );
        }
        return (
          <>
            <PropertyList>
              <PropertyListItem label="Endpoint">
                <PropertyValue>{props.endpoint ?? "Unknown"}</PropertyValue>
              </PropertyListItem>
              <PropertyListItem label="Daemon version">
                <PropertyValue>{props.version}</PropertyValue>
              </PropertyListItem>
              <PropertyListItem label="Machine OS">
                <PropertyValue>{props.os}</PropertyValue>
              </PropertyListItem>
              <PropertyListItem label="Daemon instance ID">
                <PropertyValue>{props.instanceId}</PropertyValue>
                <span class={summaryNoteClassName}>
                  Changes every time the daemon starts.
                </span>
              </PropertyListItem>
              <PropertyListItem label="Daemon time">
                <PropertyValue>
                  {formatDaemonTimestamp(props.serverTimeMs)}
                </PropertyValue>
              </PropertyListItem>
              <PropertyListItem label="Daemon started">
                <PropertyValue>
                  {formatDaemonTimestamp(props.startedAtMs)}
                </PropertyValue>
                <span class={summaryNoteClassName}>
                  Uptime {formatDaemonUptime(props.uptimeSeconds)}
                </span>
              </PropertyListItem>
            </PropertyList>

            <ClientsOverviewSection
              clientsState={props.clientsState}
              currentClientId={props.currentClientId}
              onOpenClient={props.onOpenClient}
              onOpenClients={props.onOpenClients}
            />

            <section class={procSectionClassName}>
              <div class={procSectionTitleClassName}>Supported RPC</div>
              <div class={procTableClassName}>
                {props.supportedProcIds.map((procId) => (
                  <div>
                    <span>{procId}</span>
                    <span>{procName(procId)}</span>
                  </div>
                ))}
              </div>
            </section>
          </>
        );
      })()}
    </>
  );
}
interface ClientsOverviewSectionProps {
  clientsState: ClientsState;
  currentClientId?: string;
  onOpenClient: (clientId: string) => void;
  onOpenClients: () => void;
}
function ClientsOverviewSection(props: ClientsOverviewSectionProps) {
  return (
    <>
      {(() => {
        return (
          <section class={clientsSectionClassName}>
            <button
              type="button"
              class={sectionTitleButtonClassName}
              onClick={props.onOpenClients}
            >
              Clients
              <ChevronRight size={13} />
            </button>
            <div class={clientOverviewCardClassName}>
              <ClientsOverviewContent
                clientsState={props.clientsState}
                currentClientId={props.currentClientId}
                onOpenClient={props.onOpenClient}
                onOpenClients={props.onOpenClients}
              />
            </div>
          </section>
        );
      })()}
    </>
  );
}
interface ClientsOverviewContentProps {
  clientsState: ClientsState;
  currentClientId?: string;
  onOpenClient: (clientId: string) => void;
  onOpenClients: () => void;
}
function ClientsOverviewContent(props: ClientsOverviewContentProps) {
  return (
    <>
      {(() => {
        if (props.clientsState.phase !== "ready") {
          return <span>{clientsOverviewLabel(props.clientsState)}</span>;
        }
        const currentClient = createMemo(() =>
          props.currentClientId
            ? props.clientsState.clients.find(
                (client) => client.clientId === props.currentClientId,
              )
            : undefined,
        );
        if (!currentClient()) {
          return (
            <>
              <span>{clientsOverviewLabel(props.clientsState)}</span>
              <span class={clientOverviewMetaClassName}>
                This client is not in the daemon client list.
              </span>
            </>
          );
        }
        const otherClientCount = createMemo(
          () => props.clientsState.clients.length - 1,
        );
        return (
          <>
            <button
              type="button"
              class={clientOverviewCurrentButtonClassName}
              onClick={() => props.onOpenClient(currentClient()!.clientId)}
            >
              <div class={clientNameRowClassName}>
                <strong>{currentClient()!.label || "Unnamed client"}</strong>
                <em class={currentClientBadgeClassName}>This client</em>
              </div>
              <span>{currentClient()!.clientId}</span>
            </button>
            <button
              type="button"
              class={clientOverviewMetaButtonClassName}
              onClick={props.onOpenClients}
            >
              {otherClientsLabel(otherClientCount())}
            </button>
          </>
        );
      })()}
    </>
  );
}
interface ClientsPageProps {
  clientsState: ClientsState;
  currentClientId?: string;
  onOpenClient: (clientId: string) => void;
  onRemoveClient: (clientId: string) => Promise<void>;
}
function ClientsPage(props: ClientsPageProps) {
  return (
    <>
      {(() => {
        return (
          <section class={clientDetailPageClassName}>
            <ClientsSection
              clientsState={props.clientsState}
              currentClientId={props.currentClientId}
              onOpenClient={props.onOpenClient}
              onRemoveClient={props.onRemoveClient}
            />
          </section>
        );
      })()}
    </>
  );
}
interface ClientDetailPendingPageProps {
  message: string;
}
function ClientDetailPendingPage(props: ClientDetailPendingPageProps) {
  return (
    <>
      {(() => {
        return (
          <section class={clientDetailPageClassName}>
            <InlineState message={props.message} />
          </section>
        );
      })()}
    </>
  );
}
interface ClientsSectionProps {
  clientsState: ClientsState;
  currentClientId?: string;
  onOpenClient: (clientId: string) => void;
  onRemoveClient: (clientId: string) => Promise<void>;
}
function ClientsSection(props: ClientsSectionProps) {
  return (
    <>
      {(() => {
        return (
          <section class={clientsSectionClassName}>
            <div class={procSectionTitleClassName}>Clients</div>
            {props.clientsState.phase === "error" ? (
              <InlineState
                message={props.clientsState.message ?? "Client list failed"}
              />
            ) : props.clientsState.phase === "loading" ? (
              <InlineState message="Loading clients" />
            ) : props.clientsState.clients.length === 0 ? (
              <InlineState message="No paired clients" />
            ) : (
              <div class={clientListClassName}>
                {props.clientsState.clients.map((client) => (
                  <ClientListItem
                    client={client}
                    currentClientId={props.currentClientId}
                    onOpenClient={props.onOpenClient}
                    onRemoveClient={props.onRemoveClient}
                  />
                ))}
              </div>
            )}
          </section>
        );
      })()}
    </>
  );
}
interface ClientListItemProps {
  client: ClientInfo;
  currentClientId?: string;
  onOpenClient: (clientId: string) => void;
  onRemoveClient: (clientId: string) => Promise<void>;
}
function ClientListItem(props: ClientListItemProps) {
  const isCurrent = createMemo(
    () => props.client.clientId === props.currentClientId,
  );
  const [removePhase, setRemovePhase] = createSignal<
    "idle" | "confirming" | "removing" | "error"
  >("idle");
  const [removeError, setRemoveError] = createSignal<string>();
  async function removeNow() {
    setRemovePhase("removing");
    setRemoveError(undefined);
    try {
      await props.onRemoveClient(props.client.clientId);
    } catch (err) {
      setRemoveError(errorMessage(err));
      setRemovePhase("error");
    }
  }
  return (
    <>
      {(() => {
        return (
          <article class={clientListItemClassName}>
            <button
              type="button"
              class={clientButtonClassName}
              onClick={() => props.onOpenClient(props.client.clientId)}
            >
              <div class={clientNameRowClassName}>
                <strong>{props.client.label || "Unnamed client"}</strong>
                {isCurrent() ? (
                  <em class={currentClientBadgeClassName}>This client</em>
                ) : null}
              </div>
              <span>{props.client.clientId}</span>
            </button>
            <Button
              aria-label={`Remove ${props.client.label || props.client.clientId}`}
              className={clientListRemoveButtonClassName}
              disabled={removePhase() === "removing"}
              onClick={() => setRemovePhase("confirming")}
              size="icon"
              title="Remove client"
              tone="danger"
              variant="ghost"
            >
              <Trash2 size={15} />
            </Button>
            {removePhase() === "confirming" || removePhase() === "removing" ? (
              <div class={clientListConfirmationClassName}>
                <span class={clientListConfirmationMessageClassName}>
                  This client will need to pair again.
                </span>
                <Button
                  disabled={removePhase() === "removing"}
                  onClick={() => setRemovePhase("idle")}
                  size="sm"
                  variant="ghost"
                >
                  Cancel
                </Button>
                <Button
                  disabled={removePhase() === "removing"}
                  onClick={removeNow}
                  size="sm"
                  tone="danger"
                  variant="solid"
                >
                  {removePhase() === "removing" ? "Removing" : "Remove"}
                </Button>
              </div>
            ) : removePhase() === "error" ? (
              <div class={clientListConfirmationClassName}>
                <span class={clientListErrorClassName}>
                  {removeError() ?? "Client removal failed"}
                </span>
                <Button
                  onClick={() => setRemovePhase("confirming")}
                  size="sm"
                  tone="danger"
                  variant="outline"
                >
                  Retry
                </Button>
              </div>
            ) : null}
          </article>
        );
      })()}
    </>
  );
}
interface ClientDetailPageProps {
  client: ClientInfo;
  currentClientId?: string;
  onCloseTerminalSession: (terminalSessionId: string) => Promise<void>;
  onOpenTerminalSession: (session: TerminalSessionInfo) => void;
  onRemoveClient: (clientId: string) => Promise<void>;
  onRenewCurrentClientCredential: () => Promise<void>;
  sessions: TerminalSessionInfo[];
  state: TerminalSessionsState;
}
function ClientDetailPage(props: ClientDetailPageProps) {
  return (
    <>
      {(() => {
        return (
          <section class={clientDetailPageClassName}>
            <ClientInformationSection
              client={props.client}
              currentClientId={props.currentClientId}
              onRemoveClient={props.onRemoveClient}
              onRenewCurrentClientCredential={
                props.onRenewCurrentClientCredential
              }
            />
            <ClientTerminalSessions
              onCloseTerminalSession={props.onCloseTerminalSession}
              onOpenTerminalSession={props.onOpenTerminalSession}
              sessions={props.sessions}
              state={props.state}
            />
          </section>
        );
      })()}
    </>
  );
}
interface ClientInformationSectionProps {
  client: ClientInfo;
  currentClientId?: string;
  onRemoveClient: (clientId: string) => Promise<void>;
  onRenewCurrentClientCredential: () => Promise<void>;
}
function ClientInformationSection(props: ClientInformationSectionProps) {
  const now = useBunja(nowBunja);
  const nowMs = useAtomValue(() => now().nowEverySecondAtom);
  const isCurrent = createMemo(
    () => props.client.clientId === props.currentClientId,
  );
  const [renewPhase, setRenewPhase] = createSignal<
    "idle" | "renewing" | "renewed" | "error"
  >("idle");
  const [renewError, setRenewError] = createSignal<string>();
  const [removePhase, setRemovePhase] = createSignal<
    "idle" | "confirming" | "removing" | "error"
  >("idle");
  const [removeError, setRemoveError] = createSignal<string>();
  async function renewNow() {
    setRenewPhase("renewing");
    setRenewError(undefined);
    try {
      await props.onRenewCurrentClientCredential();
      setRenewPhase("renewed");
    } catch (err) {
      setRenewError(errorMessage(err));
      setRenewPhase("error");
    }
  }
  async function removeNow() {
    setRemovePhase("removing");
    setRemoveError(undefined);
    try {
      await props.onRemoveClient(props.client.clientId);
    } catch (err) {
      setRemoveError(errorMessage(err));
      setRemovePhase("error");
    }
  }
  return (
    <>
      {(() => {
        return (
          <section class={clientDetailSectionClassName}>
            <header class={clientDetailSectionHeaderClassName}>
              <h2>Client information</h2>
            </header>
            <PropertyList className="!border-0 !rounded-0 bg-[#edf0f5]">
              <PropertyListItem label="Label">
                <PropertyValue>
                  {props.client.label || "Unnamed client"}
                </PropertyValue>
              </PropertyListItem>
              <PropertyListItem label="Client ID">
                <div class={clientIdValueClassName}>
                  <PropertyValue>{props.client.clientId}</PropertyValue>
                  {isCurrent() ? (
                    <em class={clientInfoCurrentClientBadgeClassName}>
                      This client
                    </em>
                  ) : null}
                </div>
              </PropertyListItem>
              <PropertyListItem label="Credential created">
                <PropertyValue>
                  {formatUnixTimestamp(props.client.createdAtUnix)}
                </PropertyValue>
                <span class={credentialCreatedAgeClassName}>
                  {formatCredentialCreatedAge(
                    props.client.createdAtUnix,
                    nowMs(),
                  )}
                </span>
              </PropertyListItem>
              <PropertyListItem label="Credential expires">
                <PropertyValue>
                  {formatUnixTimestamp(props.client.expiresAtUnix)}
                </PropertyValue>
                <span class={credentialExpiryRemainingClassName}>
                  {formatCredentialExpiryRemaining(
                    props.client.expiresAtUnix,
                    nowMs(),
                  )}
                </span>
                {isCurrent() ? (
                  <>
                    <Button
                      className={renewCredentialButtonClassName}
                      disabled={renewPhase() === "renewing"}
                      onClick={renewNow}
                    >
                      {renewPhase() === "renewing" ? "Renewing" : "Renew now"}
                    </Button>
                    {renewPhase() === "renewed" ? (
                      <span class={renewCredentialMessageClassName}>
                        Renewal requested
                      </span>
                    ) : null}
                    {renewPhase() === "error" ? (
                      <span class={renewCredentialErrorClassName}>
                        {renewError() ?? "Renewal failed"}
                      </span>
                    ) : null}
                  </>
                ) : null}
              </PropertyListItem>
            </PropertyList>
            <div class={clientDangerZoneClassName}>
              {removePhase() === "confirming" ||
              removePhase() === "removing" ? (
                <>
                  <span class={clientDangerMessageClassName}>
                    This client will need to pair again.
                  </span>
                  <Button
                    disabled={removePhase() === "removing"}
                    onClick={() => setRemovePhase("idle")}
                    size="sm"
                    variant="ghost"
                  >
                    Cancel
                  </Button>
                  <Button
                    disabled={removePhase() === "removing"}
                    onClick={removeNow}
                    size="sm"
                    tone="danger"
                    variant="solid"
                  >
                    <Trash2 size={14} />
                    {removePhase() === "removing"
                      ? "Removing"
                      : "Remove client"}
                  </Button>
                </>
              ) : (
                <>
                  {removePhase() === "error" ? (
                    <span class={clientDangerErrorClassName}>
                      {removeError() ?? "Client removal failed"}
                    </span>
                  ) : (
                    <span class={clientDangerMessageClassName} />
                  )}
                  <Button
                    onClick={() => setRemovePhase("confirming")}
                    size="sm"
                    tone="danger"
                    variant="outline"
                  >
                    <Trash2 size={14} />
                    Remove client
                  </Button>
                </>
              )}
            </div>
          </section>
        );
      })()}
    </>
  );
}
interface ClientTerminalSessionsProps {
  onCloseTerminalSession: (terminalSessionId: string) => Promise<void>;
  onOpenTerminalSession: (session: TerminalSessionInfo) => void;
  sessions: TerminalSessionInfo[];
  state: TerminalSessionsState;
}
function ClientTerminalSessions(props: ClientTerminalSessionsProps) {
  const [closingSessionIds, setClosingSessionIds] = createSignal<Set<string>>(
    new Set<string>(),
  );
  const [closeError, setCloseError] = createSignal<string>();
  async function closeSession(terminalSessionId: string) {
    setCloseError(undefined);
    setClosingSessionIds((current) => new Set(current).add(terminalSessionId));
    try {
      await props.onCloseTerminalSession(terminalSessionId);
    } catch (err) {
      setCloseError(errorMessage(err));
    } finally {
      setClosingSessionIds((current) => {
        const next = new Set(current);
        next.delete(terminalSessionId);
        return next;
      });
    }
  }
  return (
    <>
      {(() => {
        return (
          <section class={clientDetailSectionClassName}>
            <header class={clientDetailSectionHeaderClassName}>
              <h2>Terminal sessions</h2>
            </header>
            {closeError() ? (
              <ClientDetailState message={closeError()!} />
            ) : null}
            {props.state.phase === "error" ? (
              <ClientDetailState
                message={props.state.message ?? "Terminal session list failed"}
              />
            ) : props.state.phase === "loading" ? (
              <ClientDetailState message="Loading terminal sessions" />
            ) : props.sessions.length === 0 ? (
              <ClientDetailState message="No terminal sessions for this client" />
            ) : (
              <div class={terminalSessionListClassName}>
                {props.sessions.map((session) => (
                  <article>
                    <strong>{commandName(session.launch.command)}</strong>
                    <span>
                      {session.cols} x {session.rows}
                    </span>
                    <div class={terminalSessionActionsClassName}>
                      <Button
                        className={terminalSessionCloseButtonClassName}
                        onClick={() => props.onOpenTerminalSession(session)}
                      >
                        <SquareTerminal size={13} />
                        Open
                      </Button>
                      <Button
                        className={terminalSessionCloseButtonClassName}
                        disabled={closingSessionIds().has(
                          session.terminalSessionId,
                        )}
                        onClick={() => closeSession(session.terminalSessionId)}
                      >
                        {closingSessionIds().has(session.terminalSessionId)
                          ? "Closing"
                          : "Close"}
                      </Button>
                    </div>
                    <small>
                      {terminalSessionStatus(session)}
                      {" - "}
                      {session.lastKnownCwd ?? "cwd unknown"}
                    </small>
                  </article>
                ))}
              </div>
            )}
          </section>
        );
      })()}
    </>
  );
}
interface ClientDetailStateProps {
  message: string;
}
function ClientDetailState(props: ClientDetailStateProps) {
  return (
    <>
      {(() => {
        return <div class={clientDetailStateClassName}>{props.message}</div>;
      })()}
    </>
  );
}
function terminalSessionStatus(session: TerminalSessionInfo): string {
  if (session.exit?.code !== undefined) {
    return `Exited with code ${session.exit.code}`;
  }
  if (session.exit?.signal) return `Exited after ${session.exit.signal}`;
  if (session.exit) return "Exited";
  return "Running";
}
function terminalSessionTabTitle(session: TerminalSessionInfo): string {
  return session.lastKnownTitle ?? commandName(session.launch.command);
}
interface InlineStateProps {
  message: string;
}
function InlineState(props: InlineStateProps) {
  return (
    <>
      {(() => {
        return (
          <div class="min-w-0 rounded-[8px] border border-[#d8dde7] bg-[#fbfcfe] px-[1rem] py-[1rem] text-[14px] text-[#667085]">
            {props.message}
          </div>
        );
      })()}
    </>
  );
}
function formatDaemonTimestamp(timeMs?: number): string {
  if (timeMs === undefined || timeMs === 0) return "Unknown";
  return new Intl.DateTimeFormat(undefined, {
    dateStyle: "medium",
    timeStyle: "medium",
  }).format(new Date(timeMs));
}
function formatDaemonUptime(uptimeSeconds?: number): string {
  if (uptimeSeconds === undefined) return "Unknown";
  const days = Math.floor(uptimeSeconds / 86400);
  const hours = Math.floor((uptimeSeconds % 86400) / 3600);
  const minutes = Math.floor((uptimeSeconds % 3600) / 60);
  const seconds = uptimeSeconds % 60;
  if (days > 0) return `${days}d ${hours}h ${minutes}m ${seconds}s`;
  if (hours > 0) return `${hours}h ${minutes}m ${seconds}s`;
  if (minutes > 0) return `${minutes}m ${seconds}s`;
  return `${seconds}s`;
}
function formatUnixTimestamp(timeUnix?: number): string {
  if (timeUnix === undefined || timeUnix === 0) return "Unknown";
  return formatDaemonTimestamp(timeUnix * 1000);
}
function formatCredentialExpiryRemaining(
  expiresAtUnix: number | undefined,
  nowMs: number,
): string {
  if (expiresAtUnix === undefined || expiresAtUnix === 0) {
    return "Expiry unknown";
  }
  const remainingSeconds = Math.floor(expiresAtUnix - nowMs / 1000);
  if (remainingSeconds > 0) {
    return `${formatDurationSeconds(remainingSeconds)} remaining`;
  }
  if (remainingSeconds === 0) return "Expires now";
  return `Expired ${formatDurationSeconds(-remainingSeconds)} ago`;
}
function formatCredentialCreatedAge(
  createdAtUnix: number | undefined,
  nowMs: number,
): string {
  if (createdAtUnix === undefined || createdAtUnix === 0) {
    return "Creation time unknown";
  }
  const elapsedSeconds = Math.floor(nowMs / 1000 - createdAtUnix);
  if (elapsedSeconds > 0) {
    return `${formatDurationSeconds(elapsedSeconds)} ago`;
  }
  if (elapsedSeconds === 0) return "Now";
  return `In ${formatDurationSeconds(-elapsedSeconds)}`;
}
function formatDurationSeconds(totalSeconds: number): string {
  const seconds = Math.max(0, Math.floor(totalSeconds));
  const days = Math.floor(seconds / 86400);
  const hours = Math.floor((seconds % 86400) / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  const restSeconds = seconds % 60;
  if (days > 0) return `${days}d ${hours}h ${minutes}m ${restSeconds}s`;
  if (hours > 0) return `${hours}h ${minutes}m ${restSeconds}s`;
  if (minutes > 0) return `${minutes}m ${restSeconds}s`;
  return `${restSeconds}s`;
}
function commandName(command: string): string {
  const normalized = command.replaceAll("\\", "/");
  return normalized.split("/").filter(Boolean).pop() ?? command;
}
function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
function clientDetailPendingMessage(clientsState: ClientsState): string {
  if (clientsState.phase === "error") {
    return clientsState.message ?? "Client detail failed";
  }
  return "Loading client detail";
}
function clientsOverviewLabel(clientsState: ClientsState): string {
  if (clientsState.phase === "error") {
    return clientsState.message ?? "Client list failed";
  }
  if (clientsState.phase === "loading") return "Loading clients";
  const count = clientsState.clients.length;
  if (count === 0) return "No paired clients";
  if (count === 1) return "1 paired client";
  return `${count} paired clients`;
}
function otherClientsLabel(count: number): string {
  if (count === 0) return "No other clients...";
  if (count === 1) return "1 other client...";
  return `${count} other clients...`;
}
interface DaemonInfoStateViewProps {
  hasMachine: boolean;
  message?: string;
  phase: "idle" | "loading" | "error";
}
function DaemonInfoStateView(props: DaemonInfoStateViewProps) {
  const title = createMemo(() =>
    props.phase === "error"
      ? "Daemon info unavailable"
      : props.phase === "loading"
        ? "Loading daemon info"
        : props.hasMachine
          ? "Daemon info unavailable"
          : "No daemon selected",
  );
  return (
    <>
      {(() => {
        return (
          <div class={messageStateClassName}>
            <div>
              {props.phase === "error" ? (
                <AlertTriangle size={24} />
              ) : props.phase === "loading" ? (
                <Loader2 size={24} />
              ) : (
                <Info size={24} />
              )}
              <strong>{title()}</strong>
              {props.message ? <p>{props.message}</p> : null}
            </div>
          </div>
        );
      })()}
    </>
  );
}
