import { atom, createStore } from "jotai/vanilla";
import { createEffect, createSignal, Show } from "solid-js";
import { render } from "@solidjs/web";
import {
  JotaiProvider,
  useAtomValue,
  useStore,
} from "../../src/solid/jotai.tsx";

const countAtom = atom(0);
function MountWriter() {
  const store = useStore();
  createEffect(
    () => store,
    (current) => {
      current.set(countAtom, 1);
    },
  );
  return null;
}
function Reader(props: { name: string; initialize?: boolean }) {
  const count = useAtomValue(() => countAtom);
  const store = useStore();
  return (
    <section>
      <Show when={props.initialize}>
        <MountWriter />
      </Show>
      <output aria-label={props.name}>{count()}</output>
      <button onClick={() => store.set(countAtom, (value) => value + 1)}>
        Increment {props.name}
      </button>
    </section>
  );
}
const atoms = [atom(10), atom(20)];
const stores = [createStore(), createStore()];
const observations = { mounts: 0, cleanups: 0 };
for (const target of atoms) {
  target.onMount = () => {
    observations.mounts++;
    return () => {
      observations.cleanups++;
    };
  };
}
Object.assign(window, { atomFixture: observations });
function ReplacementReader(props: { selected: number }) {
  const value = useAtomValue(() => atoms[props.selected]);
  return <output aria-label="replacement">{value()}</output>;
}
function ReplacementFixture() {
  const [selected, setSelected] = createSignal(0);
  const [domain, setDomain] = createSignal(0);
  const [visible, setVisible] = createSignal(true);
  return (
    <>
      <button onClick={() => setSelected(1)}>Replace atom</button>
      <button onClick={() => stores[0].set(atoms[0], 99)}>
        Write stale atom
      </button>
      <button onClick={() => stores[0].set(atoms[1], 88)}>
        Write old store
      </button>
      <button onClick={() => setDomain(1)}>Replace store</button>
      <button onClick={() => setVisible(false)}>Remove reader</button>
      <JotaiProvider store={stores[domain()]}>
        <Show when={visible()}>
          <ReplacementReader selected={selected()} />
        </Show>
      </JotaiProvider>
    </>
  );
}
render(
  () => (
    <>
      <JotaiProvider>
        <Reader name="first" initialize />
      </JotaiProvider>
      <JotaiProvider>
        <Reader name="second" />
      </JotaiProvider>
      <ReplacementFixture />
    </>
  ),
  document.getElementById("root")!,
);
