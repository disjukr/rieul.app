import { style } from "../../../../../../zyzz.config.ts";
import { Dynamic } from "@solidjs/web";
import { createMemo, Loading } from "solid-js";
import { useBunja } from "bunja/solid";

import { Loader2 } from "../../../../../../solid/icons.tsx";
import { FileViewerFooter } from "./footer/index.tsx";
import { getFileViewerImpl } from "./impl/index.ts";
import { fileViewerBunja } from "./state.tsx";

export function FileViewer() {
  const viewer = useBunja(fileViewerBunja);
  const state = () => viewer().state();
  const impl = () => viewer().impl();
  const Impl = createMemo(() => {
    const value = impl();
    return value ? getFileViewerImpl(value).Component : undefined;
  });
  const errorMessage = createMemo(() => {
    const value = state();
    return value.phase === "error" ? value.message : "";
  });
  return (
    <section {...styles.fileViewer()}>
      {state().phase === "detecting" ? (
        <div {...styles.fileViewerStatus()}>
          <Loader2 size={18} className={styles.loader2().class} />
          <span>Detecting viewer</span>
        </div>
      ) : state().phase === "error" ? (
        <div role="alert" class={`${styles.fileViewerStatus().class} error`}>
          {errorMessage()}
        </div>
      ) : Impl() ? (
        <Loading
          fallback={
            <div {...styles.fileViewerStatus()}>
              <Loader2 size={18} className={styles.loader2().class} />
              <span>Loading viewer</span>
            </div>
          }
        >
          <Dynamic component={Impl()} />
        </Loading>
      ) : null}
      <FileViewerFooter />
    </section>
  );
}

namespace styles {
  export const fileViewerStatus = style({
    minHeight: "0",
    minWidth: "0",
    display: "flex",
    selectors: {
      "&.error": {
        alignItems: "flex-start",
        justifyContent: "flex-start",
        overflow: "auto",
        padding: "14px",
        color: "rgb(180 35 24 / 1)",
      },
    },
    alignItems: "center",
    justifyContent: "center",
    gap: "8px",
    fontSize: "14px",
    color: "rgb(102 112 133 / 1)",
  });
  export const fileViewer = style({
    gridTemplateRows: "minmax(0,1fr) auto",
    display: "grid",
    height: "100%",
    minHeight: "0",
    minWidth: "0",
    width: "100%",
    overflow: "hidden",
    backgroundColor: "rgb(255 255 255 / 1)",
  });
  export const loader2 = style({
    animation: "spin 1s linear infinite",
  });
}
