// App-local experiment, not a replacement for the published bunja/solid API.
import {
  createBunjaStore,
  type Bunja,
  type BunjaOverride,
  type BunjaStore,
  type Scope,
} from "bunja";
import {
  createContext,
  createEffect,
  createMemo,
  createRoot,
  getOwner,
  onCleanup,
  runWithOwner,
  useContext,
  type Accessor,
  type Context,
  type ParentProps,
} from "solid-js";

const StoreContext = createContext<BunjaStore>();
const scopeContexts = new Map<object, Context<Accessor<unknown>>>();
export function bindScope<T>(scope: Scope<T>, context: Context<Accessor<T>>) {
  scopeContexts.set(scope, context as Context<Accessor<unknown>>);
}
export function BunjaProvider(
  props: ParentProps<{ overrides?: readonly BunjaOverride[] }>,
) {
  const owner = getOwner();
  const store = createBunjaStore({
    overrides: props.overrides,
    // v2 roots are owned. Anchor instances to the provider, never the first
    // consumer's memo, so another consumer can keep the same instance alive.
    wrapInstance: (init) => runWithOwner(owner, () => createRoot(init)),
  });
  onCleanup(() => store.dispose());
  return <StoreContext value={store}>{props.children}</StoreContext>;
}
export function useBunja<T, Seed>(definition: Bunja<T, Seed>): Accessor<T> {
  const owner = getOwner();
  const store = useContext(StoreContext);
  const entry = createMemo(() => {
    const scopes = new Set<() => unknown>();
    function read<S>(scope: Scope<S>): S {
      const context = scopeContexts.get(scope);
      if (!context) throw new Error(`Unbound scope: ${scope.id}`);
      const accessor = runWithOwner(owner, () => useContext(context));
      return accessor() as S;
    }
    const resolved = store.get(definition, (scope) => {
      scopes.add(() => read(scope));
      return read(scope);
    });
    // Instance construction runs under its provider root. Re-read the scopes
    // here so this consumer tracks replacements in its own computation.
    for (const readScope of scopes) readScope();
    return resolved;
  });
  createEffect(entry, (resolved) => {
    const release = resolved.mount();
    // Match the published binding's deferred final release across replacement.
    return () => {
      setTimeout(release);
    };
  });
  return () => entry().value;
}
