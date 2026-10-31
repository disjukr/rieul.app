import { bunja, createScope, override } from "bunja";
import { BunjaProvider, bindScope, useBunja } from "../../src/solid/bunja.tsx";
import { createContext, createSignal, For } from "solid-js";
import { render } from "@solidjs/web";
import { atom } from "jotai/vanilla";
import { useAtomValue, JotaiProvider } from "../../src/solid/jotai.tsx";
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
const MachineContext = createContext<() => string>(() => "a");
const MachineScope = createScope<string>();
bindScope(MachineScope, MachineContext);
const diagnostics = { starts: 0, stops: 0 };
Object.assign(window, { processesFixture: diagnostics });
function unused(): never {
  throw new Error("Unexpected RPC method");
}
const overrides = [
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
];
function Consumer(props: { name: string }) {
  const source = useBunja(processesBunja);
  const state = useAtomValue(() => source().stateAtom);
  return (
    <output aria-label={props.name}>
      {state().phase}:
      {state()
        .rows.map((row) => row.name)
        .join(",")}
    </output>
  );
}
function Fixture() {
  const [machine, setMachine] = createSignal("a");
  const [count, setCount] = createSignal(2);
  return (
    <>
      <button onClick={() => setMachine("b")}>Replace machine</button>
      <button onClick={() => setCount(1)}>One consumer</button>
      <button onClick={() => setCount(0)}>Unmount all</button>
      <button onClick={() => setCount(2)}>Remount</button>
      <MachineContext value={machine}>
        <For each={["list", "tree"].slice(0, count())}>
          {(name) => <Consumer name={name} />}
        </For>
      </MachineContext>
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
