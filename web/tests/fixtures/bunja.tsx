import { type Bunja, bunja } from "bunja";
import { createSignal, createEffect, For } from "solid-js";
import { render } from "@solidjs/web";
import { useAtomValue, JotaiProvider } from "../../src/solid/jotai.tsx";
import { BunjaProvider, useBunja } from "../../src/solid/bunja.tsx";
import { machineStoreBunja } from "../../src/state/machine-store.ts";
import { MachineStorageContext } from "../../src/solid/scopes.ts";
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
function Consumer(props: { name: string }) {
  const state = useBunja(fixtureMachineBunja);
  createEffect(state, (current) => {
    diagnostics.lastStore = current;
  });
  const machines = useAtomValue(() => state().machinesAtom);
  return (
    <section>
      <output aria-label={props.name}>{machines().length}</output>
      <button
        onClick={() =>
          state().addMachine({
            id: crypto.randomUUID(),
            name: "Fixture",
            baseUrl: "https://fixture.invalid:9012",
          })
        }
      >
        Add from {props.name}
      </button>
    </section>
  );
}
function Fixture() {
  const [count, setCount] = createSignal(2);
  const [selected, setSelected] = createSignal(0);
  return (
    <>
      <button onClick={() => setCount(1)}>One consumer</button>
      <button onClick={() => setCount(0)}>Unmount all</button>
      <button onClick={() => setCount(2)}>Remount</button>
      <button onClick={() => setSelected(1)}>Replace domain</button>
      <MachineStorageContext value={() => domains[selected()].storage}>
        <For each={["one", "two"].slice(0, count())}>
          {(name) => <Consumer name={name} />}
        </For>
      </MachineStorageContext>
    </>
  );
}
render(
  () => (
    <JotaiProvider>
      <BunjaProvider>
        <Fixture />
      </BunjaProvider>
    </JotaiProvider>
  ),
  document.getElementById("root")!,
);
