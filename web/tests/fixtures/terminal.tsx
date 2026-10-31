import { bunja, override } from "bunja";
import { atom } from "jotai/vanilla";
import { createSignal, Show } from "solid-js";
import { render } from "@solidjs/web";
import { BunjaProvider, useBunja } from "../../src/solid/bunja.tsx";
import { JotaiProvider, useAtomValue } from "../../src/solid/jotai.tsx";
import { MachineStorageContext } from "../../src/solid/scopes.ts";
import {
  MachineIdContext,
  MachineBaseUrlContext,
} from "../../src/state/machine.tsx";
import { machineStoreBunja } from "../../src/state/machine-store.ts";
import { rpcSessionBunja } from "../../src/state/rpc-session.ts";
import { JotaiStoreScope } from "../../src/state/jotai-store.ts";
import {
  workbenchTabBunja,
  type WorkbenchTab,
} from "../../src/state/workbench.ts";
import { TerminalTool } from "../../src/view/workbench/tool/terminal/index.tsx";
import {
  encodeTerminalSessionInfoValue,
  encodeTerminalEventValue,
  ProcId,
} from "../../src/protocol/generated/rpc.ts";
import { encodeCbor } from "../../src/protocol/cbor.ts";
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
      lateCreate
        ? {
            daemonInstanceIdAtom: atom<string | undefined>("daemon"),
            webTransport: async () => transport,
          }
        : {},
    ),
  ),
  override(workbenchTabBunja, () => {
    const store = bunja.use(JotaiStoreScope);
    const tabAtom = atom<WorkbenchTab | undefined>({
      id: "tab",
      tool: "terminal",
      title: "Terminal",
      terminalLaunch: { command: "/bin/sh", args: [] },
    });
    return {
      paneId: "pane",
      tabId: "tab",
      tabAtom,
      activeAtom: atom(true),
      dirtyAtom: atom(false),
      focusedAtom: atom(false),
      showCloseAtom: atom(false),
      selectTab: unused,
      setAgentSession: unused,
      setDaemonClientDetailId: unused,
      setDaemonClientsPageOpen: unused,
      setProcessDetailPid: unused,
      setProcessPage: unused,
      setWindowDetailId: unused,
      setDirty: unused,
      setTerminalSessionSnapshot(snapshot) {
        store.set(tabAtom, (current) =>
          current
            ? { ...current, terminalLastKnownTitle: snapshot.lastKnownTitle }
            : current,
        );
      },
      setTerminalSessionId(id) {
        rpcMetrics.tabWrites++;
        store.set(tabAtom, (current) =>
          current ? { ...current, terminalSessionId: id } : current,
        );
      },
    };
  }),
];
function Fixture() {
  const machines = useBunja(machineStoreBunja);
  const selected = useAtomValue(() => machines().selectedAtom);
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
    <JotaiProvider>
      <BunjaProvider overrides={overrides}>
        <MachineStorageContext value={() => memoryStorage}>
          <Fixture />
        </MachineStorageContext>
      </BunjaProvider>
    </JotaiProvider>
  ),
  document.getElementById("root")!,
);
