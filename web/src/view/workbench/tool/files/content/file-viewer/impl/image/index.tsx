import { style } from "../../../../../../../../zyzz.config.ts";
import { createMemo, createSignal, createEffect, useContext } from "solid-js";
import { useBunja } from "bunja/solid";

import {
  ImageOff,
  Maximize2,
  Minus,
  Plus,
  RotateCcw,
} from "../../../../../../../../solid/icons.tsx";
import type { FsEntry } from "../../../../../../../../protocol/generated/rpc.ts";
import { readFileBytes } from "../../read-file-bytes.ts";
import {
  FilesActionsContext,
  requireFilesActions,
} from "../../../../context.tsx";
import { className } from "../../../../../../../class-name.ts";
import { Button } from "../../../../../../../ui/button.tsx";
import { BigFileWarning } from "../../big-file-warning.tsx";
import { fileViewerBunja } from "../../state.tsx";
const inlineOpenLimitBytes = 10 * 1024 * 1024;
const minZoom = 0.1;
const maxZoom = 8;
const zoomFactor = 1.2;
const wheelZoomSensitivity = 0.002;
const zoomComparisonTolerance = 0.001;

type ImageReadState =
  | {
      phase: "loading";
    }
  | {
      phase: "ready";
      objectUrl: string;
    }
  | {
      phase: "error";
      message: string;
    };
type ImageDisplayState =
  | {
      phase: "loading";
    }
  | {
      height: number;
      phase: "ready";
      width: number;
    }
  | {
      phase: "error";
    };
