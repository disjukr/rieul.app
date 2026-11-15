import { global } from "zyzz/web";
import { style, theme } from "../../../../zyzz.config.ts";
import { Button } from "../../../ui/button.tsx";
import { For, createEffect, createMemo, createSignal, untrack } from "solid-js";
import { desktopContentRect } from "../../../../protocol/desktop-input.ts";
import { desktopCursorPng } from "../../../../protocol/desktop-cursor.ts";
import { useBunja } from "bunja/solid";
import { managedDesktopBunja } from "../../../../state/desktop.ts";
import { DesktopDisplayIdContext } from "../../../../state/desktop-context.ts";
import {
  DesktopQualityVerification,
  type DesktopTrack,
  type DesktopDisplay,
} from "../../../../protocol/generated/rpc.ts";

export function DesktopTool(props: { active?: boolean } = {}) {
  const [selected, setSelected] = createSignal<string>();
  return (
    <>
      {props.active !== false &&
        (selected() ? (
          <DesktopDisplayIdContext value={selected}>
            <DesktopSelectedView onBack={() => setSelected(undefined)} />
          </DesktopDisplayIdContext>
        ) : (
          <DesktopDisplayIdContext value={undefined}>
            <DesktopCatalogView onSelect={setSelected} />
          </DesktopDisplayIdContext>
        ))}
    </>
  );
}
function DesktopSelectedView(props: { onBack: () => void }) {
  const desktop = useBunja(managedDesktopBunja);
  const viewer = Symbol("Screen viewer");
  const [fps, setFps] = createSignal(60);
  const [mbps, setMbps] = createSignal(20);
  createEffect(
    createMemo(() => desktop()),
    (model) => model.registerViewer(viewer),
  );
  createEffect(
    createMemo(() => ({
      phase: desktop().phase(),
      selected: desktop().selectedDisplayId(),
    })),
    ({ phase, selected }) => {
      if (phase === "viewing" && !selected) props.onBack();
    },
  );
  return (
    <section
      {...styles.root({ className: "rieul-desktop" })}
      data-phase={desktop().phase()}
      data-controlling={desktop().controlling()}
      aria-label="Screen"
    >
      <header {...styles.toolbar({ className: "rieul-desktop-toolbar" })}>
        <Button
          size="sm"
          aria-label="Back to displays"
          title="Back to displays"
          onClick={() => props.onBack()}
        >
          Back
        </Button>
        {desktop().controlling() && desktop().ownsInput(viewer) ? (
          <Button
            size="sm"
            disabled={desktop().busy()}
            onClick={() => void desktop().release()}
          >
            Release control
          </Button>
        ) : (
          <Button
            size="sm"
            disabled={
              !desktop().inputReady() ||
              desktop().busy() ||
              desktop().phase() !== "viewing"
            }
            aria-label={
              !desktop().controlling() && desktop().control().holderAttachId
                ? "Take control from another viewer"
                : undefined
            }
            title={
              !desktop().controlling() && desktop().control().holderAttachId
                ? "Take control from another viewer and release their held inputs"
                : "Enable keyboard and pointer input in this view"
            }
            onClick={() =>
              void (desktop().controlling() ||
              !desktop().control().holderAttachId
                ? desktop().acquire(viewer)
                : desktop().takeover(viewer))
            }
          >
            {desktop().controlling()
              ? "Control here"
              : desktop().control().holderAttachId
                ? "Take control"
                : "Control screen"}
          </Button>
        )}
        <details name="screen-toolbar-panel" {...styles.toolbarDisclosure()}>
          <summary title="Connection status" aria-label="Connection status">
            {desktop().phase() === "error" || desktop().message()
              ? "Status !"
              : "Status"}
          </summary>
          <div {...styles.toolbarPanel()}>
            <p
              {...styles.status({ className: "rieul-desktop-status" })}
              role="status"
            >
              {desktop().message() ??
                desktop().availabilityMessage() ??
                (desktop().phase() === "connecting"
                  ? "Connecting to display…"
                  : desktop().controlling()
                    ? desktop().ownsInput(viewer)
                      ? "You control this screen."
                      : "This display is controlled in another pane. Choose Control here to move input."
                    : !desktop().inputReady()
                      ? "Viewing only. Control is unavailable."
                      : desktop().control().holderAttachId
                        ? "Another viewer controls this screen. Taking control will release their held inputs."
                        : "Viewing only. Choose Control screen to use the keyboard and pointer.")}
            </p>
          </div>
        </details>
        <details name="screen-toolbar-panel" {...styles.toolbarDisclosure()}>
          <summary title="Screen options" aria-label="Screen options">
            Options
          </summary>
          <div {...styles.toolbarPanel()}>
            <p {...styles.help({ className: "rieul-desktop-input-help" })}>
              Keyboard input uses physical keys. IME and OS-reserved shortcuts
              are unavailable. Ctrl+Alt+Escape leaves screen keyboard focus.
            </p>
            {!desktop().qualitySupported() && (
              <p {...styles.help()}>
                Automatic video quality is not available for individual displays
                on this daemon.
              </p>
            )}
            {!desktop().serverOwnsGeometry() && (
              <label {...styles.help()}>
                Maximum video size
                <select
                  {...styles.select()}
                  aria-label="Maximum video size"
                  value={desktop().outputHeight()}
                  disabled={
                    desktop().busy() || desktop().phase() === "connecting"
                  }
                  onChange={(event) =>
                    void desktop().resize(Number(event.currentTarget.value))
                  }
                >
                  <option value="720">1280 × 720</option>
                  <option value="1080">1920 × 1080</option>
                  <option value="2160">3840 × 2160</option>
                </select>{" "}
                Video size only; OS display resolution is unchanged. Changing
                size releases held inputs.
              </label>
            )}
            {desktop().qualitySupported() &&
              desktop().phase() === "viewing" &&
              !!desktop().configuration()?.tracks.length && (
                <fieldset {...styles.help()}>
                  <legend>Video quality</legend>
                  <p>
                    Current target:{" "}
                    {desktop().configuration()?.tracks[0]?.viewport.fps} FPS,{" "}
                    {(desktop().configuration()?.totalBitrate ?? 0) / 1_000_000}{" "}
                    Mbps shared. Mode:{" "}
                    {desktop().qualityPolicy()?.type === "auto"
                      ? "Auto"
                      : "Manual"}
                    .
                  </p>
                  <label>
                    Target FPS{" "}
                    <input
                      {...styles.select()}
                      type="number"
                      min="1"
                      max="120"
                      value={fps()}
                      onInput={(e) => setFps(Number(e.currentTarget.value))}
                    />
                  </label>{" "}
                  <label>
                    Shared bitrate target (Mbps){" "}
                    <input
                      {...styles.select()}
                      type="number"
                      min="0.1"
                      max="100"
                      step="0.1"
                      value={mbps()}
                      onInput={(e) => setMbps(Number(e.currentTarget.value))}
                    />
                  </label>{" "}
                  <Button
                    size="sm"
                    disabled={
                      desktop().qualityBusy() ||
                      !Number.isInteger(fps()) ||
                      fps() < 1 ||
                      fps() > 120 ||
                      !Number.isFinite(mbps()) ||
                      mbps() < 0.1 ||
                      mbps() > 100
                    }
                    onClick={() =>
                      void desktop().queryQuality({
                        fps: fps(),
                        totalBitrate: Math.round(mbps() * 1_000_000),
                      })
                    }
                  >
                    Check quality support
                  </Button>
                  <p>
                    Targets are not guaranteed performance. Choose an available
                    target below to apply it.
                  </p>
                  {desktop().qualitySupport() && (
                    <div>
                      <Button
                        size="sm"
                        disabled={
                          desktop().qualityBusy() ||
                          !desktop().qualitySupport()?.automaticAvailable
                        }
                        onClick={() =>
                          void desktop().applyQuality({ type: "auto" })
                        }
                      >
                        Use Auto
                      </Button>
                      <For each={desktop().qualitySupport()?.candidates}>
                        {(candidate) => (
                          <div>
                            <span>
                              {candidate.target.fps} FPS ·{" "}
                              {candidate.target.totalBitrate / 1_000_000} Mbps —{" "}
                              {candidate.verification ===
                              DesktopQualityVerification.Verified
                                ? "Available"
                                : candidate.verification ===
                                    DesktopQualityVerification.Unsupported
                                  ? "Unavailable"
                                  : "Not yet verified"}
                              .
                            </span>{" "}
                            <Button
                              size="sm"
                              disabled={
                                desktop().qualityBusy() ||
                                candidate.verification !==
                                  DesktopQualityVerification.Verified
                              }
                              onClick={() =>
                                void desktop().applyQuality({
                                  type: "manual",
                                  target: candidate.target,
                                })
                              }
                            >
                              Use {candidate.target.fps} FPS /{" "}
                              {candidate.target.totalBitrate / 1_000_000} Mbps
                            </Button>
                          </div>
                        )}
                      </For>
                    </div>
                  )}
                  <p role="status">
                    {desktop().qualityBusy()
                      ? "Checking or applying quality…"
                      : desktop().qualityMessage()}
                  </p>
                </fieldset>
              )}
            {desktop().phase() === "viewing" &&
              !desktop().displays().length && (
                <p {...styles.help()}>The daemon has no active displays.</p>
              )}
            <details {...styles.diagnostics()}>
              <summary>Diagnostics</summary>
              <p {...styles.help()}>
                Existing displays: uses the daemon’s current OS display
                configuration.
                {desktop().modes().custom
                  ? " Custom layout is advertised by this daemon; this client does not yet configure it."
                  : " Custom layout is not offered by this daemon."}
              </p>
              <For each={desktop().configuration()?.tracks}>
                {(track) => (
                  <p {...styles.help()}>
                    Display {track.viewport.displayId}: {track.viewport.width} ×{" "}
                    {track.viewport.height} · {track.codec.codec}
                  </p>
                )}
              </For>
              {desktop().qualitySupported() && (
                <p {...styles.help()}>
                  Auto quality uses measured delivery delays and receiver queue
                  feedback within verified combinations.
                </p>
              )}
              <For each={desktop().qualitySupport()?.candidates}>
                {(candidate) => (
                  <p {...styles.help()}>
                    {candidate.target.fps} FPS ·{" "}
                    {candidate.target.totalBitrate / 1_000_000} Mbps.{" "}
                    {candidate.reason}
                  </p>
                )}
              </For>
              {desktop().stats() && (
                <output
                  {...styles.metrics({ className: "rieul-desktop-metrics" })}
                  aria-label="Screen decoder status"
                >
                  {desktop().stats()!.requestKeyframe
                    ? "Recovering at the next keyframe"
                    : `Decoder queue: ${desktop().stats()!.queueDepth}`}
                </output>
              )}
            </details>{" "}
          </div>
        </details>
      </header>
      <div {...styles.viewports({ className: "rieul-desktop-viewports" })}>
        <For
          each={desktop()
            .configuration()
            ?.tracks.filter(
              (t) => t.viewport.displayId === desktop().selectedDisplayId(),
            )
            .map((t) => t.viewport.viewportId)}
        >
          {(id) => (
            <DesktopSurface
              viewer={viewer}
              track={
                desktop()
                  .configuration()!
                  .tracks.find((t) => t.viewport.viewportId === id)!
              }
            />
          )}
        </For>
      </div>
    </section>
  );
}
function DesktopCatalogView(props: { onSelect: (displayId: string) => void }) {
  const desktop = useBunja(managedDesktopBunja);
  return (
    <section
      {...styles.root({ className: "rieul-desktop" })}
      data-phase={desktop().phase()}
      data-controlling={desktop().controlling()}
      aria-label="Screen"
    >
      {(desktop().message() ||
        desktop().availabilityMessage() ||
        desktop().phase() !== "viewing" ||
        !desktop().displays().length) && (
        <header {...styles.toolbar()}>
          <details name="screen-toolbar-panel" {...styles.toolbarDisclosure()}>
            <summary aria-label="Connection status">
              {desktop().phase() === "connecting"
                ? "Connecting…"
                : desktop().phase() === "viewing" &&
                    !desktop().displays().length
                  ? "No displays"
                  : "Status !"}
            </summary>
            <div {...styles.toolbarPanel()}>
              <p role="status">
                {desktop().message() ??
                  desktop().availabilityMessage() ??
                  (desktop().phase() === "viewing"
                    ? "No displays are available."
                    : "Connecting to displays…")}
              </p>
            </div>
          </details>
        </header>
      )}
      <nav {...styles.catalog()} aria-label="Displays">
        <For each={desktop().displays()}>
          {(display) => (
            <button
              type="button"
              {...styles.previewTile()}
              aria-label={`Display ${display.displayId}`}
              title={`Open display ${display.displayId}`}
              disabled={desktop().phase() !== "viewing"}
              onClick={() => props.onSelect(display.displayId)}
            >
              <DesktopPreview display={display} />
            </button>
          )}
        </For>
      </nav>
    </section>
  );
}
function DesktopPreview(props: { display: DesktopDisplay }) {
  const desktop = useBunja(managedDesktopBunja);
  const [canvas, setCanvas] = createSignal<HTMLCanvasElement>();
  createEffect(
    createMemo(() => ({
      canvas: canvas(),
      model: desktop(),
      display: props.display,
    })),
    ({ canvas, model, display }) => {
      if (!canvas) return;
      const scale = Math.min(
        1,
        320 / display.bounds.width,
        180 / display.bounds.height,
      );
      canvas.width = Math.max(
        2,
        Math.floor((display.bounds.width * scale) / 2) * 2,
      );
      canvas.height = Math.max(
        2,
        Math.floor((display.bounds.height * scale) / 2) * 2,
      );
      let stop: (() => void) | undefined;
      let visible = false;
      const sync = () => {
        if (visible && !canvas.ownerDocument.hidden)
          stop ??= model.registerPreviewSurface(display.displayId, canvas);
        else {
          stop?.();
          stop = undefined;
        }
      };
      const observer = new IntersectionObserver(([entry]) => {
        visible = entry.isIntersecting;
        sync();
      });
      observer.observe(canvas);
      canvas.ownerDocument.addEventListener("visibilitychange", sync);
      return () => {
        observer.disconnect();
        canvas.ownerDocument.removeEventListener("visibilitychange", sync);
        stop?.();
      };
    },
  );
  return (
    <>
      <canvas
        ref={setCanvas}
        class="rieul-desktop-preview-canvas"
        aria-hidden="true"
      />
      {!desktop().previewAvailable(props.display.displayId) && (
        <span {...styles.previewPending()}>Preview paused</span>
      )}
    </>
  );
}
function DesktopSurface(props: { track: DesktopTrack; viewer: symbol }) {
  const desktop = useBunja(managedDesktopBunja);
  const [canvas, setCanvas] = createSignal<HTMLCanvasElement>();
  const [canvasSize, setCanvasSize] = createSignal({ width: 0, height: 0 });
  createEffect(
    createMemo(() => canvas()),
    (element) => {
      if (!element) return;
      const observer = new ResizeObserver(([entry]) =>
        setCanvasSize({
          width: entry.contentRect.width,
          height: entry.contentRect.height,
        }),
      );
      observer.observe(element);
      return () => observer.disconnect();
    },
  );
  const contentRect = createMemo(() =>
    desktopContentRect(
      { left: 0, top: 0, ...canvasSize() },
      props.track.viewport.width,
      props.track.viewport.height,
    ),
  );
  const surfaceGeometry = createMemo(() =>
    JSON.stringify([
      props.track.viewport.viewportId,
      props.track.viewport.width,
      props.track.viewport.height,
    ]),
  );
  createEffect(
    createMemo(() => ({
      canvas: canvas(),
      geometry: surfaceGeometry(),
      model: desktop(),
    })),
    ({ canvas, geometry, model }) => {
      if (!canvas) return;
      const [id, width, height] = JSON.parse(geometry) as [
        string,
        number,
        number,
      ];
      canvas.width = width;
      canvas.height = height;
      const cleanup = untrack(() =>
        model.registerSurface(id, canvas, props.viewer),
      );
      return () => untrack(cleanup);
    },
  );
  const [shape, setShape] = createSignal<{
    url: string;
    width: number;
    height: number;
  }>();
  createEffect(
    createMemo(() => desktop().cursor()?.shape),
    (bytes) => {
      if (!bytes) {
        setShape(undefined);
        return;
      }
      const dimensions = desktopCursorPng(bytes);
      if (!dimensions) {
        setShape(undefined);
        return;
      }
      const url = URL.createObjectURL(
        new Blob([new Uint8Array(bytes)], { type: "image/png" }),
      );
      setShape({ url, ...dimensions });
      return () => URL.revokeObjectURL(url);
    },
  );
  const cursor = createMemo(() => {
    const cursor = desktop().cursor(),
      display = desktop()
        .displays()
        .find((d) => d.displayId === props.track.viewport.displayId),
      crop = props.track.viewport.crop;
    if (
      !cursor?.visible ||
      !display ||
      (cursor.displayId !== undefined &&
        cursor.displayId !== display.displayId) ||
      cursor.layoutEpoch !== desktop().configuration()?.layoutEpoch
    )
      return;
    const x = cursor.x - display.bounds.x - crop.x,
      y = cursor.y - display.bounds.y - crop.y;
    if (x < 0 || y < 0 || x >= crop.width || y >= crop.height) return;
    const rect = contentRect();
    if (!rect) return;
    return {
      left: `${rect.left + (x / crop.width) * rect.width}px`,
      top: `${rect.top + (y / crop.height) * rect.height}px`,
    };
  });
  return (
    <article
      {...styles.viewport({ className: "rieul-desktop-viewport" })}
      data-viewport-id={props.track.viewport.viewportId}
    >
      <div {...styles.frame({ className: "rieul-desktop-frame" })}>
        <canvas
          ref={setCanvas}
          class="rieul-desktop-canvas"
          tabindex={0}
          aria-label={`Display ${props.track.viewport.displayId}`}
          aria-description="Physical keys only. Ctrl+Alt+Escape leaves screen keyboard focus."
        />
        <span
          {...styles.cursor({ className: "rieul-desktop-cursor" })}
          data-visible={!!cursor()}
          aria-hidden="true"
          style={{
            display: cursor() ? undefined : "none",
            left: cursor()?.left,
            top: cursor()?.top,
            width: shape()
              ? `${(shape()!.width / props.track.viewport.crop.width) * (contentRect()?.width ?? 0)}px`
              : undefined,
            transform: shape()
              ? `translate(-${((desktop().cursor()?.hotspotX ?? 0) / shape()!.width) * 100}%, -${((desktop().cursor()?.hotspotY ?? 0) / shape()!.height) * 100}%)`
              : undefined,
          }}
        >
          {shape() ? (
            <img src={shape()!.url} alt="" {...styles.cursorImage()} />
          ) : (
            "↖"
          )}
        </span>
      </div>
    </article>
  );
}

