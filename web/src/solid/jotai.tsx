import {
  createStore,
  type Atom,
  type WritableAtom,
  type Store,
} from "jotai/vanilla";
import {
  createContext,
  createEffect,
  createSignal,
  untrack,
  useContext,
  type Accessor,
  type ParentProps,
} from "solid-js";
import { JotaiStoreScope } from "../state/jotai-store.ts";
import { bindScope } from "./bunja";

const StoreContext = createContext<Accessor<Store>>();
bindScope(JotaiStoreScope, StoreContext);

export function JotaiProvider(props: ParentProps<{ store?: Store }>) {
  const ownedStore = createStore();
  return (
    <StoreContext value={() => props.store ?? ownedStore}>
      {props.children}
    </StoreContext>
  );
}
export function useStore(): Accessor<Store> {
  return useContext(StoreContext);
}
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
      const update = () => {
        const next = store.get(atom);
        setValue((previous) =>
          Object.is(previous.value, next) ? previous : { value: next },
        );
      };
      const unsubscribe = store.sub(atom, update);
      // onMount can write synchronously while the subscription is established.
      update();
      return unsubscribe;
    },
  );
  return () => value().value;
}
export function useAtomValue<T>(atom: Accessor<Atom<T>>): Accessor<T> {
  return readAtom(useContext(StoreContext), atom);
}

export function useSetAtom<T, Args extends unknown[], Result>(
  atom: Accessor<WritableAtom<T, Args, Result>>,
) {
  const store = useContext(StoreContext);
  return (...args: Args): Result => store().set(atom(), ...args);
}
export function useAtom<T, Args extends unknown[], Result>(
  atom: Accessor<WritableAtom<T, Args, Result>>,
): [Accessor<T>, (...args: Args) => Result] {
  return [useAtomValue(atom), useSetAtom(atom)];
}