interface ImagePanState {
  pointerId: number;
  scrollLeft: number;
  scrollTop: number;
  x: number;
  y: number;
}
interface ImageZoomAnchor {
  clientX: number;
  clientY: number;
  xRatio: number;
  yRatio: number;
}
const imageViewerName = "image viewer";
export default function ImageFileViewer() {
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
  const [state, setState] = createSignal<ImageReadState>({ phase: "loading" });
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
      let objectUrl: string | undefined;
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
          const blob = new Blob([new Uint8Array(bytes)], {
            type: imageMimeType(currentFsEntry.path, bytes),
          });
          objectUrl = URL.createObjectURL(blob);
          setState({ phase: "ready", objectUrl });
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
        if (objectUrl) URL.revokeObjectURL(objectUrl);
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
          viewerName={imageViewerName}
        />
      ) : state().phase === "loading" ? (
        <div {...styles.fileViewerStatus()}>
          <span>Loading image</span>
        </div>
      ) : state().phase === "error" ? (
        <div class={`${styles.fileViewerStatus().class} error`}>
          <span>{errorMessage()}</span>
        </div>
      ) : (
        <ImageCanvas objectUrl={readyState()!.objectUrl} />
      )}
    </>
  );
}
function ImageCanvas(props: { objectUrl: string }) {
  const stageRef = { current: null as (HTMLDivElement | null) | null };
  const imageRef = { current: null as (HTMLImageElement | null) | null };
  const panStateRef = { current: undefined as ImagePanState | undefined };
  const pendingZoomAnchorRef = {
    current: undefined as ImageZoomAnchor | undefined,
  };
  const [displayState, setDisplayState] = createSignal<ImageDisplayState>({
    phase: "loading",
  });
  const [fitToView, setFitToView] = createSignal(true);
  const [panning, setPanning] = createSignal(false);
  const [zoom, setZoom] = createSignal(1);
  createEffect(
    () => props.objectUrl,
    () => {
      setDisplayState({ phase: "loading" });
      setFitToView(true);
      setPanning(false);
      panStateRef.current = undefined;
      pendingZoomAnchorRef.current = undefined;
      setZoom(1);
    },
  );
  createEffect(
    () => ({
      displayState: displayState(),
      fitToView: fitToView(),
      zoom: zoom(),
    }),
    () => {
      const stage = stageRef.current;
      const image = imageRef.current;
      const anchor = pendingZoomAnchorRef.current;
      if (!stage || !image || !anchor) return;
      pendingZoomAnchorRef.current = undefined;
      const rect = image.getBoundingClientRect();
      stage.scrollLeft +=
        rect.left + rect.width * anchor.xRatio - anchor.clientX;
      stage.scrollTop +=
        rect.top + rect.height * anchor.yRatio - anchor.clientY;
    },
  );
  createEffect(
    () => ({
      displayState: displayState(),
      fitToView: fitToView(),
      zoom: zoom(),
    }),
    ({
      displayState: currentDisplayState,
      fitToView: currentFitToView,
      zoom: currentZoom,
    }) => {
      const stage = stageRef.current;
      if (!stage) return;
      function handleWheel(event: WheelEvent) {
        if (currentDisplayState.phase !== "ready") return;
        if (!event.ctrlKey) return;
        if (event.deltaY === 0) return;
        event.preventDefault();
        const baseZoom = currentFitToView
          ? currentRenderedZoom(imageRef.current)
          : currentZoom;
        const nextZoom = clampZoom(
          baseZoom * Math.exp(-event.deltaY * wheelZoomSensitivity),
        );
        const anchor = imageZoomAnchorAtClientPoint(
          imageRef.current,
          event.clientX,
          event.clientY,
        );
        pendingZoomAnchorRef.current = anchor;
        setFitToView(false);
        setZoom(nextZoom);
      }
      stage.addEventListener("wheel", handleWheel, { passive: false });
      return () => stage.removeEventListener("wheel", handleWheel);
    },
  );
  const canZoomOut = createMemo(() => fitToView() || zoom() > minZoom);
  const canZoomIn = createMemo(() => fitToView() || zoom() < maxZoom);
  const fitZoom = createMemo(() =>
    currentFitZoom(stageRef.current, displayState()),
  );
  const canPan = createMemo(
    () => !fitToView() && zoom() > fitZoom() + zoomComparisonTolerance,
  );
  const dimensions = createMemo(() => {
    const value = displayState();
    return value.phase === "ready"
      ? `${value.width} x ${value.height}`
      : value.phase === "error"
        ? "Unable to preview image"
        : "Opening image";
  });
  return (
    <section {...styles.imageViewer()}>
      <div {...styles.imageToolbar()}>
        <div {...styles.imageToolbarGroup()}>
          <Button
            aria-label="Fit image to view"
            className={styles.imageToolbarButton().class}
            title="Fit image to view"
            onClick={() => setFitToView(true)}
          >
            <Maximize2 size={16} />
          </Button>
          <Button
            aria-label="Actual size"
            className={styles.imageToolbarButton().class}
            title="Actual size"
            onClick={() => {
              setFitToView(false);
              setZoom(1);
            }}
          >
            <RotateCcw size={16} />
          </Button>
          <div {...styles.imageZoomButtonGroup()}>
            <Button
              aria-label="Zoom out"
              className={styles.imageZoomButton().class}
              title="Zoom out"
              disabled={!canZoomOut()}
              onClick={() => {
                const baseZoom = fitToView()
                  ? currentRenderedZoom(imageRef.current)
                  : zoom();
                setFitToView(false);
                setZoom(clampZoom(baseZoom / zoomFactor));
              }}
            >
              <Minus size={16} />
            </Button>
            <Button
              aria-label="Zoom in"
              className={styles.imageZoomButton().class}
              title="Zoom in"
              disabled={!canZoomIn()}
              onClick={() => {
                const baseZoom = fitToView()
                  ? currentRenderedZoom(imageRef.current)
                  : zoom();
                setFitToView(false);
                setZoom(clampZoom(baseZoom * zoomFactor));
              }}
            >
              <Plus size={16} />
            </Button>
          </div>
          <span {...styles.span()}>
            {fitToView() ? "Fit" : `${Math.round(zoom() * 100)}%`}
          </span>
        </div>
        <span {...styles.imageMeta()}>{dimensions()}</span>
      </div>
      <div
        ref={(element) => (stageRef.current = element)}
        class={className(
          styles.imageStage().class,
          canPan() &&
            (panning()
              ? styles.imageStagePanning().class
              : styles.imageStagePannable().class),
        )}
        onPointerDown={(event) => {
          if (!canPan() || event.button !== 0) return;
          const stage = stageRef.current;
          if (!stage) return;
          event.preventDefault();
          stage.setPointerCapture(event.pointerId);
          panStateRef.current = {
            pointerId: event.pointerId,
            scrollLeft: stage.scrollLeft,
            scrollTop: stage.scrollTop,
            x: event.clientX,
            y: event.clientY,
          };
          setPanning(true);
        }}
        onPointerMove={(event) => {
          const stage = stageRef.current;
          const panState = panStateRef.current;
          if (!stage || !panState || panState.pointerId !== event.pointerId) {
            return;
          }
          event.preventDefault();
          stage.scrollLeft = panState.scrollLeft - (event.clientX - panState.x);
          stage.scrollTop = panState.scrollTop - (event.clientY - panState.y);
        }}
        onPointerUp={(event) => {
          endImagePan(stageRef.current, panStateRef, event.pointerId);
          setPanning(false);
        }}
        onPointerCancel={(event) => {
          endImagePan(stageRef.current, panStateRef, event.pointerId);
          setPanning(false);
        }}
      >
        {displayState().phase === "error" ? (
          <div class={`${styles.fileViewerStatus().class} error`}>
            <ImageOff size={18} />
            <span>Unable to preview image</span>
          </div>
        ) : null}
        {displayState().phase === "error" ? null : (
          <div
            class={
              fitToView()
                ? styles.fitImageStageContent().class
                : styles.imageStageContent().class
            }
          >
            <img
              ref={(element) => (imageRef.current = element)}
              src={props.objectUrl}
              alt=""
              draggable={false}
              class={
                fitToView()
                  ? styles.fitImageElement().class
                  : styles.imageElement().class
              }
              style={imageStyle(fitToView(), zoom(), displayState())}
              onLoad={(event) => {
                setDisplayState({
                  height: event.currentTarget.naturalHeight,
                  phase: "ready",
                  width: event.currentTarget.naturalWidth,
                });
              }}
              onError={() => setDisplayState({ phase: "error" })}
            />
          </div>
        )}
      </div>
    </section>
  );
}
function hasCompleteInitialBytes(
  fsEntry: FsEntry,
  initialBytes: Uint8Array,
): boolean {
  return fsEntry.size !== undefined && fsEntry.size <= initialBytes.byteLength;
}
function imageMimeType(path: string, bytes: Uint8Array): string {
  switch (fileExtension(path)) {
    case "avif":
      return "image/avif";
    case "bmp":
      return "image/bmp";
    case "gif":
      return "image/gif";
    case "ico":
      return "image/x-icon";
    case "jpeg":
    case "jpg":
      return "image/jpeg";
    case "png":
      return "image/png";
    case "svg":
      return "image/svg+xml";
    case "webp":
      return "image/webp";
    default:
      return imageMimeTypeFromBytes(bytes) ?? "application/octet-stream";
  }
}
function imageMimeTypeFromBytes(bytes: Uint8Array): string | undefined {
  if (startsWith(bytes, [0x89, 0x50, 0x4e, 0x47])) return "image/png";
  if (startsWith(bytes, [0xff, 0xd8, 0xff])) return "image/jpeg";
  if (startsWithAscii(bytes, "GIF87a") || startsWithAscii(bytes, "GIF89a")) {
    return "image/gif";
  }
  if (startsWithAscii(bytes, "BM")) return "image/bmp";
  if (startsWith(bytes, [0x00, 0x00, 0x01, 0x00])) return "image/x-icon";
  if (
    bytes.length >= 12 &&
    startsWithAscii(bytes, "RIFF") &&
    startsWithAscii(bytes.subarray(8), "WEBP")
  ) {
    return "image/webp";
  }
  if (bytes.length >= 12 && startsWithAscii(bytes.subarray(4), "ftypavif")) {
    return "image/avif";
  }
  return undefined;
}
function fileExtension(path: string): string | undefined {
  const basename = path.slice(
    Math.max(path.lastIndexOf("/"), path.lastIndexOf("\\")) + 1,
  );
  const dotIndex = basename.lastIndexOf(".");
  if (dotIndex <= 0 || dotIndex === basename.length - 1) return undefined;
  return basename.slice(dotIndex + 1).toLowerCase();
}
function clampZoom(zoom: number): number {
  return Math.min(maxZoom, Math.max(minZoom, zoom));
}
function currentFitZoom(
  stage: HTMLDivElement | null,
  displayState: ImageDisplayState,
): number {
  if (!stage || displayState.phase !== "ready") return 1;
  const style = getComputedStyle(stage);
  const availableWidth =
    stage.clientWidth -
    cssPixelValue(style.paddingLeft) -
    cssPixelValue(style.paddingRight);
  const availableHeight =
    stage.clientHeight -
    cssPixelValue(style.paddingTop) -
    cssPixelValue(style.paddingBottom);
  if (availableWidth <= 0 || availableHeight <= 0) return 1;
  return Math.min(
    1,
    availableWidth / displayState.width,
    availableHeight / displayState.height,
  );
}
function currentRenderedZoom(image: HTMLImageElement | null): number {
  if (!image || image.naturalWidth <= 0) return 1;
  return image.getBoundingClientRect().width / image.naturalWidth;
}
function imageZoomAnchorAtClientPoint(
  image: HTMLImageElement | null,
  clientX: number,
  clientY: number,
): ImageZoomAnchor | undefined {
  if (!image) return undefined;
  const rect = image.getBoundingClientRect();
  if (
    rect.width <= 0 ||
    rect.height <= 0 ||
    clientX < rect.left ||
    clientX > rect.right ||
    clientY < rect.top ||
    clientY > rect.bottom
  ) {
    return undefined;
  }
  return {
    clientX,
    clientY,
    xRatio: (clientX - rect.left) / rect.width,
    yRatio: (clientY - rect.top) / rect.height,
  };
}
function cssPixelValue(value: string): number {
  const parsed = Number.parseFloat(value);
  return Number.isFinite(parsed) ? parsed : 0;
}
function endImagePan(
  stage: HTMLDivElement | null,
  panStateRef: {
    current: ImagePanState | undefined;
  },
  pointerId: number,
) {
  const panState = panStateRef.current;
  if (!panState || panState.pointerId !== pointerId) return;
  if (stage?.hasPointerCapture(pointerId)) {
    stage.releasePointerCapture(pointerId);
  }
  panStateRef.current = undefined;
}
function startsWith(bytes: Uint8Array, prefix: number[]): boolean {
  if (bytes.length < prefix.length) return false;
  return prefix.every((byte, index) => bytes[index] === byte);
}
function startsWithAscii(bytes: Uint8Array, prefix: string): boolean {
  if (bytes.length < prefix.length) return false;
  for (let index = 0; index < prefix.length; index++) {
    if (bytes[index] !== prefix.charCodeAt(index)) return false;
  }
  return true;
}
function imageStyle(
  fitToView: boolean,
  zoom: number,
  displayState: ImageDisplayState,
):
  | {
      width: string;
    }
  | undefined {
  if (fitToView || displayState.phase !== "ready") return undefined;
  return { width: `${Math.max(1, Math.round(displayState.width * zoom))}px` };
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
  export const imageViewer = style({
    gridTemplateRows: "auto minmax(0,1fr)",
    display: "grid",
    minHeight: "0",
    minWidth: "0",
    overflow: "hidden",
    backgroundColor: "rgb(238 241 245 / 1)",
  });
  export const imageToolbar = style({
    minHeight: "38px",
    minWidth: "0",
    display: "flex",
    alignItems: "center",
    justifyContent: "space-between",
    gap: "12px",
    borderBottomWidth: "1px",
    borderBottomColor: "rgb(216 221 231 / 1)",
    backgroundColor: "rgb(251 252 254 / 1)",
    paddingLeft: "8px",
    paddingRight: "8px",
  });
  export const imageToolbarGroup = style({
    minWidth: "0",
    display: "flex",
    alignItems: "center",
    gap: "6px",
  });
  export const imageToolbarButton = style({
    height: "28px",
    minHeight: "28px",
    width: "28px",
    borderRadius: "4px",
    paddingLeft: "0",
    paddingRight: "0",
  });
  export const imageZoomButtonGroup = style({
    boxSizing: "border-box",
    height: "28px",
    display: "inline-flex",
    alignItems: "center",
    gap: "4px",
  });
  export const imageZoomButton = style({
    boxSizing: "border-box !important",
    height: "100% !important",
    minHeight: "0 !important",
    minWidth: "28px !important",
    width: "28px !important",
    borderRadius: "4px !important",
    padding: "0 !important",
  });
  export const imageMeta = style({
    minWidth: "0",
    overflow: "hidden",
    textOverflow: "ellipsis",
    whiteSpace: "nowrap",
    fontSize: "14px",
    color: "rgb(102 112 133 / 1)",
  });
  export const imageStage = style({
    scrollbarGutter: "stable",
    minHeight: "0",
    minWidth: "0",
    WebkitUserSelect: "none",
    userSelect: "none",
    overflow: "auto",
    padding: "18px",
  });
  export const imageStageContent = style({
    height: "max-content",
    width: "max-content",
    display: "grid",
    minHeight: "100%",
    minWidth: "100%",
    placeItems: "center",
  });
  export const fitImageStageContent = style({
    display: "grid",
    height: "100%",
    width: "100%",
    placeItems: "center",
  });
  export const imageStagePannable = style({
    cursor: "grab",
  });
  export const imageStagePanning = style({
    cursor: "grabbing",
  });
  export const imageElement = style({
    boxShadow: "0 2px 14px rgb(32 36 45 / 18%)",
    display: "block",
    height: "auto",
    maxWidth: "none",
  });
  export const fitImageElement = style({
    boxShadow: "0 2px 14px rgb(32 36 45 / 18%)",
    display: "block",
    maxHeight: "100%",
    maxWidth: "100%",
    objectFit: "contain",
  });
  export const span = style({
    minWidth: "48px",
    textAlign: "center",
    fontSize: "14px",
    color: "rgb(102 112 133 / 1)",
  });
}
