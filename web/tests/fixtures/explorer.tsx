import { rpcSessionBunja } from "../../src/state/rpc-session.ts";
import { rpcSessionStub } from "../helpers/rpc-session.ts";
import { encodeRootsTableEventValue } from "../../src/protocol/generated/rpc.ts";
import { encodeCbor } from "../../src/protocol/cbor.ts";
import {
  encodeReqResMessageSequence,
  ReqResMessageKind,
} from "../../src/protocol/wire.ts";
import { createSignal, For } from "solid-js";
import { render } from "@solidjs/web";
import { bunja, override } from "bunja";
import { BunjaProvider, useBunja } from "../../src/solid/bunja.tsx";
import type { Atom } from "jotai/vanilla";
import { useAtomValue, JotaiProvider } from "../../src/solid/jotai.tsx";
import { explorerRootsBunja } from "../../src/state/explorer.ts";
import { MachineIdContext } from "../../src/state/machine.tsx";
import { WorkbenchTabIdContext } from "../../src/state/workbench-context.ts";
import { MachineStorageContext } from "../../src/solid/scopes.ts";
import type { FsEntry } from "../../src/protocol/generated/rpc.ts";

const metrics = { opens: 0, closes: 0, earlyCalls: 0 };
Object.assign(window, { explorerFixture: metrics });
const storage = {
  getItem: (key: string) =>
    key === "rieul.machines.v1"
      ? JSON.stringify([
          {
            id: "fixture",
            name: "Fixture",
            baseUrl: "https://fixture.invalid:9012",
            clientId: "fixture",
            clientSecret: "fixture",
          },
        ])
      : "fixture",
  setItem() {},
  removeItem() {},
};
const overrides = [
  override(rpcSessionBunja, () => {
    let active = false;
    bunja.effect(() => {
      active = true;
      return () => {
        active = false;
      };
    });
    return rpcSessionStub({
      webTransport: () => {
        if (!active) {
          metrics.earlyCalls++;
          throw new Error("RPC owner is not mounted");
        }
        return Promise.resolve({
          async createBidirectionalStream() {
            metrics.opens++;
            let timer: ReturnType<typeof setInterval>;
            return {
              writable: new WritableStream<Uint8Array>(),
              readable: new ReadableStream<Uint8Array>({
                start(controller) {
                  const send = () =>
                    controller.enqueue(
                      encodeReqResMessageSequence([
                        {
                          kind: ReqResMessageKind.ResponseStreamChunk,
                          payload: encodeCbor(
                            encodeRootsTableEventValue({
                              type: "snapshot",
                              rows: [
                                {
                                  name: "Fixture root",
                                  path: "/",
                                  kind: 1,
                                  readonly: false,
                                },
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
                  metrics.closes++;
                },
              }),
            };
          },
        } as WebTransport);
      },
      closeRpcSession() {},
    });
  }),
];
function Rows(props: { atom: Atom<FsEntry[]>; name: string }) {
  const entries = useAtomValue(() => props.atom);
  return (
    <output aria-label={props.name}>
      {entries()
        .map((entry) => entry.name)
        .join(",")}
    </output>
  );
}
function Owner(props: { name: string }) {
  const source = useBunja(explorerRootsBunja);
  // Exercise row observation together with its Bunja owner effect.
  return <Rows atom={source().rootsAtom} name={props.name} />;
}
function Fixture() {
  const [count, setCount] = createSignal(2);
  return (
    <>
      <button onClick={() => setCount(1)}>Keep one owner</button>
      <button onClick={() => setCount(0)}>Remove owners</button>
      <MachineIdContext value={() => "fixture"}>
        <WorkbenchTabIdContext value={() => "tab"}>
          <For each={["one", "two"].slice(0, count())}>
            {(name) => <Owner name={name} />}
          </For>
        </WorkbenchTabIdContext>
      </MachineIdContext>
    </>
  );
}
render(
  () => (
    <JotaiProvider>
      <BunjaProvider overrides={overrides}>
        <MachineStorageContext value={() => storage}>
          <Fixture />
        </MachineStorageContext>
      </BunjaProvider>
    </JotaiProvider>
  ),
  document.getElementById("root")!,
);
