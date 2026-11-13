import { TestBunjaStoreProvider } from "./bunja-store.tsx";
import { override } from "bunja";
import { createSignal, Show } from "solid-js";
import { render } from "@solidjs/web";
import { useBunja } from "bunja/solid";
import { MachineStorageContext } from "../../src/solid/scopes.ts";
import {
  MachineIdContext,
  MachineBaseUrlContext,
} from "../../src/state/machine.tsx";
import { machineStoreBunja } from "../../src/state/machine-store.ts";
import { rpcSessionBunja } from "../../src/state/rpc-session.ts";
import {
  workbenchTabBunja,
  type WorkbenchTab,
} from "../../src/state/workbench.ts";
import { TerminalTool } from "../../src/view/workbench/tool/terminal/index.tsx";
import {
  decodeAttachTerminalSessionReqValue,
  encodeTerminalSessionInfoValue,
  encodeTerminalEventValue,
  ProcId,
} from "../../src/protocol/generated/rpc.ts";
import { decodeCbor, encodeCbor } from "../../src/protocol/cbor.ts";
import {
  decodeReqResMessageSequence,
  encodeReqResMessageSequence,
  ReqResMessageKind,
} from "../../src/protocol/wire.ts";
import { rpcSessionStub } from "../helpers/rpc-session.ts";

