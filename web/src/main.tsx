import { createRoot } from "react-dom/client";
import { BunjaStoreProvider } from "bunja/react";
import { JotaiProvider } from "unsaturated/store";
import "@unocss/reset/tailwind.css";
import "virtual:uno.css";
import View from "./view/index.tsx";

const rootHost = globalThis as typeof globalThis & {
  __rieulReactRoot?: ReturnType<typeof createRoot>;
};
const reactRoot = rootHost.__rieulReactRoot ??= createRoot(
  document.getElementById("root")!,
);

reactRoot.render(
  <JotaiProvider>
    <BunjaStoreProvider>
      <View />
    </BunjaStoreProvider>
  </JotaiProvider>,
);
