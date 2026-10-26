import { useState } from "react";
import { createRoot } from "react-dom/client";
import { bunja } from "bunja";
import { BunjaStoreProvider, useBunja } from "bunja/react";
import { type Atom, useAtomValue } from "jotai";
import { JotaiProvider } from "unsaturated/store";
import { createExplorerRootsBunja } from "../../src/state/explorer.ts";
import { MachineIdContext } from "../../src/state/machine.tsx";
import { WorkbenchTabIdContext } from "../../src/state/workbench-context.ts";
import { MachineStorageContext } from "../../src/state/machine-storage.ts";
import type {
  FsEntry,
  RootsTableEvent,
} from "../../src/protocol/generated/rpc.ts";

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
const session = bunja(() => {
  let active = false;
  bunja.effect(() => {
    active = true;
    return () => {
      active = false;
    };
  });
  return {
    webTransport: () => {
      if (!active) {
        metrics.earlyCalls++;
        throw new Error("RPC owner is not mounted");
      }
      return Promise.resolve({} as WebTransport);
    },
    closeRpcSession() {},
  };
});
const roots = createExplorerRootsBunja(session, () => {
  metrics.opens++;
  let first = true,
    closed = false;
  const pending = Promise.withResolvers<IteratorResult<RootsTableEvent>>();
  const iterator: AsyncGenerator<RootsTableEvent> = {
    next: () => {
      if (!first) return pending.promise;
      first = false;
      return Promise.resolve({
        done: false,
        value: {
          type: "snapshot",
          rows: [{ name: "Fixture root", path: "/", kind: 1, readonly: false }],
        },
      });
    },
    return: () => {
      if (!closed) {
        closed = true;
        metrics.closes++;
      }
      pending.resolve({ done: true, value: undefined });
      return Promise.resolve({ done: true, value: undefined });
    },
    throw: (error: unknown) => Promise.reject(error),
    [Symbol.asyncIterator]() {
      return this;
    },
    [Symbol.asyncDispose]() {
      return Promise.resolve();
    },
  };
  return iterator;
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
  const source = useBunja(roots);
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
    <BunjaStoreProvider>
      <MachineStorageContext value={storage}>
        <Fixture />
      </MachineStorageContext>
    </BunjaStoreProvider>
  </JotaiProvider>,
);
