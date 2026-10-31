import { createMemo, createSignal, createEffect, useContext } from "solid-js";
import * as pdfjs from "pdfjs-dist";
import { useBunja } from "../../../../../../../../solid/bunja.tsx";
import { useAtomValue } from "../../../../../../../../solid/jotai.tsx";
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
const fileViewerStatusClassName = [
  "flex items-center justify-center gap-[8px] min-w-0 min-h-0",
  "text-[#667085] text-[14px]",
  "[&.error]:items-start [&.error]:justify-start [&.error]:overflow-auto",
  "[&.error]:text-[#b42318] [&.error]:p-[14px]",
].join(" ");
const pdfViewerClassName = [
  "grid [grid-template-rows:minmax(0,1fr)] min-w-0 min-h-0 overflow-hidden",
  "bg-[#eef1f5]",
].join(" ");
const pdfPagesClassName = [
  "min-w-0 min-h-0 overflow-y-scroll overflow-x-auto px-[18px] py-[18px]",
  "[scrollbar-gutter:stable]",
  "[&_canvas]:block [&_canvas]:h-auto [&_canvas]:max-w-full",
].join(" ");
const pdfPageShellClassName = [
  "mx-auto mb-[18px] flex max-w-full justify-center",
  "last:mb-0",
].join(" ");
const pdfPageCanvasClassName = [
  "bg-white [box-shadow:0_2px_14px_rgb(32_36_45_/_18%)]",
].join(" ");
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
  const viewerState = useAtomValue(() => viewer().stateAtom);
  const machine = useAtomValue(() => viewer().machineAtom);
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
        <div class={`${fileViewerStatusClassName} error`}>
          <span>No machine selected</span>
        </div>
      ) : viewerState().phase !== "ready" ? null : !confirmed() ? (
        <BigFileWarning
          onCancel={actions().goBack}
          onConfirm={() => setConfirmedFsEntryPath(fsEntry().path)}
          viewerName={pdfViewerName}
        />
      ) : state().phase === "loading" ? (
        <div class={fileViewerStatusClassName}>
          <span>Loading PDF</span>
        </div>
      ) : state().phase === "error" ? (
        <div class={`${fileViewerStatusClassName} error`}>
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
            canvas.className = pdfPageCanvasClassName;
            canvas.width = Math.floor(renderViewport.width);
            canvas.height = Math.floor(renderViewport.height);
            canvas.style.width = `${Math.floor(renderViewport.width / pixelRatio)}px`;
            const pageShell = document.createElement("div");
            pageShell.className = pdfPageShellClassName;
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
    <section class={pdfViewerClassName}>
      <div class={pdfPagesClassName}>
        {state().phase === "rendering" ? (
          <PdfRenderStatus
            pageCount={renderingState()?.pageCount}
            renderedPages={renderingState()!.renderedPages}
          />
        ) : state().phase === "error" ? (
          <div class={`${fileViewerStatusClassName} error`}>
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
    <div class="mb-[14px] flex justify-center text-[#667085] text-[14px]">
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
