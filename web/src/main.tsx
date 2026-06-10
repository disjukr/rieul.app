import { createContext } from "react";
import { createRoot } from "react-dom/client";
import { createStore, Provider as JotaiProvider } from "jotai";
import { bindScope, BunjaStoreProvider } from "bunja/react";
// @ts-ignore css
import "./styles.css";
import { type JotaiStore, JotaiStoreScope } from "./state/jotai-store.ts";
import View from "./view/index.tsx";

const jotaiStore = createStore();
const JotaiStoreContext = createContext<JotaiStore>(jotaiStore);
bindScope(JotaiStoreScope, JotaiStoreContext);

const rootHost = globalThis as typeof globalThis & {
  __wgoReactRoot?: ReturnType<typeof createRoot>;
};
const reactRoot = rootHost.__wgoReactRoot ??= createRoot(
  document.getElementById("root")!,
);

reactRoot.render(
  <JotaiProvider store={jotaiStore}>
    <JotaiStoreContext value={jotaiStore}>
      <BunjaStoreProvider>
        <View />
      </BunjaStoreProvider>
    </JotaiStoreContext>
  </JotaiProvider>,
);
