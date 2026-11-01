import { render } from "@solidjs/web";
import { BunjaStoreProvider } from "bunja/solid";
import "./solid/scopes";
import "@unocss/reset/tailwind.css";
import "virtual:uno.css";
import View from "./view/index.tsx";

const dispose = render(
  () => (
    <BunjaStoreProvider>
      <View />
    </BunjaStoreProvider>
  ),
  document.getElementById("root")!,
);
if (import.meta.hot) import.meta.hot.dispose(dispose);
