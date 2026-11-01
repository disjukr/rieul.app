import { createBunjaStore, type BunjaOverride } from "bunja";
import { BunjaStoreContext } from "bunja/solid";
import {
  createRoot,
  getOwner,
  onCleanup,
  runWithOwner,
  type ParentProps,
} from "solid-js";

// Fixture-only custom stores exercise the public override API. Production uses
// BunjaStoreProvider directly; hooks and scope registration always come upstream.
export function TestBunjaStoreProvider(
  props: ParentProps<{ overrides?: readonly BunjaOverride[] }>,
) {
  const owner = getOwner();
  const store = createBunjaStore({
    overrides: props.overrides,
    wrapInstance: (init) => runWithOwner(owner, () => createRoot(init)),
  });
  onCleanup(() => store.dispose());
  return <BunjaStoreContext value={store}>{props.children}</BunjaStoreContext>;
}
