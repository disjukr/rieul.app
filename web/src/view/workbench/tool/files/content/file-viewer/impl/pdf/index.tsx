import { style } from "../../../../../../../../zyzz.config.ts";
import { createMemo, createSignal, createEffect, useContext } from "solid-js";
import * as pdfjs from "pdfjs-dist";
import { useBunja } from "bunja/solid";

import type { FsEntry } from "../../../../../../../../protocol/generated/rpc.ts";
import { readFileBytes } from "../../read-file-bytes.ts";
import {
  FilesActionsContext,
  requireFilesActions,
} from "../../../../context.tsx";
import { BigFileWarning } from "../../big-file-warning.tsx";
import { fileViewerBunja } from "../../state.tsx";
pdfjs.GlobalWorkerOptions.workerSrc = new URL(
  "../../../../../../../../../node_modules/pdfjs-dist/build/pdf.worker.mjs",
  import.meta.url,
).toString();
const inlineOpenLimitBytes = 1024 * 1024;
const pageCssScale = 1.25;
const maxRenderPixelRatio = 2;

type PdfReadState =
  | {
      phase: "loading";
    }
  | {
      phase: "ready";
      bytes: Uint8Array;
    }
  | {
      phase: "error";
      message: string;
    };
type PdfRenderState =
  | {
      phase: "idle";
    }
  | {
      phase: "rendering";
      pageCount?: number;
      renderedPages: number;
    }
  | {
      phase: "ready";
      pageCount: number;
    }
  | {
      phase: "error";
      message: string;
    };
