import { bunja, createScope, override } from "bunja";
import { atom, createStore } from "jotai/vanilla";
import { createContext, createSignal, onCleanup, Show } from "solid-js";
import { render } from "@solidjs/web";
import { bindScope, BunjaProvider, useBunja } from "./bunja-solid-v2";
import { readAtom } from "./jotai-solid-v2";

const StoreScope = createScope<ReturnType<typeof createStore>>();
const KeyScope = createScope<string>();
const StoreContext = createContext<() => ReturnType<typeof createStore>>();
const KeyContext = createContext<() => string>();
bindScope(StoreScope, StoreContext);
bindScope(KeyScope, KeyContext);
const metrics = {
  created: 0,
  mounted: 0,
  released: 0,
  rootsDisposed: 0,
  observations: 0,
  unobservations: 0,
};
const serviceBunja = bunja(() => ({ name: "production" }));
const modelBunja = bunja(() => {
  const store = bunja.use(StoreScope);
  const key = bunja.use(KeyScope);
  const service = bunja.use(serviceBunja);
  const id = ++metrics.created;
  const count = atom(0);
  const [owned, setOwned] = createSignal(0);
  count.onMount = (set) => {
    metrics.observations++;
    set(1);
    return () => {
      metrics.unobservations++;
    };
  };
  onCleanup(() => {
    metrics.rootsDisposed++;
  });
  bunja.effect(() => {
    metrics.mounted++;
    return () => {
      metrics.released++;
    };
  });
  return {
    id,
    key,
    service,
    store,
    count,
    owned,
    increment() {
      store.set(count, (value) => value + 1);
      setOwned((value) => value + 1);
    },
  };
});
Object.assign(window, { fixture: { metrics } });
function Consumer(props: { name: string }) {
  const model = useBunja(modelBunja);
  const count = readAtom(
    () => model().store,
    () => model().count,
  );
  return (
    <section>
      <output
        aria-label={props.name}
      >{`${model().id}:${model().key}:${model().service.name}:${count()}:${model().owned()}`}</output>
      <button onClick={() => model().increment()}>
        Increment {props.name}
      </button>
    </section>
  );
}
function App() {
  const stores = [createStore(), createStore()];
  const [store, setStore] = createSignal(0);
  const [key, setKey] = createSignal("A");
  const [first, setFirst] = createSignal(true);
  const [second, setSecond] = createSignal(true);
  const [provider, setProvider] = createSignal(true);
  return (
    <>
      <button onClick={() => setFirst(false)}>Remove first</button>
      <button
        onClick={() => {
          setFirst(false);
          setSecond(false);
        }}
      >
        Remove all
      </button>
      <button
        onClick={() => {
          setFirst(true);
          setSecond(true);
        }}
      >
        Remount
      </button>
      <button onClick={() => setKey("B")}>Replace scope</button>
      <button onClick={() => setStore(1)}>Replace store</button>
      <button onClick={() => setProvider(false)}>Dispose provider</button>
      <Show when={provider()}>
        <StoreContext value={() => stores[store()]}>
          <KeyContext value={key}>
            <BunjaProvider
              overrides={[override(serviceBunja, () => ({ name: "override" }))]}
            >
              <Show when={first()}>
                <Consumer name="first" />
              </Show>
              <Show when={second()}>
                <Consumer name="second" />
              </Show>
            </BunjaProvider>
          </KeyContext>
        </StoreContext>
      </Show>
    </>
  );
}
render(() => <App />, document.getElementById("root")!);
