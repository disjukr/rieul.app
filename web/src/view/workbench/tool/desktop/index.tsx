import { global } from "zyzz/web";
import { style, theme } from "../../../../zyzz.config.ts";
import { Button } from "../../../ui/button.tsx";
import { createEffect, createMemo, createSignal, untrack } from "solid-js";
import { desktopCursorPng } from "../../../../protocol/desktop-cursor.ts";
import { useBunja } from "bunja/solid";
import { desktopBunja } from "../../../../state/desktop.ts";
import type { DesktopTrack } from "../../../../protocol/generated/rpc.ts";

/** Semantic classes also style the separate display document. */
export function DesktopTool() {
  const desktop = useBunja(desktopBunja);
  return (
    <section
      {...styles.root({ className: "rieul-desktop" })}
      data-phase={desktop().phase()}
      data-controlling={desktop().controlling()}
      aria-label="Remote desktop"
    >
      <header {...styles.toolbar({ className: "rieul-desktop-toolbar" })}>
        <h2 {...styles.title()}>Remote desktop</h2>
        <Button
          size="sm"
          type="button"
          disabled={
            !desktop().supported() || desktop().phase() === "connecting"
          }
          onClick={() => void desktop().connect()}
        >
          {desktop().phase() === "viewing" ? "Reconnect" : "Connect"}
        </Button>
        <Button
          size="sm"
          type="button"
          disabled={desktop().phase() !== "viewing"}
          onClick={() => desktop().disconnect()}
        >
          Disconnect
        </Button>
        <Button
          size="sm"
          type="button"
          disabled={
            !desktop().inputReady() ||
            desktop().busy() ||
            desktop().controlling()
          }
          onClick={() => void desktop().acquire()}
        >
          Acquire control
        </Button>
        <Button
          size="sm"
          type="button"
          disabled={
            !desktop().inputReady() ||
            desktop().busy() ||
            desktop().controlling()
          }
          onClick={() => void desktop().takeover()}
        >
          Take control
        </Button>
        <Button
          size="sm"
          type="button"
          disabled={!desktop().controlling() || desktop().busy()}
          onClick={() => void desktop().release()}
        >
          Release control
        </Button>
      </header>
      <p
        {...styles.status({ className: "rieul-desktop-status" })}
        role="status"
      >
        {desktop().message() ??
          (desktop().controlling()
            ? "You control this desktop."
            : desktop().phase() === "viewing"
              ? "Viewing only. Taking control is explicit."
              : desktop().phase() === "connecting"
                ? "Connecting…"
                : !desktop().supported()
                  ? "This daemon does not offer remote desktop."
                  : "Connect to view the remote displays.")}
      </p>
      <p {...styles.help({ className: "rieul-desktop-input-help" })}>
        Keyboard input uses physical keys. IME and OS-reserved shortcuts are
        unavailable. Ctrl+Alt+Escape leaves remote keyboard focus.
      </p>
      <fieldset
        {...styles.displays({ className: "rieul-desktop-displays" })}
        disabled={desktop().busy() || desktop().phase() !== "viewing"}
      >
        <legend>Displays</legend>
        {desktop()
          .displays()
          .map((display) => (
            <label {...styles.displayOption()}>
              <input
                type="checkbox"
                checked={
                  desktop()
                    .configuration()
                    ?.tracks.some(
                      (t) => t.viewport.displayId === display.displayId,
                    ) ?? false
                }
                onChange={(event) => {
                  const ids =
                    desktop()
                      .configuration()
                      ?.tracks.map((t) => t.viewport.displayId) ?? [];
                  void desktop().configure(
                    event.currentTarget.checked
                      ? [...ids, display.displayId]
                      : ids.filter((id) => id !== display.displayId),
                  );
                }}
              />
              {display.displayId} ({display.bounds.width} ×{" "}
              {display.bounds.height})
            </label>
          ))}
      </fieldset>
      <div {...styles.viewports({ className: "rieul-desktop-viewports" })}>
        {desktop()
          .configuration()
          ?.tracks.map((track) => (
            <DesktopSurface track={track} />
          ))}
      </div>
      {desktop().stats() && (
        <output
          {...styles.metrics({ className: "rieul-desktop-metrics" })}
          aria-label="Desktop decoder status"
        >
          {desktop().stats()!.requestKeyframe
            ? "Recovering at the next keyframe"
            : `Decoder queue: ${desktop().stats()!.queueDepth}`}
        </output>
      )}
    </section>
  );
}
function DesktopSurface(props: { track: DesktopTrack }) {
  const desktop = useBunja(desktopBunja);
  const [canvas, setCanvas] = createSignal<HTMLCanvasElement>();
  createEffect(
    createMemo(() => ({
      canvas: canvas(),
      track: props.track,
      model: desktop(),
    })),
    ({ canvas, track, model }) => {
      if (!canvas) return;
      canvas.width = track.viewport.width;
      canvas.height = track.viewport.height;
      const cleanup = untrack(() =>
        model.registerSurface(track.viewport.viewportId, canvas),
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
    return {
      left: `${(x / crop.width) * 100}%`,
      top: `${(y / crop.height) * 100}%`,
    };
  });
  return (
    <article
      {...styles.viewport({ className: "rieul-desktop-viewport" })}
      data-viewport-id={props.track.viewport.viewportId}
    >
      <header
        {...styles.viewportToolbar({
          className: "rieul-desktop-viewport-toolbar",
        })}
      >
        <h3 {...styles.displayTitle()}>{props.track.viewport.displayId}</h3>
        <Button
          size="sm"
          type="button"
          onClick={() => desktop().openWindow(props.track.viewport.viewportId)}
        >
          Open in another window
        </Button>
      </header>
      <div {...styles.frame({ className: "rieul-desktop-frame" })}>
        <canvas
          ref={setCanvas}
          class="rieul-desktop-canvas"
          tabindex={0}
          aria-label={`Remote display ${props.track.viewport.displayId}`}
          aria-description="Physical keys only. Ctrl+Alt+Escape leaves remote keyboard focus."
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
              ? `${(shape()!.width / props.track.viewport.crop.width) * 100}%`
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
  export const cursorImage = style({ width: "100%", display: "block" });
  export const root = style({
    display: "flex",
    flexDirection: "column",
    minWidth: "0",
    minHeight: "0",
    height: "100%",
    overflow: "auto",
    backgroundColor: theme.bgPrimary,
    color: theme.textPrimary,
  });
  export const toolbar = style({
    display: "flex",
    flexWrap: "wrap",
    alignItems: "center",
    gap: "8px",
    padding: "12px",
    borderBottom: "1px solid",
    borderBottomColor: theme.borderLight,
    backgroundColor: theme.bgHeader,
  });
  export const title = style({
    margin: "0",
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
    display: "grid",
    gridTemplateColumns: "repeat(auto-fit, minmax(min(100%, 320px), 1fr))",
    alignItems: "start",
    gap: "12px",
    padding: "0 12px 12px",
  });
  export const viewport = style({
    minWidth: "0",
    overflow: "hidden",
    border: "1px solid",
    borderColor: theme.borderLight,
    borderRadius: theme.radiusMd,
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
  ".rieul-desktop-canvas": {
    display: "block",
    width: "100%",
    height: "auto",
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