const pdfViewerName = "pdf viewer";
export default function PdfFileViewer() {
  const actions = requireFilesActions(useContext(FilesActionsContext));
  const viewer = useBunja(fileViewerBunja);
  const fsEntry = createMemo(() => viewer().fsEntry);
  const viewerState = () => viewer().state();
  const machine = () => viewer().machine();
  const webTransport = createMemo(() => viewer().webTransport);
  const requiresConfirmation = createMemo(() => {
    const size = fsEntry().size;
    return size === undefined || size > inlineOpenLimitBytes;
  });
  const [confirmedFsEntryPath, setConfirmedFsEntryPath] = createSignal<
    string | undefined
  >();
  const confirmed = createMemo(
    () => !requiresConfirmation() || confirmedFsEntryPath() === fsEntry().path,
  );
  const [state, setState] = createSignal<PdfReadState>({ phase: "loading" });
  const readyState = createMemo(() => {
    const value = state();
    return value.phase === "ready" ? value : undefined;
  });
  const errorMessage = createMemo(() => {
    const value = state();
    return value.phase === "error" ? value.message : "";
  });

  createEffect(
    () => ({
      confirmed: confirmed(),
      machine: machine(),
      viewerState: viewerState(),
      fsEntry: fsEntry(),
      webTransport: webTransport(),
    }),
    ({
      confirmed: currentConfirmed,
      machine: currentMachine,
      viewerState: currentViewerState,
      fsEntry: currentFsEntry,
      webTransport: currentWebTransport,
    }) => {
      if (
        !currentConfirmed ||
        !currentMachine ||
        currentViewerState.phase !== "ready"
      )
        return;
      let cancelled = false;
      setState({ phase: "loading" });
      void (async () => {
        try {
          const bytes = hasCompleteInitialBytes(
            currentFsEntry,
            currentViewerState.initialBytes,
          )
            ? currentViewerState.initialBytes
            : await readFileBytes(
                await currentWebTransport(),
                currentFsEntry.path,
              );
          if (cancelled) return;
          setState({ phase: "ready", bytes });
        } catch (err) {
          if (!cancelled) {
            setState({
              phase: "error",
              message: err instanceof Error ? err.message : String(err),
            });
          }
        }
      })();
      return () => {
        cancelled = true;
      };
    },
  );
  return (
    <>
      {!machine() ? (
        <div class={`${styles.fileViewerStatus().class} error`}>
          <span>No machine selected</span>
        </div>
      ) : viewerState().phase !== "ready" ? null : !confirmed() ? (
        <BigFileWarning
          onCancel={actions().goBack}
          onConfirm={() => setConfirmedFsEntryPath(fsEntry().path)}
          viewerName={pdfViewerName}
        />
      ) : state().phase === "loading" ? (
        <div {...styles.fileViewerStatus()}>
          <span>Loading PDF</span>
        </div>
      ) : state().phase === "error" ? (
        <div class={`${styles.fileViewerStatus().class} error`}>
          <span>{errorMessage()}</span>
        </div>
      ) : (
        <PdfCanvasDocument bytes={readyState()!.bytes} />
      )}
    </>
  );
}
function PdfCanvasDocument(props: { bytes: Uint8Array }) {
  const pagesRef = { current: null as (HTMLDivElement | null) | null };
  const [state, setState] = createSignal<PdfRenderState>({ phase: "idle" });
  const renderingState = createMemo(() => {
    const value = state();
    return value.phase === "rendering" ? value : undefined;
  });
  const errorMessage = createMemo(() => {
    const value = state();
    return value.phase === "error" ? value.message : "";
  });
  createEffect(
    () => props.bytes,
    (currentBytes) => {
      let cancelled = false;
      let renderTask:
        | {
            cancel: () => void;
            promise: Promise<unknown>;
          }
        | undefined;
      const loadingTask = pdfjs.getDocument({ data: currentBytes.slice() });
      pagesRef.current?.replaceChildren();
      setState({ phase: "rendering", renderedPages: 0 });
      void (async () => {
        try {
          const pdfDocument = await loadingTask.promise;
          if (cancelled) {
            await pdfDocument.destroy();
            return;
          }
          const pageCount = pdfDocument.numPages;
          setState({
            phase: "rendering",
            pageCount,
            renderedPages: 0,
          });
          for (let pageNumber = 1; pageNumber <= pageCount; pageNumber++) {
            if (cancelled) break;
            const page = await pdfDocument.getPage(pageNumber);
            if (cancelled) break;
            const host = pagesRef.current;
            if (!host) break;
            const cssViewport = page.getViewport({ scale: pageCssScale });
            const pixelRatio = Math.min(
              maxRenderPixelRatio,
              globalThis.devicePixelRatio || 1,
            );
            const renderViewport = page.getViewport({
              scale: pageCssScale * pixelRatio,
            });
            const canvas = document.createElement("canvas");
            canvas.className = styles.pdfPageCanvas().class;
            canvas.width = Math.floor(renderViewport.width);
            canvas.height = Math.floor(renderViewport.height);
            canvas.style.width = `${Math.floor(renderViewport.width / pixelRatio)}px`;
            const pageShell = document.createElement("div");
            pageShell.className = styles.pdfPageShell().class;
            pageShell.style.width = `${Math.floor(cssViewport.width)}px`;
            pageShell.append(canvas);
            host.append(pageShell);
            renderTask = page.render({ canvas, viewport: renderViewport });
            await renderTask.promise;
            page.cleanup();
            if (cancelled) break;
            setState({
              phase: "rendering",
              pageCount,
              renderedPages: pageNumber,
            });
          }
          await pdfDocument.destroy();
          if (!cancelled) {
            setState({ phase: "ready", pageCount });
          }
        } catch (err) {
          if (!cancelled) {
            setState({
              phase: "error",
              message: err instanceof Error ? err.message : String(err),
            });
          }
        }
      })();
      return () => {
        cancelled = true;
        renderTask?.cancel();
        void loadingTask.destroy();
        pagesRef.current?.replaceChildren();
      };
    },
  );
  return (
    <section {...styles.pdfViewer()}>
      <div {...styles.pdfPages()}>
        {state().phase === "rendering" ? (
          <PdfRenderStatus
            pageCount={renderingState()?.pageCount}
            renderedPages={renderingState()!.renderedPages}
          />
        ) : state().phase === "error" ? (
          <div class={`${styles.fileViewerStatus().class} error`}>
            <span>{errorMessage()}</span>
          </div>
        ) : null}
        <div ref={(element) => (pagesRef.current = element)} />
      </div>
    </section>
  );
}
function PdfRenderStatus(props: { pageCount?: number; renderedPages: number }) {
  return (
    <div {...styles.div()}>
      {props.pageCount === undefined
        ? "Opening PDF"
        : `Rendering ${props.renderedPages}/${props.pageCount} pages`}
    </div>
  );
}
function hasCompleteInitialBytes(
  fsEntry: FsEntry,
  initialBytes: Uint8Array,
): boolean {
  return fsEntry.size !== undefined && fsEntry.size <= initialBytes.byteLength;
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
  export const pdfViewer = style({
    gridTemplateRows: "minmax(0,1fr)",
    display: "grid",
    minHeight: "0",
    minWidth: "0",
    overflow: "hidden",
    backgroundColor: "rgb(238 241 245 / 1)",
  });
  export const pdfPages = style({
    scrollbarGutter: "stable",
    selectors: {
      "& canvas": {
        display: "block",
        height: "auto",
        maxWidth: "100%",
      },
    },
    minHeight: "0",
    minWidth: "0",
    overflowX: "auto",
    overflowY: "scroll",
    paddingLeft: "18px",
    paddingRight: "18px",
    paddingTop: "18px",
    paddingBottom: "18px",
  });
  export const pdfPageShell = style({
    marginLeft: "auto",
    marginRight: "auto",
    marginBottom: "18px",
    selectors: {
      "&:last-child": {
        marginBottom: "0",
      },
    },
    maxWidth: "100%",
    display: "flex",
    justifyContent: "center",
  });
  export const pdfPageCanvas = style({
    boxShadow: "0 2px 14px rgb(32 36 45 / 18%)",
    backgroundColor: "rgb(255 255 255 / 1)",
  });
  export const div = style({
    marginBottom: "14px",
    display: "flex",
    justifyContent: "center",
    fontSize: "14px",
    color: "rgb(102 112 133 / 1)",
  });
}
