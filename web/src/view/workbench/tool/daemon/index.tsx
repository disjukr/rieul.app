import { style } from "../../../../zyzz.config.ts";
import { DaemonUpdateSection } from "./updates.tsx";
import type {
  ClientsTableEvent,
  TerminalSessionInfo,
  TerminalSessionsTableEvent,
} from "../../../../protocol/generated/rpc.ts";
import type { ConnectionState } from "../../../../state/types.ts";
import type { BreadcrumbItem } from "../../../ui/breadcrumb.tsx";
import { createSignal, createMemo, createEffect } from "solid-js";

import { useBunja } from "bunja/solid";
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
import { RpcSupportSection } from "./rpc-support.tsx";
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
  const daemonInfo = () => rpcSession().daemonInfo();
  const readyDaemonInfo = createMemo(() => {
    const value = daemonInfo();
    return value.phase === "ready" ? value.daemonInfo : undefined;
  });
  const daemonServerTimeMs = () => rpcSession().daemonServerTimeMs();
  const daemonUptimeSeconds = () => rpcSession().daemonUptimeSeconds();
  const connection = () => rpcSession().connection();
  const daemonInstanceId = () => rpcSession().daemonInstanceId();
  const machine = () => machines().selected();
  const isPaired = () => machines().selectedIsPaired();
  const tab = () => tabState().tab();
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
          <section {...styles.daemonTool()}>
            <div {...styles.daemonHeader()}>
              <DaemonBreadcrumb
                clientsPageOpen={clientsPageOpen()}
                clientDetailId={clientDetailId()}
                onOpenClients={openClientsPage}
                onOpenRoot={openRootPage}
              />
              {clientsPageOpen() ? null : (
                <span
                  class={`${styles.statusPill().class} ${connection().phase}`}
                >
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
            <div {...styles.daemonContent()}>
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
            className={styles.breadcrumb().class}
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
                <span {...styles.summaryNote()}>
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
                <span {...styles.summaryNote()}>
                  Uptime {formatDaemonUptime(props.uptimeSeconds)}
                </span>
              </PropertyListItem>
            </PropertyList>

            <DaemonUpdateSection />

            <ClientsOverviewSection
              clientsState={props.clientsState}
              currentClientId={props.currentClientId}
              onOpenClient={props.onOpenClient}
              onOpenClients={props.onOpenClients}
            />

            <RpcSupportSection supportedProcIds={props.supportedProcIds} />
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
          <section {...styles.procSection()}>
            <button
              type="button"
              {...styles.sectionTitleButton()}
              onClick={props.onOpenClients}
            >
              Clients
              <ChevronRight size={13} />
            </button>
            <div {...styles.clientOverviewCard()}>
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
              <span {...styles.clientOverviewMeta()}>
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
              {...styles.clientOverviewCurrentButton()}
              onClick={() => props.onOpenClient(currentClient()!.clientId)}
            >
              <div {...styles.clientNameRow()}>
                <strong>{currentClient()!.label || "Unnamed client"}</strong>
                <em {...styles.currentClientBadge()}>This client</em>
              </div>
              <span>{currentClient()!.clientId}</span>
            </button>
            <button
              type="button"
              {...styles.clientOverviewMetaButton()}
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
          <section {...styles.clientDetailPage()}>
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
          <section {...styles.clientDetailPage()}>
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
          <section {...styles.procSection()}>
            <div {...styles.procSectionTitle()}>Clients</div>
            {props.clientsState.phase === "error" ? (
              <InlineState
                message={props.clientsState.message ?? "Client list failed"}
              />
            ) : props.clientsState.phase === "loading" ? (
              <InlineState message="Loading clients" />
            ) : props.clientsState.clients.length === 0 ? (
              <InlineState message="No paired clients" />
            ) : (
              <div {...styles.clientList()}>
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
          <article {...styles.clientListItem()}>
            <button
              type="button"
              {...styles.clientButton()}
              onClick={() => props.onOpenClient(props.client.clientId)}
            >
              <div {...styles.clientNameRow()}>
                <strong>{props.client.label || "Unnamed client"}</strong>
                {isCurrent() ? (
                  <em {...styles.currentClientBadge()}>This client</em>
                ) : null}
              </div>
              <span>{props.client.clientId}</span>
            </button>
            <Button
              aria-label={`Remove ${props.client.label || props.client.clientId}`}
              className={styles.clientListRemoveButton().class}
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
              <div {...styles.clientListConfirmation()}>
                <span {...styles.clientListConfirmationMessage()}>
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
              <div {...styles.clientListConfirmation()}>
                <span {...styles.clientListError()}>
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
          <section {...styles.clientDetailPage()}>
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
  const nowMs = () => now().nowEverySecond();
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
          <section {...styles.clientDetailSection()}>
            <header {...styles.clientDetailSectionHeader()}>
              <h2>Client information</h2>
            </header>
            <PropertyList className={styles.propertyList().class}>
              <PropertyListItem label="Label">
                <PropertyValue>
                  {props.client.label || "Unnamed client"}
                </PropertyValue>
              </PropertyListItem>
              <PropertyListItem label="Client ID">
                <div {...styles.clientIdValue()}>
                  <PropertyValue>{props.client.clientId}</PropertyValue>
                  {isCurrent() ? (
                    <em {...styles.clientInfoCurrentClientBadge()}>
                      This client
                    </em>
                  ) : null}
                </div>
              </PropertyListItem>
              <PropertyListItem label="Credential created">
                <PropertyValue>
                  {formatUnixTimestamp(props.client.createdAtUnix)}
                </PropertyValue>
                <span {...styles.credentialExpiryRemaining()}>
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
                <span {...styles.credentialExpiryRemaining()}>
                  {formatCredentialExpiryRemaining(
                    props.client.expiresAtUnix,
                    nowMs(),
                  )}
                </span>
                {isCurrent() ? (
                  <>
                    <Button
                      className={styles.renewCredentialButton().class}
                      disabled={renewPhase() === "renewing"}
                      onClick={renewNow}
                    >
                      {renewPhase() === "renewing" ? "Renewing" : "Renew now"}
                    </Button>
                    {renewPhase() === "renewed" ? (
                      <span {...styles.credentialExpiryRemaining()}>
                        Renewal requested
                      </span>
                    ) : null}
                    {renewPhase() === "error" ? (
                      <span {...styles.renewCredentialError()}>
                        {renewError() ?? "Renewal failed"}
                      </span>
                    ) : null}
                  </>
                ) : null}
              </PropertyListItem>
            </PropertyList>
            <div {...styles.clientDangerZone()}>
              {removePhase() === "confirming" ||
              removePhase() === "removing" ? (
                <>
                  <span {...styles.clientListConfirmationMessage()}>
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
                    <span {...styles.clientListError()}>
                      {removeError() ?? "Client removal failed"}
                    </span>
                  ) : (
                    <span {...styles.clientListConfirmationMessage()} />
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
          <section {...styles.clientDetailSection()}>
            <header {...styles.clientDetailSectionHeader()}>
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
              <div {...styles.terminalSessionList()}>
                {props.sessions.map((session) => (
                  <article>
                    <strong>{commandName(session.launch.command)}</strong>
                    <span>
                      {session.cols} x {session.rows}
                    </span>
                    <div {...styles.terminalSessionActions()}>
                      <Button
                        className={styles.terminalSessionCloseButton().class}
                        onClick={() => props.onOpenTerminalSession(session)}
                      >
                        <SquareTerminal size={13} />
                        Open
                      </Button>
                      <Button
                        className={styles.terminalSessionCloseButton().class}
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
        return <div {...styles.clientDetailState()}>{props.message}</div>;
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
        return <div {...styles.div()}>{props.message}</div>;
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
          <div {...styles.messageState()}>
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

namespace styles {
  export const daemonTool = style({
    gridTemplateRows: "auto minmax(0,1fr)",
    display: "grid",
    height: "100%",
    minHeight: "0",
    width: "100%",
    overflow: "hidden",
    backgroundColor: "rgb(255 255 255 / 1)",
    color: "rgb(32 36 45 / 1)",
  });
  export const daemonContent = style({
    minHeight: "0",
    overflow: "auto",
    padding: "1rem",
  });
  export const statusPill = style({
    minWidth: "0",
    display: "inline-flex",
    selectors: {
      "& svg": {
        flex: "0 0 auto",
      },
      "&.offline": {
        backgroundColor: "rgb(255 241 243 / 1)",
        color: "rgb(180 35 24 / 1)",
      },
      "&.reachable": {
        backgroundColor: "rgb(236 253 243 / 1)",
        color: "rgb(2 122 72 / 1)",
      },
    },
    flex: "0 0 auto",
    alignItems: "center",
    gap: "0.5rem",
    borderRadius: "999px",
    backgroundColor: "rgb(238 243 251 / 1)",
    paddingLeft: "9px",
    paddingRight: "9px",
    paddingTop: "4px",
    paddingBottom: "4px",
    fontSize: "1rem",
    color: "rgb(52 64 84 / 1)",
    fontWeight: 700,
  });
  export const daemonHeader = style({
    height: "2rem",
    minHeight: "2rem",
    minWidth: "0",
    display: "flex",
    alignItems: "center",
    justifyContent: "space-between",
    gap: "1rem",
    overflow: "hidden",
    borderBottomWidth: "1px",
    borderBottomColor: "rgb(216 221 231 / 1)",
    backgroundColor: "rgb(251 252 254 / 1)",
    paddingLeft: "0.5rem",
    paddingRight: "0.5rem",
  });
  export const summaryNote = style({
    color: "rgb(102 112 133 / 1)",
  });
  export const procSection = style({
    marginTop: "18px",
    minWidth: "0",
  });
  export const procSectionTitle = style({
    marginBottom: "8px",
    fontSize: "1rem",
    color: "rgb(102 112 133 / 1)",
    fontWeight: 800,
  });
  export const sectionTitleButton = style({
    fontFamily: "inherit",
    marginBottom: "8px",
    height: "24px",
    display: "inline-flex",
    selectors: {
      "& svg": {
        flex: "0 0 auto",
      },
      "&:hover": {
        backgroundColor: "rgb(238 243 251 / 1)",
        color: "rgb(52 64 84 / 1)",
      },
    },
    cursor: "pointer",
    WebkitAppearance: "none",
    appearance: "none",
    alignItems: "center",
    gap: "3px",
    borderColor: "transparent",
    borderRadius: "0.5rem",
    backgroundColor: "transparent",
    paddingLeft: "4px",
    paddingRight: "4px",
    fontSize: "1rem",
    color: "rgb(102 112 133 / 1)",
    fontWeight: 800,
  });

  export const clientOverviewCard = style({
    display: "grid",
    minWidth: "0",
    gap: "8px",
    borderWidth: "1px",
    borderColor: "rgb(216 221 231 / 1)",
    borderRadius: "8px",
    backgroundColor: "rgb(251 252 254 / 1)",
    paddingLeft: "1rem",
    paddingRight: "1rem",
    paddingTop: "1rem",
    paddingBottom: "1rem",
    fontSize: "14px",
    color: "rgb(102 112 133 / 1)",
  });
  export const clientOverviewCurrentButton = style({
    fontFamily: "inherit",
    display: "grid",
    selectors: {
      "& span": {
        minWidth: "0",
        overflow: "hidden",
        textOverflow: "ellipsis",
        whiteSpace: "nowrap",
        fontSize: "12px",
        color: "rgb(102 112 133 / 1)",
      },
      "& strong": {
        minWidth: "0",
        overflow: "hidden",
        textOverflow: "ellipsis",
        whiteSpace: "nowrap",
        fontSize: "14px",
        fontWeight: 750,
      },
      "&:hover": {
        backgroundColor: "rgb(238 243 251 / 1)",
      },
    },
    minWidth: "0",
    cursor: "pointer",
    WebkitAppearance: "none",
    appearance: "none",
    gap: "3px",
    borderRadius: "0.5rem",
    paddingLeft: "8px",
    paddingRight: "8px",
    paddingTop: "7px",
    paddingBottom: "7px",
    textAlign: "left",
    color: "rgb(52 64 84 / 1)",
  });
  export const clientOverviewMeta = style({
    paddingLeft: "8px",
    paddingRight: "8px",
    fontSize: "1rem",
    color: "rgb(102 112 133 / 1)",
    fontWeight: 650,
  });
  export const clientOverviewMetaButton = style({
    fontFamily: "inherit",
    display: "inline",
    minHeight: "0",
    cursor: "pointer",
    WebkitAppearance: "none",
    appearance: "none",
    justifySelf: "start",
    gap: "0",
    borderWidth: "0px",
    selectors: {
      "&:hover": {
        borderColor: "transparent",
        backgroundColor: "transparent",
        color: "rgb(52 64 84 / 1)",
      },
    },
    borderRadius: "0",
    backgroundColor: "transparent",
    padding: "0",
    textAlign: "left",
    fontSize: "1rem",
    color: "rgb(102 112 133 / 1)",
    fontWeight: 650,
  });
  export const clientList = style({
    display: "grid",
    minWidth: "0",
    alignContent: "flex-start",
    gap: "0.5rem",
    borderWidth: "1px",
    borderColor: "rgb(216 221 231 / 1)",
    borderRadius: "8px",
    backgroundColor: "rgb(251 252 254 / 1)",
    padding: "0.5rem",
  });
  export const clientListItem = style({
    display: "grid",
    gridTemplateColumns: "minmax(0,1fr) auto",
    minWidth: "0",
    alignItems: "center",
    borderWidth: "1px",
    borderColor: "transparent",
    borderRadius: "0.5rem",
    backgroundColor: "rgb(255 255 255 / 1)",
  });
  export const clientButton = style({
    fontFamily: "inherit",
    display: "grid",
    selectors: {
      "& span": {
        minWidth: "0",
        overflow: "hidden",
        textOverflow: "ellipsis",
        whiteSpace: "nowrap",
        fontSize: "12px",
        color: "rgb(102 112 133 / 1)",
      },
      "& strong": {
        minWidth: "0",
        overflow: "hidden",
        textOverflow: "ellipsis",
        whiteSpace: "nowrap",
        fontSize: "14px",
        fontWeight: 750,
      },
      "&.selected": {
        backgroundColor: "rgb(232 238 247 / 1)",
        color: "rgb(32 36 45 / 1)",
      },
      "&:hover": {
        backgroundColor: "rgb(238 243 251 / 1)",
      },
    },
    minWidth: "0",
    cursor: "pointer",
    WebkitAppearance: "none",
    appearance: "none",
    gap: "3px",
    borderTopLeftRadius: "0.5rem",
    borderBottomLeftRadius: "0.5rem",
    paddingLeft: "1rem",
    paddingRight: "1rem",
    paddingTop: "8px",
    paddingBottom: "8px",
    textAlign: "left",
    color: "rgb(52 64 84 / 1)",
  });
  export const clientListRemoveButton = style({
    marginRight: "0.5rem",
  });
  export const clientListConfirmation = style({
    gridColumn: "span 2/span 2",
    minWidth: "0",
    display: "flex",
    flexWrap: "wrap",
    alignItems: "center",
    gap: "0.5rem",
    borderTopWidth: "1px",
    borderTopColor: "rgb(237 240 245 / 1)",
    paddingLeft: "1rem",
    paddingRight: "1rem",
    paddingTop: "0.5rem",
    paddingBottom: "0.5rem",
  });
  export const clientListConfirmationMessage = style({
    marginRight: "auto",
    fontSize: "1rem",
    color: "rgb(102 112 133 / 1)",
  });
  export const clientListError = style({
    marginRight: "auto",
    fontSize: "1rem",
    color: "rgb(180 35 24 / 1)",
  });
  export const clientNameRow = style({
    minWidth: "0",
    display: "flex",
    alignItems: "center",
    gap: "0.5rem",
  });
  export const currentClientBadge = style({
    flex: "0 0 auto",
    borderRadius: "999px",
    backgroundColor: "rgb(223 246 231 / 1)",
    paddingLeft: "0.5rem",
    paddingRight: "0.5rem",
    paddingTop: "1px",
    paddingBottom: "1px",
    fontSize: "1rem",
    color: "rgb(2 122 72 / 1)",
    fontWeight: 800,
    fontStyle: "normal",
  });
  export const clientInfoCurrentClientBadge = style({
    flex: "0 0 auto",
    borderRadius: "999px",
    backgroundColor: "rgb(223 246 231 / 1)",
    paddingLeft: "0.5rem",
    paddingRight: "0.5rem",
    paddingTop: "1px",
    paddingBottom: "1px",
    fontSize: "1rem",
    color: "rgb(2 122 72 / 1)",
    fontStyle: "normal",
  });
  export const clientDetailPage = style({
    display: "grid",
    minWidth: "0",
    gap: "14px",
  });
  export const clientDetailSection = style({
    minWidth: "0",
    overflow: "hidden",
    borderWidth: "1px",
    borderColor: "rgb(216 221 231 / 1)",
    borderRadius: "8px",
    backgroundColor: "rgb(255 255 255 / 1)",
  });
  export const clientDetailSectionHeader = style({
    selectors: {
      "& h2": {
        margin: "0",
        minWidth: "0",
        overflow: "hidden",
        textOverflow: "ellipsis",
        whiteSpace: "nowrap",
        fontSize: "1rem",
        color: "rgb(102 112 133 / 1)",
        fontWeight: 800,
      },
      "& span": {
        flex: "0 0 auto",
        fontSize: "1rem",
        color: "rgb(102 112 133 / 1)",
        fontWeight: 650,
      },
    },
    minWidth: "0",
    minHeight: "48px",
    display: "flex",
    alignItems: "center",
    justifyContent: "space-between",
    gap: "1rem",
    borderBottomWidth: "1px",
    borderBottomColor: "rgb(216 221 231 / 1)",
    backgroundColor: "rgb(251 252 254 / 1)",
    paddingLeft: "1rem",
    paddingRight: "1rem",
    paddingTop: "9px",
    paddingBottom: "9px",
  });
  export const clientIdValue = style({
    minWidth: "0",
    display: "flex",
    flexWrap: "wrap",
    alignItems: "center",
    gap: "7px",
  });
  export const credentialExpiryRemaining = style({
    fontSize: "1rem",
    color: "rgb(102 112 133 / 1)",
  });
  export const renewCredentialButton = style({
    minHeight: "28px !important",
    paddingLeft: "9px !important",
    paddingRight: "9px !important",
    fontSize: "1rem !important",
  });

  export const renewCredentialError = style({
    fontSize: "1rem",
    color: "rgb(180 35 24 / 1)",
  });
  export const clientDangerZone = style({
    minWidth: "0",
    display: "flex",
    flexWrap: "wrap",
    alignItems: "center",
    gap: "0.5rem",
    borderTopWidth: "1px",
    borderTopColor: "rgb(237 240 245 / 1)",
    paddingLeft: "1rem",
    paddingRight: "1rem",
    paddingTop: "0.75rem",
    paddingBottom: "0.75rem",
  });

  export const terminalSessionList = style({
    selectors: {
      "& small": {
        overflowWrap: "anywhere",
        gridColumn: "span 3/span 3",
        minWidth: "0",
        fontSize: "1rem",
        color: "rgb(102 112 133 / 1)",
      },
      "& article": {
        display: "grid",
        gridTemplateColumns: "minmax(0,1fr) auto auto",
        minWidth: "0",
        alignItems: "center",
        columnGap: "1rem",
        rowGap: "4px",
        borderBottomWidth: "1px",
        borderBottomColor: "rgb(237 240 245 / 1)",
        paddingLeft: "1rem",
        paddingRight: "1rem",
        paddingTop: "1rem",
        paddingBottom: "1rem",
      },
      "& strong": {
        minWidth: "0",
        overflow: "hidden",
        textOverflow: "ellipsis",
        whiteSpace: "nowrap",
        fontWeight: 750,
      },
      "& article:last-child": {
        borderBottomWidth: "0px",
      },
      "& span": {
        color: "rgb(102 112 133 / 1)",
      },
    },
    display: "grid",
    minWidth: "0",
  });
  export const terminalSessionActions = style({
    minWidth: "0",
    display: "flex",
    alignItems: "center",
    justifyContent: "flex-end",
    gap: "0.5rem",
  });
  export const terminalSessionCloseButton = style({
    minHeight: "24px !important",
    paddingLeft: "1rem !important",
    paddingRight: "1rem !important",
    fontSize: "1rem !important",
  });
  export const clientDetailState = style({
    padding: "1rem",
    color: "rgb(102 112 133 / 1)",
  });
  export const messageState = style({
    selectors: {
      "& div": {
        display: "grid",
        justifyItems: "center",
        gap: "8px",
      },
      "& p": {
        margin: "0",
        maxWidth: "420px",
        fontSize: "14px",
        color: "rgb(102 112 133 / 1)",
      },
      "& strong": {
        fontSize: "15px",
        color: "rgb(32 36 45 / 1)",
      },
      "& svg": {
        color: "rgb(152 162 179 / 1)",
      },
    },
    display: "grid",
    height: "100%",
    minHeight: "220px",
    placeItems: "center",
    textAlign: "center",
  });
  export const breadcrumb = style({
    flex: "1 1 auto",
  });
  export const propertyList = style({
    borderWidth: "0px !important",
    borderRadius: "0 !important",
    backgroundColor: "rgb(237 240 245 / 1)",
  });
  export const div = style({
    minWidth: "0",
    borderWidth: "1px",
    borderColor: "rgb(216 221 231 / 1)",
    borderRadius: "8px",
    backgroundColor: "rgb(251 252 254 / 1)",
    paddingLeft: "1rem",
    paddingRight: "1rem",
    paddingTop: "1rem",
    paddingBottom: "1rem",
    fontSize: "14px",
    color: "rgb(102 112 133 / 1)",
  });
}
