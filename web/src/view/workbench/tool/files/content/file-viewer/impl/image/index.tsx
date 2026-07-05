import {
  useContext,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import { useBunja } from "bunja/react";
import { useAtomValue } from "jotai";
import { ImageOff, Maximize2, Minus, Plus, RotateCcw } from "lucide-react";
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
const fileViewerStatusClassName = [
  "flex items-center justify-center gap-[8px] min-w-0 min-h-0",
  "text-[#667085] text-[13px]",
  "[&.error]:items-start [&.error]:justify-start [&.error]:overflow-auto",
  "[&.error]:text-[#b42318] [&.error]:p-[14px]",
].join(" ");
const imageViewerClassName = [
  "grid [grid-template-rows:auto_minmax(0,1fr)] min-w-0 min-h-0 overflow-hidden",
  "bg-[#eef1f5]",
].join(" ");
const imageToolbarClassName = [
  "flex items-center justify-between gap-[12px] min-w-0 min-h-[38px]",
  "border-b border-b-[#d8dde7] bg-[#fbfcfe] px-[8px]",
].join(" ");
const imageToolbarGroupClassName = "flex items-center gap-[6px] min-w-0";
const imageToolbarButtonClassName =
  "w-[28px] h-[28px] min-h-[28px] rounded-[4px] px-0";
const imageZoomButtonGroupClassName =
  "inline-flex h-[28px] items-center box-border";
const imageZoomButtonClassName =
  "!w-[28px] !min-w-[28px] !h-full !min-h-0 !box-border !p-0";
const imageZoomButtonFirstClassName = "!rounded-l-[4px] !rounded-r-0";
const imageZoomButtonLastClassName = "-ml-px !rounded-l-0 !rounded-r-[4px]";
const imageMetaClassName = [
  "min-w-0 overflow-hidden text-ellipsis whitespace-nowrap",
  "text-[#667085] text-[12px]",
].join(" ");
const imageStageClassName = [
  "min-w-0 min-h-0 overflow-auto p-[18px]",
  "[scrollbar-gutter:stable]",
  "select-none",
].join(" ");
const imageStageContentClassName =
  "grid min-w-full min-h-full [width:max-content] [height:max-content] place-items-center";
const fitImageStageContentClassName = "grid w-full h-full place-items-center";
const imageStagePannableClassName = "cursor-grab";
const imageStagePanningClassName = "cursor-grabbing";
const imageElementClassName = [
  "block h-auto max-w-none",
  "[box-shadow:0_2px_14px_rgb(32_36_45_/_18%)]",
].join(" ");
const fitImageElementClassName = [
  "block max-w-full max-h-full object-contain",
  "[box-shadow:0_2px_14px_rgb(32_36_45_/_18%)]",
].join(" ");

type ImageReadState =
  | { phase: "loading" }
  | { phase: "ready"; objectUrl: string }
  | { phase: "error"; message: string };

type ImageDisplayState =
  | { phase: "loading" }
  | { height: number; phase: "ready"; width: number }
  | { phase: "error" };

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
  const fsEntry = viewer.fsEntry;
  const viewerState = useAtomValue(viewer.stateAtom);
  const machine = useAtomValue(viewer.machineAtom);
  const webTransport = viewer.webTransport;
  const requiresConfirmation = fsEntry.size === undefined ||
    fsEntry.size > inlineOpenLimitBytes;
  const [confirmedFsEntryPath, setConfirmedFsEntryPath] = useState<
    string | undefined
  >();
  const confirmed = !requiresConfirmation ||
    confirmedFsEntryPath === fsEntry.path;
  const [state, setState] = useState<ImageReadState>({ phase: "loading" });

  useEffect(() => {
    if (!confirmed || !machine || viewerState.phase !== "ready") return;

    let cancelled = false;
    let objectUrl: string | undefined;
    setState({ phase: "loading" });
    void (async () => {
      try {
        const bytes = hasCompleteInitialBytes(fsEntry, viewerState.initialBytes)
          ? viewerState.initialBytes
          : await readFileBytes(await webTransport(), fsEntry.path);
        if (cancelled) return;
        const blob = new Blob([new Uint8Array(bytes)], {
          type: imageMimeType(fsEntry.path, bytes),
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
  }, [confirmed, fsEntry, fsEntry.path, machine, webTransport, viewerState]);

  if (!machine) {
    return (
      <div className={`${fileViewerStatusClassName} error`}>
        <span>No machine selected</span>
      </div>
    );
  }

  if (viewerState.phase !== "ready") return null;

  if (!confirmed) {
    return (
      <BigFileWarning
        onCancel={actions.goBack}
        onConfirm={() => setConfirmedFsEntryPath(fsEntry.path)}
        viewerName={imageViewerName}
      />
    );
  }

  if (state.phase === "loading") {
    return (
      <div className={fileViewerStatusClassName}>
        <span>Loading image</span>
      </div>
    );
  }

  if (state.phase === "error") {
    return (
      <div className={`${fileViewerStatusClassName} error`}>
        <span>{state.message}</span>
      </div>
    );
  }

  return <ImageCanvas objectUrl={state.objectUrl} />;
}

function ImageCanvas({ objectUrl }: { objectUrl: string }) {
  const stageRef = useRef<HTMLDivElement | null>(null);
  const imageRef = useRef<HTMLImageElement | null>(null);
  const panStateRef = useRef<ImagePanState | undefined>(undefined);
  const pendingZoomAnchorRef = useRef<ImageZoomAnchor | undefined>(undefined);
  const [displayState, setDisplayState] = useState<ImageDisplayState>({
    phase: "loading",
  });
  const [fitToView, setFitToView] = useState(true);
  const [panning, setPanning] = useState(false);
  const [zoom, setZoom] = useState(1);

  useEffect(() => {
    setDisplayState({ phase: "loading" });
    setFitToView(true);
    setPanning(false);
    panStateRef.current = undefined;
    pendingZoomAnchorRef.current = undefined;
    setZoom(1);
  }, [objectUrl]);

  useLayoutEffect(() => {
    const stage = stageRef.current;
    const image = imageRef.current;
    const anchor = pendingZoomAnchorRef.current;
    if (!stage || !image || !anchor) return;

    pendingZoomAnchorRef.current = undefined;
    const rect = image.getBoundingClientRect();
    stage.scrollLeft += rect.left + rect.width * anchor.xRatio -
      anchor.clientX;
    stage.scrollTop += rect.top + rect.height * anchor.yRatio -
      anchor.clientY;
  }, [displayState, fitToView, zoom]);

  useEffect(() => {
    const stage = stageRef.current;
    if (!stage) return;

    function handleWheel(event: WheelEvent) {
      if (displayState.phase !== "ready") return;
      if (!event.ctrlKey) return;
      if (event.deltaY === 0) return;
      event.preventDefault();
      const baseZoom = fitToView ? currentRenderedZoom(imageRef.current) : zoom;
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
  }, [displayState, fitToView, zoom]);

  const canZoomOut = fitToView || zoom > minZoom;
  const canZoomIn = fitToView || zoom < maxZoom;
  const fitZoom = currentFitZoom(stageRef.current, displayState);
  const canPan = !fitToView && zoom > fitZoom + zoomComparisonTolerance;
  const dimensions = displayState.phase === "ready"
    ? `${displayState.width} x ${displayState.height}`
    : displayState.phase === "error"
    ? "Unable to preview image"
    : "Opening image";

  return (
    <section className={imageViewerClassName}>
      <div className={imageToolbarClassName}>
        <div className={imageToolbarGroupClassName}>
          <Button
            aria-label="Fit image to view"
            className={imageToolbarButtonClassName}
            title="Fit image to view"
            onClick={() => setFitToView(true)}
          >
            <Maximize2 size={16} />
          </Button>
          <Button
            aria-label="Actual size"
            className={imageToolbarButtonClassName}
            title="Actual size"
            onClick={() => {
              setFitToView(false);
              setZoom(1);
            }}
          >
            <RotateCcw size={16} />
          </Button>
          <div className={imageZoomButtonGroupClassName}>
            <Button
              aria-label="Zoom out"
              className={className(
                imageZoomButtonClassName,
                imageZoomButtonFirstClassName,
              )}
              title="Zoom out"
              disabled={!canZoomOut}
              onClick={() => {
                const baseZoom = fitToView
                  ? currentRenderedZoom(imageRef.current)
                  : zoom;
                setFitToView(false);
                setZoom(clampZoom(baseZoom / zoomFactor));
              }}
            >
              <Minus size={16} />
            </Button>
            <Button
              aria-label="Zoom in"
              className={className(
                imageZoomButtonClassName,
                imageZoomButtonLastClassName,
              )}
              title="Zoom in"
              disabled={!canZoomIn}
              onClick={() => {
                const baseZoom = fitToView
                  ? currentRenderedZoom(imageRef.current)
                  : zoom;
                setFitToView(false);
                setZoom(clampZoom(baseZoom * zoomFactor));
              }}
            >
              <Plus size={16} />
            </Button>
          </div>
          <span className="min-w-[48px] text-center text-[#667085] text-[12px]">
            {fitToView ? "Fit" : `${Math.round(zoom * 100)}%`}
          </span>
        </div>
        <span className={imageMetaClassName}>{dimensions}</span>
      </div>
      <div
        ref={stageRef}
        className={className(
          imageStageClassName,
          canPan &&
            (panning
              ? imageStagePanningClassName
              : imageStagePannableClassName),
        )}
        onPointerDown={(event) => {
          if (!canPan || event.button !== 0) return;
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
        {displayState.phase === "error"
          ? (
            <div className={`${fileViewerStatusClassName} error`}>
              <ImageOff size={18} />
              <span>Unable to preview image</span>
            </div>
          )
          : null}
        {displayState.phase === "error" ? null : (
          <div
            className={fitToView
              ? fitImageStageContentClassName
              : imageStageContentClassName}
          >
            <img
              ref={imageRef}
              src={objectUrl}
              alt=""
              draggable={false}
              className={fitToView
                ? fitImageElementClassName
                : imageElementClassName}
              style={imageStyle(fitToView, zoom, displayState)}
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
  const availableWidth = stage.clientWidth -
    cssPixelValue(style.paddingLeft) -
    cssPixelValue(style.paddingRight);
  const availableHeight = stage.clientHeight -
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
    rect.width <= 0 || rect.height <= 0 ||
    clientX < rect.left || clientX > rect.right ||
    clientY < rect.top || clientY > rect.bottom
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
  panStateRef: { current: ImagePanState | undefined },
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
): { width: string } | undefined {
  if (fitToView || displayState.phase !== "ready") return undefined;
  return { width: `${Math.max(1, Math.round(displayState.width * zoom))}px` };
}
