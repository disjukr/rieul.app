import { global } from "zyzz/web";
import { style, theme } from "../../../../zyzz.config.ts";
import { Button } from "../../../ui/button.tsx";
import { For, createEffect, createMemo, createSignal, untrack } from "solid-js";
import { desktopCursorPng } from "../../../../protocol/desktop-cursor.ts";
import { useBunja } from "bunja/solid";
import { desktopBunja } from "../../../../state/desktop.ts";
import {
  DesktopQualityVerification,
  type DesktopTrack,
} from "../../../../protocol/generated/rpc.ts";

/** Semantic classes also style the separate display document. */
export function DesktopTool() {
  const desktop = useBunja(desktopBunja);
  const [fps, setFps] = createSignal(60);
  const [mbps, setMbps] = createSignal(20);
  return (
    <section
      {...styles.root({ className: "rieul-desktop" })}
      data-phase={desktop().phase()}
      data-controlling={desktop().controlling()}
      aria-label="Screen"
    >
      <header {...styles.toolbar({ className: "rieul-desktop-toolbar" })}>
        <h2 {...styles.title()}>Screen</h2>
        <Button
          size="sm"
          type="button"
          disabled={
            !desktop().supported() || desktop().phase() === "connecting"
          }
          onClick={() => void desktop().connect()}
        >
          {desktop().phase() === "viewing"
            ? "Reconnect"
            : desktop().phase() === "error" ||
                desktop().phase() === "unsupported"
              ? "Retry connection"
              : "Open screen"}
        </Button>
        <Button
          size="sm"
          type="button"
          disabled={
            desktop().phase() !== "viewing" &&
            desktop().phase() !== "connecting"
          }
          onClick={() => desktop().disconnect()}
        >
          Close screen
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
      <p {...styles.help()}>
        Existing displays: uses the daemon’s current OS display configuration.
        {desktop().modes().custom
          ? " Custom layout is advertised by this daemon; this client does not yet configure it."
          : " Custom layout is not offered by this daemon."}
      </p>
      <p
        {...styles.status({ className: "rieul-desktop-status" })}
        role="status"
      >
        {desktop().message() ??
          desktop().availabilityMessage() ??
          (desktop().controlling()
            ? "You control this screen."
            : desktop().phase() === "viewing"
              ? !desktop().inputReady()
                ? "Viewing only. Input is unavailable; check the daemon’s OS input permission."
                : desktop().control().holderAttachId
                  ? "Another viewer controls this screen. Choose Take control to request an explicit handoff."
                  : "Viewing only. Taking control is explicit."
              : desktop().phase() === "connecting"
                ? "Connecting…"
                : !desktop().supported()
                  ? "This daemon does not offer Screen."
                  : "Connect to view the displays.")}
      </p>
      <p {...styles.help({ className: "rieul-desktop-input-help" })}>
        Keyboard input uses physical keys. IME and OS-reserved shortcuts are
        unavailable. Ctrl+Alt+Escape leaves screen keyboard focus.
      </p>
      {!desktop().automaticDisplays() && (
        <label {...styles.help()}>
          Maximum video size
          <select
            {...styles.select()}
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
          </select>{" "}
          Video size only; OS display resolution is unchanged. Changing size
          releases held inputs.
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
              {(desktop().configuration()?.totalBitrate ?? 0) / 1_000_000} Mbps
              shared. Mode:{" "}
              {desktop().qualityPolicy()?.type === "auto" ? "Auto" : "Manual"}.
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
              Targets are not guaranteed performance. Resolution and codec stay
              as shown below. Auto uses measured delivery delays and receiver
              queue feedback within verified combinations.
            </p>
            {desktop().qualitySupport() && (
              <div>
                <Button
                  size="sm"
                  disabled={
                    desktop().qualityBusy() ||
                    !desktop().qualitySupport()?.automaticAvailable
                  }
                  onClick={() => void desktop().applyQuality({ type: "auto" })}
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
                          ? "Encoder verified"
                          : candidate.verification ===
                              DesktopQualityVerification.Unsupported
                            ? "Unsupported"
                            : "Unverified"}
                        . {candidate.reason}
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
      {desktop().phase() === "viewing" && !desktop().displays().length && (
        <p {...styles.help()}>The daemon has no active displays.</p>
      )}
      <div {...styles.viewports({ className: "rieul-desktop-viewports" })}>
        <For
          each={desktop()
            .configuration()
            ?.tracks.map((t) => t.viewport.viewportId)}
        >
          {(id) => (
            <DesktopSurface
              track={
                desktop()
                  .configuration()!
                  .tracks.find((t) => t.viewport.viewportId === id)!
              }
            />
          )}
        </For>
      </div>
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
    </section>
  );
}
function DesktopSurface(props: { track: DesktopTrack }) {
  const desktop = useBunja(desktopBunja);
  const [canvas, setCanvas] = createSignal<HTMLCanvasElement>();
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
      const cleanup = untrack(() => model.registerSurface(id, canvas));
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
        <span>
          {props.track.viewport.width} × {props.track.viewport.height} ·{" "}
          {props.track.codec.codec}
        </span>
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
