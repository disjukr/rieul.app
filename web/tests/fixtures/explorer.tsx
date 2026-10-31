import { rpcSessionBunja } from "../../src/state/rpc-session.ts";
import { rpcSessionStub } from "../helpers/rpc-session.ts";
import { encodeRootsTableEventValue } from "../../src/protocol/generated/rpc.ts";
import { encodeCbor } from "../../src/protocol/cbor.ts";
import {
  encodeReqResMessageSequence,
  ReqResMessageKind,
} from "../../src/protocol/wire.ts";
import { useState } from "react";
import { createRoot } from "react-dom/client";
import { bunja, createBunjaStore, override } from "bunja";
import { BunjaStoreContext, useBunja } from "bunja/react";
import { type Atom, useAtomValue } from "jotai";
import { JotaiProvider } from "unsaturated/store";
import { explorerRootsBunja } from "../../src/state/explorer.ts";
import { MachineIdContext } from "../../src/state/machine.tsx";
import { WorkbenchTabIdContext } from "../../src/state/workbench-context.ts";
import { MachineStorageContext } from "../../src/state/machine-storage.ts";
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
const store = createBunjaStore({
  overrides: [
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
  ],
});
function Rows({ atom, name }: { atom: Atom<FsEntry[]>; name: string }) {
  const entries = useAtomValue(atom);
  return (
    <output aria-label={name}>
      {entries.map((entry) => entry.name).join(",")}
    </output>
  );
}
function Owner({ name }: { name: string }) {
  const source = useBunja(explorerRootsBunja);
  // The child subscribes before its parent's Bunja mount effect in React.
  return <Rows atom={source.rootsAtom} name={name} />;
}
function Fixture() {
  const [count, setCount] = useState(2);
  return (
    <>
      <button onClick={() => setCount(1)}>Keep one owner</button>
      <button onClick={() => setCount(0)}>Remove owners</button>
      <MachineIdContext value="fixture">
        <WorkbenchTabIdContext value="tab">
          {["one", "two"].slice(0, count).map((name) => (
            <Owner key={name} name={name} />
          ))}
        </WorkbenchTabIdContext>
      </MachineIdContext>
    </>
  );
}
createRoot(document.getElementById("root")!).render(
  <JotaiProvider>
    <BunjaStoreContext value={store}>
      <MachineStorageContext value={storage}>
        <Fixture />
      </MachineStorageContext>
    </BunjaStoreContext>
  </JotaiProvider>,
);
