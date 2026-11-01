import { bunja, createScope } from "bunja";
import { createContext, createEffect, createSignal, Show } from "solid-js";
import { render } from "@solidjs/web";
import { BunjaProvider, bindScope, useBunja } from "../../src/solid/bunja.tsx";

const counterBunja = bunja(() => {
  const [count, setCount] = createSignal(0);
  return { count, setCount };
});
function MountWriter() {
  const counter = useBunja(counterBunja);
  createEffect(counter, (current) => {
    current.setCount(1);
  });
  return null;
}
function Reader(props: { name: string; initialize?: boolean }) {
  const counter = useBunja(counterBunja);
  return (
    <section>
      <Show when={props.initialize}>
        <MountWriter />
      </Show>
      <output aria-label={props.name}>{counter().count()}</output>
      <button onClick={() => counter().setCount((value) => value + 1)}>
        Increment {props.name}
      </button>
    </section>
  );
}
const SelectionContext = createContext<() => number>(() => 0);
const DomainContext = createContext<() => number>(() => 0);
const SelectionScope = createScope<number>();
const DomainScope = createScope<number>();
bindScope(SelectionScope, SelectionContext);
bindScope(DomainScope, DomainContext);
const observations = { mounts: 0, cleanups: 0 };
const previous = new Map<string, (value: number) => void>();
const replacementBunja = bunja(() => {
  const selected = bunja.use(SelectionScope);
  const domain = bunja.use(DomainScope);
  const [value, setValue] = createSignal(selected === 0 ? 10 : 20);
  bunja.effect(() => {
    previous.set(`${domain}:${selected}`, setValue);
    observations.mounts++;
    return () => {
      observations.cleanups++;
    };
  });
  return value;
});
Object.assign(window, { signalFixture: observations });
function ReplacementReader() {
  const value = useBunja(replacementBunja);
  return <output aria-label="replacement">{value()()}</output>;
}
function ReplacementFixture() {
  const [selected, setSelected] = createSignal(0);
  const [domain, setDomain] = createSignal(0);
  const [visible, setVisible] = createSignal(true);
  return (
    <>
      <button onClick={() => setSelected(1)}>Replace signal</button>
      <button onClick={() => previous.get("0:0")?.(99)}>
        Write stale signal
      </button>
      <button onClick={() => previous.get("0:1")?.(88)}>
        Write old domain
      </button>
      <button onClick={() => setDomain(1)}>Replace domain</button>
      <button onClick={() => setVisible(false)}>Remove reader</button>
      <BunjaProvider>
        <DomainContext value={domain}>
          <SelectionContext value={selected}>
            <Show when={visible()}>
              <ReplacementReader />
            </Show>
          </SelectionContext>
        </DomainContext>
      </BunjaProvider>
    </>
  );
}
render(
  () => (
    <>
      <BunjaProvider>
        <Reader name="first" initialize />
      </BunjaProvider>
      <BunjaProvider>
        <Reader name="second" />
      </BunjaProvider>
      <ReplacementFixture />
    </>
  ),
  document.getElementById("root")!,
);
