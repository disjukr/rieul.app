import { bunja } from "bunja";
import {
  BunjaStoreProvider,
  createScopeFromContext,
  useBunja,
} from "bunja/react";
import { createContext, useState } from "react";
import { createRoot } from "react-dom/client";
import { atom, useAtomValue } from "jotai";
import { JotaiProvider } from "unsaturated/store";
import { createProcessesBunja } from "../../src/state/processes-model.ts";
import type { DaemonInfoState } from "../../src/state/rpc-session.ts";
import {
  ProcId,
  type ProcessesTableEvent,
} from "../../src/protocol/generated/rpc.ts";
const MachineContext = createContext("a");
const MachineScope = createScopeFromContext(MachineContext);
const diagnostics = { starts: 0, stops: 0 };
Object.assign(window, { processesFixture: diagnostics });
const session = bunja(() => {
  const id = bunja.use(MachineScope);
  return {
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
    webTransport: async () => ({ id }) as unknown as WebTransport,
  };
});
const model = createProcessesBunja(session, (transport) => {
  diagnostics.starts++;
  const id = (transport as unknown as { id: string }).id;
  let first = true;
  const pending = Promise.withResolvers<IteratorResult<ProcessesTableEvent>>();
  return {
    next: async () => {
      if (!first) return pending.promise;
      first = false;
      return {
        done: false as const,
        value: {
          type: "snapshot" as const,
          rows: [{ pid: 1, name: id, status: { type: "run" as const } }],
        },
      };
    },
    return: async () => {
      diagnostics.stops++;
      pending.resolve({ done: true, value: undefined });
      return { done: true as const, value: undefined };
    },
    throw: async (error: unknown) => {
      throw error;
    },
    [Symbol.asyncIterator]() {
      return this;
    },
    [Symbol.asyncDispose]: async () => {},
  };
});
function Consumer({ name }: { name: string }) {
  const { stateAtom } = useBunja(model);
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
    <BunjaStoreProvider>
      <Fixture />
    </BunjaStoreProvider>
  </JotaiProvider>,
);
