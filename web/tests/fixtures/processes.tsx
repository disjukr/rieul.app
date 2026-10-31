import { bunja, createBunjaStore, override } from "bunja";
import {
  BunjaStoreContext,
  createScopeFromContext,
  useBunja,
} from "bunja/react";
import { createContext, useState } from "react";
import { createRoot } from "react-dom/client";
import { atom, useAtomValue } from "jotai";
import { JotaiProvider } from "unsaturated/store";
import { processesBunja } from "../../src/state/processes.ts";
import { rpcSessionBunja } from "../../src/state/rpc-session.ts";
import { encodeProcessesTableEventValue } from "../../src/protocol/generated/rpc.ts";
import { encodeCbor } from "../../src/protocol/cbor.ts";
import {
  encodeReqResMessageSequence,
  ReqResMessageKind,
} from "../../src/protocol/wire.ts";
import type { DaemonInfoState } from "../../src/state/rpc-session.ts";
import { ProcId } from "../../src/protocol/generated/rpc.ts";
const MachineContext = createContext("a");
const MachineScope = createScopeFromContext(MachineContext);
const diagnostics = { starts: 0, stops: 0 };
Object.assign(window, { processesFixture: diagnostics });
function unused(): never {
  throw new Error("Unexpected RPC method");
}
const store = createBunjaStore({
  overrides: [
    override(rpcSessionBunja, () => {
      const id = bunja.use(MachineScope);
      return {
        closeRpcSession: unused,
        reconnect: unused,
        resetController: unused,
        startPairingSession: async () => unused(),
        completePairingSession: async () => unused(),
        connectionAtom: atom({ phase: "idle" as const }),
        daemonInstanceIdAtom: atom<string | undefined>(id),
        daemonServerTimeMsAtom: atom<number | undefined>(undefined),
        daemonUptimeSecondsAtom: atom<number | undefined>(undefined),
        daemonInfoAtom: atom<DaemonInfoState>({
          phase: "ready",
          receivedAtMs: 0,
          daemonInfo: {
            supportedProcIds: [ProcId.SubscribeProcesses],
            version: "fixture",
            os: "fixture",
            instanceId: id,
            startedAtMs: 0,
            serverTimeMs: 0,
          },
        }),
        webTransport: async () =>
          ({
            async createBidirectionalStream() {
              diagnostics.starts++;
              let timer: ReturnType<typeof setInterval>;
              const readable = new ReadableStream<Uint8Array>({
                start(controller) {
                  const send = () =>
                    controller.enqueue(
                      encodeReqResMessageSequence([
                        {
                          kind: ReqResMessageKind.ResponseStreamChunk,
                          payload: encodeCbor(
                            encodeProcessesTableEventValue({
                              type: "snapshot",
                              rows: [
                                { pid: 1, name: id, status: { type: "run" } },
                              ],
                            }),
                          ),
                        },
                      ]),
                    );
                  send();
                  timer = setInterval(send, 10);
                },
                cancel() {
                  clearInterval(timer);
                  diagnostics.stops++;
                },
              });
              return { readable, writable: new WritableStream<Uint8Array>() };
            },
          }) as WebTransport,
      };
    }),
  ],
});
function Consumer({ name }: { name: string }) {
  const { stateAtom } = useBunja(processesBunja);
  const state = useAtomValue(stateAtom);
  return (
    <output aria-label={name}>
      {state.phase}:{state.rows.map((row) => row.name).join(",")}
    </output>
  );
}
function Fixture() {
  const [machine, setMachine] = useState("a");
  const [count, setCount] = useState(2);
  return (
    <>
      <button onClick={() => setMachine("b")}>Replace machine</button>
      <button onClick={() => setCount(1)}>One consumer</button>
      <button onClick={() => setCount(0)}>Unmount all</button>
      <button onClick={() => setCount(2)}>Remount</button>
      <MachineContext value={machine}>
        {["list", "tree"].slice(0, count).map((name) => (
          <Consumer key={name} name={name} />
        ))}
      </MachineContext>
    </>
  );
}
createRoot(document.getElementById("root")!).render(
  <JotaiProvider>
    <BunjaStoreContext value={store}>
      <Fixture />
    </BunjaStoreContext>
  </JotaiProvider>,
);
