import { bunja, override } from "bunja";
import { atom } from "jotai/vanilla";
import { createSignal, Show } from "solid-js";
import { render } from "@solidjs/web";
import { BunjaProvider } from "../../src/solid/bunja";
import { JotaiProvider } from "../../src/solid/jotai";
import { JotaiStoreScope } from "../../src/state/jotai-store.ts";
import { agentsBunja, type AgentCatalogPhase } from "../../src/state/agents.ts";
import { rpcSessionBunja } from "../../src/state/rpc-session.ts";
import {
  workbenchTabBunja,
  type WorkbenchTab,
} from "../../src/state/workbench.ts";
import { AgentTool } from "../../src/view/workbench/tool/agent/index.tsx";
import { rpcSessionStub } from "../helpers/rpc-session.ts";
import {
  type AgentProjectInfo,
  type AgentProviderInfo,
  type AgentSessionSummary,
  ProcId,
  AgentAttachmentState,
  AgentSessionTurnState,
  AgentSessionRecoverability,
  encodeAgentSessionEventValue,
  encodeListAgentSessionTurnsResValue,
} from "../../src/protocol/generated/rpc.ts";
import { encodeCbor } from "../../src/protocol/cbor.ts";
import {
  decodeReqResMessageSequence,
  encodeReqResMessageSequence,
  ReqResMessageKind,
} from "../../src/protocol/wire.ts";

const metrics = { transports: 0, subscriptions: 0, tabWrites: 0 };
const pending: Array<(transport: WebTransport) => void> = [];
Object.assign(window, { agentFixture: metrics });
function unused(): never {
  throw new Error("Unexpected fixture action");
}
let selectB = () => {};
const transport = {
  async createBidirectionalStream() {
    let response!: ReadableStreamDefaultController<Uint8Array>;
    return {
      readable: new ReadableStream<Uint8Array>({
        start(controller) {
          response = controller;
        },
      }),
      writable: new WritableStream<Uint8Array>({
        write(bytes) {
          const req = decodeReqResMessageSequence(bytes)[0];
          if (req.kind !== ReqResMessageKind.RequestUnary)
            throw new Error("unexpected request");
          if (req.procId === ProcId.SubscribeAgentSession) {
            metrics.subscriptions++;
            response.enqueue(
              encodeReqResMessageSequence([
                {
                  kind: ReqResMessageKind.ResponseStreamChunk,
                  payload: encodeCbor(
                    encodeAgentSessionEventValue({
                      type: "snapshot",
                      snapshot: {
                        latestSeq: 0,
                        configOptions: [],
                        session: {
                          summary: {
                            sessionId: "fixture",
                            providerId: "fixture",
                            cwd: "/tmp",
                            workspace: {
                              type: "project",
                              projectId: "fixture",
                            },
                            attachment: AgentAttachmentState.Attached,
                            turnState: AgentSessionTurnState.Idle,
                            recoverability:
                              AgentSessionRecoverability.Resumable,
                            archived: false,
                            createdAtMs: 0,
                            updatedAtMs: 0,
                          },
                        },
                      },
                    }),
                  ),
                },
              ]),
            );
          } else if (req.procId === ProcId.ListAgentSessionTurns) {
            response.enqueue(
              encodeReqResMessageSequence([
                {
                  kind: ReqResMessageKind.ResponseUnaryOk,
                  payload: encodeCbor(
                    encodeListAgentSessionTurnsResValue({ turns: [] }),
                  ),
                },
              ]),
            );
            response.close();
          } else throw new Error("unexpected procedure");
        },
      }),
    };
  },
} as WebTransport;
const overrides = [
  override(rpcSessionBunja, () =>
    rpcSessionStub({
      daemonInstanceIdAtom: atom<string | undefined>("daemon"),
      webTransport: () => {
        metrics.transports++;
        return new Promise((resolve) => pending.push(resolve));
      },
    }),
  ),
  override(agentsBunja, () => ({
    addProject: unused,
    addSession: unused,
    archiveSession: unused,
    availableProvidersAtom: atom<AgentProviderInfo[]>([]),
    errorAtom: atom<string | undefined>(),
    phaseAtom: atom<AgentCatalogPhase>("ready"),
    projectsAtom: atom<AgentProjectInfo[]>([]),
    providersAtom: atom<AgentProviderInfo[]>([]),
    sessionsAtom: atom<AgentSessionSummary[]>([]),
    refreshSessions: async () => {},
  })),
  override(workbenchTabBunja, () => {
    const store = bunja.use(JotaiStoreScope);
    const tabAtom = atom<WorkbenchTab | undefined>({
      id: "tab",
      tool: "agent",
      title: "Agent",
      agentSessionId: "A",
    });
    selectB = () =>
      store.set(tabAtom, (current) =>
        current ? { ...current, agentSessionId: "B" } : current,
      );
    return {
      paneId: "pane",
      tabId: "tab",
      tabAtom,
      activeAtom: atom(true),
      dirtyAtom: atom(false),
      focusedAtom: atom(true),
      showCloseAtom: atom(false),
      selectTab: unused,
      setAgentSession() {
        metrics.tabWrites++;
      },
      setDaemonClientDetailId: unused,
      setDaemonClientsPageOpen: unused,
      setProcessDetailPid: unused,
      setProcessPage: unused,
      setWindowDetailId: unused,
      setDirty: unused,
      setTerminalSessionSnapshot: unused,
      setTerminalSessionId: unused,
    };
  }),
];
function Fixture() {
  const [shown, setShown] = createSignal(true);
  return (
    <>
      <button onClick={() => setShown(false)}>Remove agent</button>
      <button onClick={() => selectB()}>Select session B</button>
      <button onClick={() => pending.shift()?.(transport)}>
        Resolve oldest transport
      </button>
      <Show when={shown()}>
        <AgentTool />
      </Show>
    </>
  );
}
render(
  () => (
    <JotaiProvider>
      <BunjaProvider overrides={overrides}>
        <Fixture />
      </BunjaProvider>
    </JotaiProvider>
  ),
  document.getElementById("root")!,
);