namespace styles {
  export const toolbarDisclosure = style({
    fontSize: "12px",
    selectors: { "& > summary": { cursor: "pointer", padding: "6px" } },
  });
  export const toolbarPanel = style({
    position: "absolute",
    top: "100%",
    right: "6px",
    zIndex: 10,
    width: "min(360px, calc(100% - 12px))",
    boxSizing: "border-box",
    maxHeight: "min(320px, calc(100cqh - 100%))",
    overflow: "auto",
    padding: "8px",
    border: "1px solid",
    borderColor: theme.borderLight,
    backgroundColor: theme.bgPrimary,
    boxShadow: "0 6px 20px #0004",
  });
  export const previewPending = style({
    position: "absolute",
    bottom: "6px",
    right: "6px",
    padding: "2px 6px",
    fontSize: "11px",
    backgroundColor: theme.bgPrimary,
    color: theme.textSecondary,
    borderRadius: theme.radiusSm,
    pointerEvents: "none",
  });
  export const previewTile = style({
    position: "relative",
    display: "block",
    padding: "0",
    height: "clamp(90px, 25cqh, 180px)",
    overflow: "hidden",
    backgroundColor: theme.bgInverse,
    border: "1px solid",
    borderColor: theme.borderLight,
    borderRadius: theme.radiusMd,
    cursor: "pointer",
    selectors: {
      "&:focus-visible": {
        outline: "2px solid",
        outlineColor: theme.focus,
        outlineOffset: "2px",
      },
      "&:disabled": { opacity: 0.6, cursor: "default" },
    },
  });
  export const catalog = style({
    display: "grid",
    flex: "1 1 0",
    minHeight: "0",
    overflow: "auto",
    alignContent: "start",
    overflowWrap: "anywhere",
    gridTemplateColumns: "repeat(auto-fit, minmax(min(100%, 220px), 1fr))",
    gap: "12px",
    padding: "12px",
  });
  export const displayMetadata = style({
    display: "block",
    marginLeft: "8px",
    color: theme.textTertiary,
    fontSize: "12px",
  });
  export const diagnostics = style({
    margin: "0 12px 12px",
    fontSize: "12px",
    overflowWrap: "anywhere",
    selectors: {
      "& > summary": { cursor: "pointer", padding: "8px 0" },
      "& > summary:focus-visible": {
        outline: "2px solid currentColor",
        outlineOffset: "2px",
      },
    },
  });
  export const select = style({
    margin: "0 6px",
    padding: "4px 8px",
    border: "1px solid",
    borderColor: theme.borderLight,
    borderRadius: theme.radiusMd,
    backgroundColor: theme.bgPrimary,
    color: theme.textPrimary,
    selectors: {
      "&:disabled": { opacity: 0.6 },
      "&:focus-visible": {
        outline: "2px solid currentColor",
        outlineOffset: "2px",
      },
    },
  });
  export const cursorImage = style({ width: "100%", display: "block" });
  export const root = style({
    containerType: "size",
    display: "flex",
    flexDirection: "column",
    minWidth: "0",
    minHeight: "0",
    height: "100%",
    overflow: "hidden",
    backgroundColor: theme.bgPrimary,
    color: theme.textPrimary,
  });
  export const toolbar = style({
    position: "relative",
    flexShrink: 0,
    display: "flex",
    flexWrap: "wrap",
    alignItems: "center",
    gap: "8px",
    padding: "6px",
    borderBottom: "1px solid",
    borderBottomColor: theme.borderLight,
    backgroundColor: theme.bgHeader,
  });
  export const title = style({
    margin: "0",
    minWidth: "0",
    overflowWrap: "anywhere",
    marginRight: "auto",
    fontSize: "14px",
    fontWeight: 700,
  });
  export const status = style({
    margin: "12px 12px 0",
    fontSize: "12px",
    lineHeight: 1.5,
  });
  export const help = style({
    margin: "6px 12px 12px",
    color: theme.textTertiary,
    fontSize: "12px",
    lineHeight: 1.5,
  });
  export const displays = style({
    display: "flex",
    flexWrap: "wrap",
    gap: "12px",
    margin: "0 12px 12px",
    padding: "8px",
    border: "1px solid",
    borderColor: theme.borderLight,
    borderRadius: theme.radiusMd,
    selectors: { "&:disabled": { opacity: 0.6 } },
  });
  export const displayOption = style({
    display: "inline-flex",
    alignItems: "center",
    gap: "6px",
    fontSize: "12px",
  });
  export const viewports = style({
    display: "flex",
    flex: "1 1 0",
    minWidth: "0",
    minHeight: "0",
    overflow: "hidden",
  });
  export const viewport = style({
    display: "flex",
    flex: "1 1 0",
    minWidth: "0",
    minHeight: "0",
    overflow: "hidden",
  });
  export const viewportToolbar = style({
    display: "flex",
    flexWrap: "wrap",
    alignItems: "center",
    justifyContent: "space-between",
    gap: "8px",
    padding: "8px",
    backgroundColor: theme.bgHeader,
  });
  export const displayTitle = style({
    margin: "0",
    fontSize: "12px",
    fontWeight: 700,
    overflowWrap: "anywhere",
  });
  export const frame = style({
    flex: "1 1 0",
    minWidth: "0",
    minHeight: "0",
    overflow: "hidden",
    position: "relative",
    backgroundColor: theme.bgInverse,
  });
  export const cursor = style({
    position: "absolute",
    pointerEvents: "none",
    color: "white",
    fontSize: "20px",
    lineHeight: 1,
    textShadow: "0 1px 2px black",
    selectors: { '&[data-visible="false"]': { display: "none" } },
  });
  export const metrics = style({
    margin: "0 12px 12px",
    color: theme.textTertiary,
    fontSize: "12px",
  });
}

global({
  ".rieul-desktop-preview-canvas": {
    display: "block",
    width: "100%",
    height: "100%",
    objectFit: "contain",
    pointerEvents: "none",
  },
  ".rieul-desktop-canvas": {
    display: "block",
    width: "100%",
    height: "100%",
    objectFit: "contain",
    maxWidth: "100%",
    outlineOffset: "-2px",
    touchAction: "none",
    backgroundColor: theme.bgInverse,
  },
  ".rieul-desktop-canvas:focus-visible": {
    outline: "2px solid",
    outlineColor: theme.focus,
  },
  ".rieul-desktop-window": {
    margin: 0,
    minHeight: "100dvh",
    padding: "12px",
    backgroundColor: theme.bgPrimary,
    color: theme.textPrimary,
    fontFamily: theme.fontNative,
  },
  ".rieul-desktop-window > p": {
    margin: "0 0 12px",
    color: theme.textTertiary,
    fontSize: "12px",
    lineHeight: 1.5,
  },
});