const storage = new Map<string, string>();
const memoryStorage = {
  getItem: (key: string) => storage.get(key) ?? null,
  setItem: (key: string, value: string) => {
    storage.set(key, value);
  },
  removeItem: (key: string) => {
    storage.delete(key);
  },
};
function unused(): never {
  throw new Error("Unexpected terminal action");
}
const lateCreate = new URLSearchParams(location.search).has("late-create");
const resume = new URLSearchParams(location.search).has("resume");
const resumeCursors: Array<number | undefined> = [];
Object.assign(window, { terminalResumeCursors: resumeCursors });
let sendResumeEvent = (
  _event: Parameters<typeof encodeTerminalEventValue>[0],
) => {};
let disconnectTerminal = () => {};
const rpcMetrics = { creates: 0, closes: 0, tabWrites: 0, attaches: 0 };
let updateTitle = () => {};
const session = {
  terminalSessionId: "late-session",
  creatorClientId: "fixture",
  createdAtMs: 0,
  cols: 80,
  rows: 24,
  latestOutputSeq: 0,
  launch: { command: "/bin/sh", args: [] },
};
let completeCreate = () => {};
Object.assign(window, { terminalRpcFixture: rpcMetrics });
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
          const request = decodeReqResMessageSequence(bytes)[0];
          if (request.kind !== ReqResMessageKind.RequestUnary)
            throw new Error("Unexpected request kind");
          if (request.procId === ProcId.CreateTerminalSession) {
            rpcMetrics.creates++;
            completeCreate = () => {
              response.enqueue(
                encodeReqResMessageSequence([
                  {
                    kind: ReqResMessageKind.ResponseUnaryOk,
                    payload: encodeCbor(
                      encodeTerminalSessionInfoValue({
                        terminalSessionId: "late-session",
                        creatorClientId: "fixture",
                        createdAtMs: 0,
                        cols: 80,
                        rows: 24,
                        latestOutputSeq: 0,
                        launch: { command: "/bin/sh", args: [] },
                      }),
                    ),
                  },
                ]),
              );
              response.close();
            };
          } else if (request.procId === ProcId.AttachTerminalSession) {
            rpcMetrics.attaches++;
            if (resume && request.payload) {
              const attach = decodeAttachTerminalSessionReqValue(
                decodeCbor(request.payload),
              );
              resumeCursors.push(attach.afterSeq);
              if (!attach.screenSnapshots)
                throw new Error("Snapshots not requested");
            }
            sendResumeEvent = (event) =>
              response.enqueue(
                encodeReqResMessageSequence([
                  {
                    kind: ReqResMessageKind.ResponseStreamChunk,
                    payload: encodeCbor(encodeTerminalEventValue(event)),
                  },
                ]),
              );
            disconnectTerminal = () => response.close();
            response.enqueue(
              encodeReqResMessageSequence([
                {
                  kind: ReqResMessageKind.ResponseStreamChunk,
                  payload: encodeCbor(
                    encodeTerminalEventValue({
                      type: "attached",
                      attachId: "attach",
                      session,
                    }),
                  ),
                },
              ]),
            );
            updateTitle = () =>
              response.enqueue(
                encodeReqResMessageSequence([
                  {
                    kind: ReqResMessageKind.ResponseStreamChunk,
                    payload: encodeCbor(
                      encodeTerminalEventValue({
                        type: "titleChanged",
                        title: "Changed title",
                      }),
                    ),
                  },
                ]),
              );
          } else if (request.procId === ProcId.CloseTerminalSession) {
            rpcMetrics.closes++;
            response.enqueue(
              encodeReqResMessageSequence([
                { kind: ReqResMessageKind.ResponseUnaryOk },
              ]),
            );
            response.close();
          } else throw new Error(`Unexpected procedure ${request.procId}`);
        },
      }),
    };
  },
} as WebTransport;
const overrides = [
  override(rpcSessionBunja, () =>
    rpcSessionStub(
      lateCreate || resume
        ? {
            daemonInstanceId: createSignal<string | undefined>("daemon")[0],
            webTransport: async () => transport,
          }
        : {},
    ),
  ),
  override(workbenchTabBunja, () => {
    const [tab, setTab] = createSignal<WorkbenchTab | undefined>({
      id: "tab",
      tool: "terminal",
      title: "Terminal",
      terminalLaunch: { command: "/bin/sh", args: [] },
      ...(resume ? { terminalSessionId: session.terminalSessionId } : {}),
    });
    return {
      paneId: "pane",
      tabId: "tab",
      tab,
      active: createSignal(true)[0],
      dirty: createSignal(false)[0],
      focused: createSignal(false)[0],
      showClose: createSignal(false)[0],
      selectTab: unused,
      setDaemonClientDetailId: unused,
      setDaemonClientsPageOpen: unused,
      setProcessDetailPid: unused,
      setProcessPage: unused,
      setWindowDetailId: unused,
      setDirty: unused,
      setTerminalSessionSnapshot(snapshot) {
        setTab((current) =>
          current
            ? { ...current, terminalLastKnownTitle: snapshot.lastKnownTitle }
            : current,
        );
      },
      setTerminalSessionId(id) {
        rpcMetrics.tabWrites++;
        setTab((current) =>
          current ? { ...current, terminalSessionId: id } : current,
        );
      },
    };
  }),
];
function Fixture() {
  const machines = useBunja(machineStoreBunja);
  const selected = () => machines().selected();
  const [shown, setShown] = createSignal(true);
  function selectMachine() {
    if (!machines().findMachine("fixture"))
      machines().addMachine({
        id: "fixture",
        name: "Fixture",
        baseUrl: "https://fixture.invalid:9012",
        clientId: "fixture",
        clientSecret: "fixture",
      });
    else machines().selectMachine("fixture");
  }
  return (
    <>
      <button onClick={selectMachine}>Select paired machine</button>
      <button onClick={() => machines().selectMachine(undefined)}>
        Clear selection
      </button>
      <button onClick={() => setShown(false)}>Remove terminal</button>
      {resume && (
        <>
          <button
            onClick={() =>
              sendResumeEvent({
                type: "screenSnapshot",
                baseSeq: 5,
                cols: 80,
                rows: 24,
                bytes: Uint8Array.of(83),
              })
            }
          >
            Send snapshot
          </button>
          <button
            onClick={() =>
              sendResumeEvent({
                type: "outputChunk",
                seq: 6,
                bytes: Uint8Array.of(82),
              })
            }
          >
            Send output
          </button>
          <button onClick={() => disconnectTerminal()}>
            Disconnect terminal
          </button>
          <button
            onClick={() =>
              sendResumeEvent({
                type: "historyGap",
                nextSeq: 10,
                reconnect: true,
              })
            }
          >
            Lag terminal
          </button>
        </>
      )}
      <button onClick={() => updateTitle()}>Publish terminal title</button>
      <button onClick={() => completeCreate()}>Resolve pending creation</button>
      <button onClick={() => setShown(true)}>Remount terminal</button>
      <div style={{ width: "640px", height: "480px" }}>
        <MachineIdContext value={() => selected()?.id}>
          <MachineBaseUrlContext value={() => selected()?.baseUrl}>
            <Show when={shown()}>
              <TerminalTool />
            </Show>
          </MachineBaseUrlContext>
        </MachineIdContext>
      </div>
    </>
  );
}
render(
  () => (
    <TestBunjaStoreProvider overrides={overrides}>
      <MachineStorageContext value={() => memoryStorage}>
        <Fixture />
      </MachineStorageContext>
    </TestBunjaStoreProvider>
  ),
  document.getElementById("root")!,
);
