import { createStore } from "jotai/vanilla";
import { createContext, createSignal, Show } from "solid-js";
import { render } from "@solidjs/web";
import { JotaiStoreScope } from "unsaturated/store";
import {
  machineStoreBunja,
  machineBunja,
} from "../../../web/src/state/machine-store.ts";
import {
  MachineStorageScope,
  type MachineStorage,
} from "../../../web/src/state/machine-storage.ts";
import { MachineIdScope } from "../../../web/src/state/machine-scopes.ts";
import { bindScope, BunjaProvider, useBunja } from "./bunja-solid-v2";
import { readAtom } from "./jotai-solid-v2";
const StoreContext = createContext<() => ReturnType<typeof createStore>>();
const StorageContext = createContext<() => MachineStorage>();
const MachineContext = createContext<() => string | undefined>();
bindScope(JotaiStoreScope, StoreContext);
bindScope(MachineStorageScope, StorageContext);
bindScope(MachineIdScope, MachineContext);
const diagnostics = {
  writes: [0, 0],
  last: undefined as ReturnType<typeof machineStoreBunja.init> | undefined,
};
Object.assign(window, { productionFixture: diagnostics });
const storageDomains = [0, 1].map((index) => {
  const data = new Map<string, string>();
  return {
    getItem: (key: string) => data.get(key) ?? null,
    setItem: (key: string, value: string) => {
      diagnostics.writes[index]++;
      data.set(key, value);
    },
    removeItem: (key: string) => {
      data.delete(key);
    },
  } satisfies MachineStorage;
});
function Consumer(props: { name: string }) {
  const model = useBunja(machineStoreBunja);
  const machine = useBunja(machineBunja);
  const rows = readAtom(
    () => store,
    () => model().machinesAtom,
  );
  const scoped = readAtom(
    () => store,
    () => machine().machineAtom,
  );
  return (
    <section>
      <output aria-label={props.name}>
        {rows().length}:{scoped()?.name ?? "none"}
      </output>
      <button
        onClick={() => {
          diagnostics.last = model();
          model().addMachine({
            id: "A",
            name: "Machine A",
            baseUrl: "https://a.invalid:9012",
          });
        }}
      >
        Add {props.name}
      </button>
      <button
        onClick={() => {
          model().addMachine({
            id: "B",
            name: "Machine B",
            baseUrl: "https://b.invalid:9012",
          });
        }}
      >
        Select B {props.name}
      </button>
    </section>
  );
}
const store = createStore();
function App() {
  const [domain, setDomain] = createSignal(0),
    [count, setCount] = createSignal(2);
  return (
    <>
      <button onClick={() => setCount(1)}>Keep one</button>
      <button onClick={() => setCount(0)}>Remove all</button>
      <button onClick={() => setCount(2)}>Remount</button>
      <button onClick={() => setDomain(1)}>Replace storage</button>
      <StoreContext value={() => store}>
        <StorageContext value={() => storageDomains[domain()]}>
          <MachineContext value={() => "A"}>
            <BunjaProvider>
              <Show when={count() > 0}>
                <Consumer name="one" />
              </Show>
              <Show when={count() > 1}>
                <Consumer name="two" />
              </Show>
            </BunjaProvider>
          </MachineContext>
        </StorageContext>
      </StoreContext>
    </>
  );
}
render(() => <App />, document.getElementById("root")!);
