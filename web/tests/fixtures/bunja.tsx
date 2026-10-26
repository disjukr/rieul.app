import { type Bunja, bunja } from "bunja";
import { useState } from "react";
import { createRoot } from "react-dom/client";
import { useAtomValue } from "jotai";
import { BunjaStoreProvider, useBunja } from "bunja/react";
import { JotaiProvider } from "unsaturated/store";
import { machineStoreBunja } from "../../src/state/machine-store.ts";
import { MachineStorageContext } from "../../src/state/machine-storage.ts";
function domain() {
  const data = new Map<string, string>();
  const result = {
    writes: 0,
    storage: {
      getItem: (key: string) => data.get(key) ?? null,
      setItem: (key: string, value: string) => {
        result.writes++;
        data.set(key, value);
      },
      removeItem: (key: string) => {
        result.writes++;
        data.delete(key);
      },
    },
  };
  return result;
}
const domains = [domain(), domain()];
type MachineState =
  typeof machineStoreBunja extends Bunja<infer Value> ? Value : never;
const diagnostics = {
  domains,
  cleanups: 0,
  lastStore: undefined as MachineState | undefined,
};
// Keep diagnostics entirely inside this isolated fixture.
Object.assign(window, { fixture: diagnostics });
const fixtureMachineBunja = bunja(() => {
  const state = bunja.use(machineStoreBunja);
  bunja.effect(() => () => {
    diagnostics.cleanups++;
  });
  return state;
});
function Consumer({ name }: { name: string }) {
  const state = useBunja(fixtureMachineBunja);
  diagnostics.lastStore = state;
  const machines = useAtomValue(state.machinesAtom);
  return (
    <section>
      <output aria-label={name}>{machines.length}</output>
      <button
        onClick={() =>
          state.addMachine({
            id: crypto.randomUUID(),
            name: "Fixture",
            baseUrl: "https://fixture.invalid:9012",
          })
        }
      >
        Add from {name}
      </button>
    </section>
  );
}
function Fixture() {
  const [count, setCount] = useState(2);
  const [selected, setSelected] = useState(0);
  return (
    <>
      <button onClick={() => setCount(1)}>One consumer</button>
      <button onClick={() => setCount(0)}>Unmount all</button>
      <button onClick={() => setCount(2)}>Remount</button>
      <button onClick={() => setSelected(1)}>Replace domain</button>
      <MachineStorageContext value={domains[selected].storage}>
        {["one", "two"].slice(0, count).map((name) => (
          <Consumer key={name} name={name} />
        ))}
      </MachineStorageContext>
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
