import { render } from "@solidjs/web";
import "../../src/theme.css";
import "../../src/view/workbench/tool/desktop/index.tsx";
import { copyDocumentStyles } from "../../src/solid/popup-styles.ts";

let stop: (() => void) | undefined;
function open() {
  const popup = window.open(
    "about:blank",
    "_blank",
    "popup,width=600,height=400",
  )!;
  popup.document.body.className = "rieul-desktop-window";
  const canvas = popup.document.createElement("canvas");
  canvas.className = "rieul-desktop-canvas";
  canvas.width = 320;
  canvas.height = 180;
  canvas.tabIndex = 0;
  canvas.setAttribute("aria-label", "Remote display fixture");
  popup.document.body.append(canvas);
  stop = copyDocumentStyles(document, popup.document);
  popup.addEventListener("pagehide", () => stop?.(), { once: true });
}
render(
  () => (
    <>
      <button onClick={open}>Open styled popup</button>
      <button onClick={() => stop?.()}>Stop stylesheet sync</button>
    </>
  ),
  document.getElementById("root")!,
);
