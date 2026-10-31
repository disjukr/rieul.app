import { render } from "@solidjs/web";
import { BunjaProvider } from "./solid/bunja";
import { JotaiProvider } from "./solid/jotai";
import "./solid/scopes";
import "@unocss/reset/tailwind.css";
import "virtual:uno.css";
import View from "./view/index.tsx";

const dispose = render(
  () => (
    <JotaiProvider>
      <BunjaProvider>
        <View />
      </BunjaProvider>
    </JotaiProvider>
  ),
  document.getElementById("root")!,
);
if (import.meta.hot) import.meta.hot.dispose(dispose);
