import type { Atom, Store } from "jotai/vanilla";
import { createEffect, createSignal, untrack, type Accessor } from "solid-js";

// Jotai remains the source of truth. No mirrored model or atom factories.
export function readAtom<T>(
  store: Accessor<Store>,
  atom: Accessor<Atom<T>>,
): Accessor<T> {
  const [value, setValue] = createSignal({
    value: untrack(() => store().get(atom())),
  });
  createEffect(
    () => ({ store: store(), atom: atom() }),
    ({ store, atom }) => {
      const update = () => setValue({ value: store.get(atom) });
      const unsubscribe = store.sub(atom, update);
      // onMount can write while subscribing; read again after the subscription.
      update();
      return unsubscribe;
    },
  );
  return () => value().value;
}
