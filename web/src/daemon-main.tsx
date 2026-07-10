import { createRoot } from "react-dom/client";
import "@unocss/reset/tailwind.css";
import "virtual:uno.css";
import { DaemonMainView } from "./view/daemon-main/index.tsx";

const rootHost = globalThis as typeof globalThis & {
  __rieulDaemonReactRoot?: ReturnType<typeof createRoot>;
};
const reactRoot = rootHost.__rieulDaemonReactRoot ??= createRoot(
  document.getElementById("root")!,
);

reactRoot.render(<DaemonMainView />);
