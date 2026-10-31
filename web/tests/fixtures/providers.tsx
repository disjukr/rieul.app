import { bunja, override } from "bunja";
import { createSignal, onCleanup, Show } from "solid-js";
import { render } from "@solidjs/web";
import { BunjaProvider, useBunja } from "../../src/solid/bunja";

const events: string[] = [];
const service = bunja(() => ({ name: "default" }));
const resource = bunja(() => {
  const { name } = bunja.use(service);
  const [count, setCount] = createSignal(0);
  onCleanup(() => events.push(`root:${name}`));
  bunja.effect(() => {
    events.push(`mount:${name}`);
    return () => {
      events.push(`release:${name}`);
    };
  });
  return { name, count, increment: () => setCount((value) => value + 1) };
});
Object.assign(window, { providerEvents: events });
function Consumer(props: { label: string }) {
  const model = useBunja(resource);
  return (
    <button aria-label={props.label} onClick={() => model().increment()}>
      {model().name}:{model().count()}
    </button>
  );
}
function Fixture() {
  const [nested, setNested] = createSignal(true);
  const [outer, setOuter] = createSignal(true);
  return (
    <>
      <button onClick={() => setNested(false)}>Remove nested providers</button>
      <button onClick={() => setOuter(false)}>Remove outer provider</button>
      <Show when={outer()}>
        <BunjaProvider
          overrides={[override(service, () => ({ name: "outer" }))]}
        >
          <Consumer label="outer one" />
          <Consumer label="outer two" />
          <Show when={nested()}>
            <BunjaProvider
              overrides={[override(service, () => ({ name: "inner" }))]}
            >
              <Consumer label="inner one" />
              <Consumer label="inner two" />
            </BunjaProvider>
            <BunjaProvider>
              <Consumer label="independent default" />
            </BunjaProvider>
          </Show>
        </BunjaProvider>
      </Show>
    </>
  );
}
render(() => <Fixture />, document.getElementById("root")!);
