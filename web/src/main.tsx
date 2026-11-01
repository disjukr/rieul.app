import { render } from "@solidjs/web";
import { BunjaProvider } from "./solid/bunja";
import "./solid/scopes";
import "@unocss/reset/tailwind.css";
import "virtual:uno.css";
import View from "./view/index.tsx";

const dispose = render(
  () => (
    <BunjaProvider>
      <View />
    </BunjaProvider>
  ),
  document.getElementById("root")!,
);
if (import.meta.hot) import.meta.hot.dispose(dispose);
