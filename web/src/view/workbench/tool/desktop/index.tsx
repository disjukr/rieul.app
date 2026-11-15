import { global } from "zyzz/web";
import { style, theme } from "../../../../zyzz.config.ts";
import {
  ArrowLeft,
  Activity,
  Wifi,
  RefreshCw,
  Radio,
  Check,
} from "../../../../solid/icons.tsx";
import { Button } from "../../../ui/button.tsx";
import { For, createEffect, createMemo, createSignal, untrack } from "solid-js";
import { desktopContentRect } from "../../../../protocol/desktop-input.ts";
import {
  desktopArrangement,
  fitDesktopArrangement,
} from "../../../../protocol/desktop-arrangement.ts";
import {
  desktopCursorMaxWidth,
  desktopCursorPng,
} from "../../../../protocol/desktop-cursor.ts";
import { useBunja } from "bunja/solid";
import { managedDesktopBunja } from "../../../../state/desktop.ts";
import { DesktopDisplayIdContext } from "../../../../state/desktop-context.ts";
import {
  DesktopQualityVerification,
  type DesktopTrack,
  type DesktopDisplay,
} from "../../../../protocol/generated/rpc.ts";

export function DesktopTool(
  props: {
    active?: boolean;
    displayId?: string;
    onSelectDisplay?: (displayId: string | undefined) => void;
  } = {},
) {
  const [localSelected, setLocalSelected] = createSignal<string>();
  const selected = () =>
    props.onSelectDisplay ? props.displayId : localSelected();
  const setSelected = (displayId: string | undefined) => {
    if (props.onSelectDisplay) props.onSelectDisplay(displayId);
    else setLocalSelected(displayId);
  };
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
  const [candidateIndex, setCandidateIndex] = createSignal(0);
  const candidate = createMemo(
    () => desktop().qualitySupport()?.candidates[candidateIndex()],
  );
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
      <header
        {...styles.toolbar({ className: "rieul-desktop-toolbar" })}
        style={{ "max-height": "45%", overflow: "auto" }}
      >
        <Button
          size="icon"
          aria-label="Back to displays"
          title="Back to displays"
          onClick={() => props.onBack()}
        >
          <ArrowLeft size={16} />
        </Button>
        {desktop().controlling() && desktop().ownsInput(viewer) ? (
          <Button
            size="sm"
            aria-label="Release control"
            title="Release control"
            aria-pressed="true"
            className={styles.activeControl().class}
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
              desktop().controlling()
                ? "Control here"
                : desktop().control().holderAttachId
                  ? "Take control from another viewer"
                  : "Control screen"
            }
            title={
              desktop().message() ??
              desktop().availabilityMessage() ??
              (desktop().controlling()
                ? "Move control to this pane"
                : desktop().control().holderAttachId
                  ? "Take control from another viewer and release their held inputs"
                  : "Enable physical keyboard and pointer input. Ctrl+Alt+Escape leaves screen keyboard focus.")
            }
            aria-pressed="false"
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
        {desktop().inputSources() && (
          <select
            {...styles.select()}
            style={{ width: "120px" }}
            aria-label="Host input source"
            title={desktop().inputSourceMessage() ?? "Host input source (IME)"}
            value={desktop().inputSources()?.currentId ?? ""}
            disabled={
              !desktop().controlling() ||
              !desktop().ownsInput(viewer) ||
              desktop().inputSourceBusy()
            }
            onFocus={() => void desktop().refreshInputSources()}
            onChange={(event) => {
              const sourceId = event.currentTarget.value;
              // Keep the last confirmed value until the host acknowledges selection.
              event.currentTarget.value =
                desktop().inputSources()?.currentId ?? "";
              void desktop().chooseInputSource(sourceId, viewer);
            }}
          >
            {!desktop()
              .inputSources()
              ?.sources.some(
                (source) => source.id === desktop().inputSources()?.currentId,
              ) && (
              <option
                value={desktop().inputSources()?.currentId ?? ""}
                disabled
              >
                {desktop().inputSources()?.currentId ?? "Input source"}
              </option>
            )}
            <For each={desktop().inputSources()?.sources}>
              {(source) => <option value={source.id}>{source.name}</option>}
            </For>
          </select>
        )}
        {desktop().inputSourceMessage() && (
          <span role="alert">{desktop().inputSourceMessage()}</span>
        )}
        {!desktop().serverOwnsGeometry() && (
          <label
            {...styles.toolbarField()}
            title="Maximum video size. Changes video only, not OS resolution; releases held inputs."
          >
            <select
              {...styles.select()}
              style={{ width: "112px" }}
              aria-label="Maximum video size"
              value={desktop().outputHeight()}
              disabled={desktop().busy() || desktop().phase() === "connecting"}
              onChange={(event) =>
                void desktop().resize(Number(event.currentTarget.value))
              }
            >
              <option value="720">1280 × 720</option>
              <option value="1080">1920 × 1080</option>
              <option value="2160">3840 × 2160</option>
            </select>
          </label>
        )}
        {desktop().qualitySupported() &&
          desktop().phase() === "viewing" &&
          !!desktop().configuration()?.tracks.length && (
            <>
              <label {...styles.toolbarField()} title="Target FPS">
                <Activity size={16} />
                <input
                  {...styles.select()}
                  type="number"
                  aria-label="Target FPS"
                  min="1"
                  max="120"
                  value={fps()}
                  onInput={(event) => setFps(Number(event.currentTarget.value))}
                />
              </label>
              <label
                {...styles.toolbarField()}
                title="Shared bitrate target (Mbps)"
              >
                <Wifi size={16} />
                <input
                  {...styles.select()}
                  type="number"
                  aria-label="Shared bitrate target (Mbps)"
                  min="0.1"
                  max="100"
                  step="0.1"
                  value={mbps()}
                  onInput={(event) =>
                    setMbps(Number(event.currentTarget.value))
                  }
                />
              </label>
              <Button
                size="icon"
                aria-label="Check quality support"
                title={desktop().qualityMessage() ?? "Check quality support"}
                disabled={
                  desktop().qualityBusy() ||
                  !Number.isInteger(fps()) ||
                  fps() < 1 ||
                  fps() > 120 ||
                  !Number.isFinite(mbps()) ||
                  mbps() < 0.1 ||
                  mbps() > 100
                }
                onClick={() => {
                  setCandidateIndex(0);
                  void desktop().queryQuality({
                    fps: fps(),
                    totalBitrate: Math.round(mbps() * 1_000_000),
                  });
                }}
              >
                <RefreshCw size={16} />
              </Button>
              {desktop().qualitySupport() && (
                <>
                  <Button
                    size="icon"
                    aria-label="Use Auto"
                    title={`Use automatic quality. Current: ${desktop().configuration()?.tracks[0]?.viewport.fps} FPS / ${(desktop().configuration()?.totalBitrate ?? 0) / 1_000_000} Mbps`}
                    aria-pressed={
                      desktop().qualityPolicy()?.type === "auto"
                        ? "true"
                        : "false"
                    }
                    disabled={
                      desktop().qualityBusy() ||
                      !desktop().qualitySupport()?.automaticAvailable
                    }
                    onClick={() =>
                      void desktop().applyQuality({ type: "auto" })
                    }
                  >
                    <Radio size={16} />
                  </Button>
                  <select
                    {...styles.select()}
                    style={{ width: "86px" }}
                    aria-label="Verified video quality target"
                    title="FPS / Mbps; only verified targets can be applied"
                    value={candidateIndex()}
                    disabled={desktop().qualityBusy()}
                    onChange={(event) =>
                      setCandidateIndex(Number(event.currentTarget.value))
                    }
                  >
                    <For each={desktop().qualitySupport()?.candidates}>
                      {(item, index) => (
                        <option
                          value={index()}
                          disabled={
                            item.verification !==
                            DesktopQualityVerification.Verified
                          }
                          title={item.reason}
                        >
                          {item.target.fps} /{" "}
                          {item.target.totalBitrate / 1_000_000}
                        </option>
                      )}
                    </For>
                  </select>
                  <Button
                    size="icon"
                    aria-label="Apply verified video quality"
                    title={
                      candidate()
                        ? `Apply ${candidate()!.target.fps} FPS / ${candidate()!.target.totalBitrate / 1_000_000} Mbps`
                        : "No verified target selected"
                    }
                    disabled={
                      desktop().qualityBusy() ||
                      candidate()?.verification !==
                        DesktopQualityVerification.Verified
                    }
                    onClick={() => {
                      const selected = candidate();
                      if (
                        selected?.verification ===
                        DesktopQualityVerification.Verified
                      )
                        void desktop().applyQuality({
                          type: "manual",
                          target: selected.target,
                        });
                    }}
                  >
                    <Check size={16} />
                  </Button>
                </>
              )}
              <output {...styles.screenReaderOnly()} role="status">
                {desktop().qualityBusy()
                  ? "Checking or applying quality…"
                  : desktop().qualityMessage()}
              </output>
            </>
          )}
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
  const [pane, setPane] = createSignal<HTMLElement>();
  const [paneSize, setPaneSize] = createSignal({ width: 0, height: 0 });
  const narrow = createMemo(
    () => paneSize().width > 0 && paneSize().width <= 600,
  );
  const [catalog, setCatalog] = createSignal<HTMLElement>();
  const [size, setSize] = createSignal({ width: 0, height: 0 });
  const arrangement = createMemo(() =>
    desktopArrangement(desktop().displays(), desktop().hostOs()),
  );
  const fit = createMemo(() =>
    fitDesktopArrangement(arrangement(), size().width, size().height),
  );
  createEffect(
    createMemo(() => ({ catalog: catalog(), pane: pane() })),
    ({ catalog, pane }) => {
      if (!catalog || !pane) return;
      let frame = 0;
      let stageSize = { width: 0, height: 0 };
      let parentSize = { width: 0, height: 0 };
      const observer = new ResizeObserver((entries) => {
        for (const entry of entries) {
          const next = {
            width: entry.contentRect.width,
            height: entry.contentRect.height,
          };
          if (entry.target === catalog) stageSize = next;
          else parentSize = next;
        }
        cancelAnimationFrame(frame);
        frame = requestAnimationFrame(() => {
          setSize(stageSize);
          setPaneSize(parentSize);
        });
      });
      observer.observe(catalog);
      observer.observe(pane);
      return () => {
        cancelAnimationFrame(frame);
        observer.disconnect();
      };
    },
  );
  return (
    <section
      {...styles.root({ className: "rieul-desktop" })}
      ref={setPane}
      style={{ overflow: "auto" }}
      data-phase={desktop().phase()}
      data-controlling={desktop().controlling()}
      aria-label="Screen"
    >
      {!desktop().catalogStatusPending() &&
        (desktop().message() ||
          desktop().availabilityMessage() ||
          desktop().phase() === "error" ||
          desktop().phase() === "unsupported" ||
          (desktop().phase() === "viewing" &&
            !desktop().displays().length)) && (
          <header {...styles.toolbar()}>
            <details
              name="screen-toolbar-panel"
              {...styles.toolbarDisclosure()}
            >
              <summary aria-label="Connection status">
                {desktop().phase() === "viewing" && !desktop().displays().length
                  ? "No displays"
                  : "Status !"}
              </summary>
              <div {...styles.toolbarPanel()}>
                <p role="status">
                  {desktop().message() ??
                    desktop().availabilityMessage() ??
                    (desktop().phase() === "viewing"
                      ? "No displays are available."
                      : "Screen is unavailable.")}
                </p>
              </div>
            </details>
          </header>
        )}
      <nav
        {...styles.catalog()}
        aria-label="Displays"
        style={
          narrow()
            ? {
                flex: "0 0 auto",
                height: "auto",
              }
            : undefined
        }
      >
        <div
          {...styles.arrangementContent({
            className: "rieul-desktop-arrangement-content",
          })}
          ref={setCatalog}
          style={
            narrow()
              ? {
                  height: "auto",
                  "aspect-ratio": `${arrangement().width} / ${arrangement().height}`,
                  "max-height": "max(80px, calc(65cqh - 4rem))",
                }
              : undefined
          }
        >
          <For each={arrangement().tiles}>
            {(tile) => (
              <button
                type="button"
                {...styles.previewTile()}
                style={{
                  left: `${fit().left + tile.x * fit().scale}px`,
                  top: `${fit().top + tile.y * fit().scale}px`,
                  width: `${tile.width * fit().scale}px`,
                  height: `${tile.height * fit().scale}px`,
                }}
                aria-label={`Display ${tile.display.displayId}`}
                title={`Open display ${tile.display.displayId}`}
                disabled={desktop().phase() !== "viewing"}
                onClick={() => props.onSelect(tile.display.displayId)}
              >
                <DesktopPreview display={tile.display} />
              </button>
            )}
          </For>
        </div>
      </nav>
      {paneSize().width > 0 &&
        paneSize().height > 0 &&
        desktop().displays().length > 0 &&
        (narrow() ||
          arrangement().overlapping ||
          arrangement().tiles.some(
            (tile) => Math.min(tile.width, tile.height) * fit().scale < 24,
          )) && (
          <nav
            {...styles.displayChoices()}
            aria-label="Monitor list"
            style={{ "max-height": narrow() ? "none" : "30%" }}
          >
            <For each={desktop().displays()}>
              {(display) => (
                <button
                  type="button"
                  {...styles.displayChoice()}
                  disabled={desktop().phase() !== "viewing"}
                  aria-label={`Choose monitor ${display.displayId}`}
                  onClick={() => props.onSelect(display.displayId)}
                >
                  <span>Display {display.displayId}</span>
                  <span {...styles.choiceMetadata()}>
                    {display.bounds.width} × {display.bounds.height}
                  </span>
                </button>
              )}
            </For>
          </nav>
        )}
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
      let contextLost = false;
      const sync = () => {
        if (visible && !contextLost && !canvas.ownerDocument.hidden)
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
      const lost = () => {
        contextLost = true;
        sync();
      };
      const restored = () => {
        contextLost = false;
        sync();
      };
      canvas.addEventListener("contextlost", lost);
      canvas.addEventListener("contextrestored", restored);
      canvas.ownerDocument.addEventListener("visibilitychange", sync);
      return () => {
        observer.disconnect();
        canvas.removeEventListener("contextlost", lost);
        canvas.removeEventListener("contextrestored", restored);
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
            "max-width": shape()
              ? `${desktopCursorMaxWidth(shape()!)}px`
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
  export const toolbarField = style({
    display: "inline-flex",
    alignItems: "center",
    gap: "4px",
    minWidth: "0",
    maxWidth: "100%",
  });
  export const activeControl = style({
    backgroundColor: theme.accentSoftStrong,
    boxShadow: `inset 0 0 0 2px ${theme.accent}`,
  });
  export const screenReaderOnly = style({
    position: "absolute",
    width: "1px",
    height: "1px",
    padding: "0",
    margin: "-1px",
    overflow: "hidden",
    clipPath: "inset(50%)",
    whiteSpace: "nowrap",
    border: "0",
  });

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
  export const previewTile = style({
    position: "absolute",
    display: "block",
    boxSizing: "border-box",
    padding: "0",
    overflow: "hidden",
    backgroundColor: theme.bgInverse,
    border: "0",
    borderRadius: "0",
    cursor: "pointer",
    selectors: {
      "&:focus-visible": {
        outline: "2px solid",
        outlineColor: theme.focus,
        outlineOffset: "-3px",
        zIndex: 1,
      },
      "&:disabled": { opacity: 0.6, cursor: "default" },
    },
  });
  export const catalog = style({
    position: "relative",
    backgroundColor: "#000",
    boxSizing: "border-box",
    paddingBlock: "2rem",
    paddingInline: "1rem",
    border: "0",
    borderRadius: "0",
    flex: "1 1 0",
    minWidth: "0",
    minHeight: "0",
    overflow: "hidden",
  });
  export const arrangementContent = style({
    position: "relative",
    width: "100%",
    height: "100%",
    minWidth: "0",
    minHeight: "0",
  });
  export const displayChoices = style({
    display: "grid",
    flexShrink: 0,
    overflow: "auto",
  });
  export const displayChoice = style({
    display: "flex",
    alignItems: "center",
    justifyContent: "space-between",
    gap: "8px",
    minHeight: "44px",
    width: "100%",
    padding: "8px",
    boxSizing: "border-box",
    textAlign: "left",
    overflowWrap: "anywhere",
    backgroundColor: theme.bgPrimary,
    color: theme.textPrimary,
    borderTop: "1px solid",
    borderColor: theme.borderLight,
    cursor: "pointer",
    selectors: {
      "&:hover": { backgroundColor: theme.bgHeader },
      "&:focus-visible": {
        outline: "2px solid",
        outlineColor: theme.focus,
        outlineOffset: "-3px",
      },
      "&:disabled": { opacity: 0.6, cursor: "default" },
    },
  });
  export const choiceMetadata = style({
    color: theme.textTertiary,
    fontSize: "12px",
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
    width: "58px",
    minWidth: "0",
    maxWidth: "100%",
    margin: "0",
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
