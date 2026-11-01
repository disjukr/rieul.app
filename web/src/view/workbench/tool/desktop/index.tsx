import { createEffect, createMemo, createSignal, untrack } from "solid-js";
import { useBunja } from "bunja/solid";
import { desktopBunja } from "../../../../state/desktop.ts";
import type { DesktopTrack } from "../../../../protocol/generated/rpc.ts";

/** Styling contract: rieul-desktop-* classes, data-phase, data-controlling and
 * data-visible. No shared theme/CVA/UnoCSS assumptions; Zyzz owns presentation. */
export function DesktopTool() {
  const desktop = useBunja(desktopBunja);
  return (
    <section
      class="rieul-desktop"
      data-phase={desktop().phase()}
      data-controlling={desktop().controlling()}
      aria-label="Remote desktop"
    >
      <header class="rieul-desktop-toolbar">
        <h2>Remote desktop</h2>
        <button
          type="button"
          disabled={
            !desktop().supported() || desktop().phase() === "connecting"
          }
          onClick={() => void desktop().connect()}
        >
          {desktop().phase() === "viewing" ? "Reconnect" : "Connect"}
        </button>
        <button
          type="button"
          disabled={desktop().phase() !== "viewing"}
          onClick={() => desktop().disconnect()}
        >
          Disconnect
        </button>
        <button
          type="button"
          disabled={
            !desktop().inputReady() ||
            desktop().busy() ||
            desktop().controlling()
          }
          onClick={() => void desktop().acquire()}
        >
          Acquire control
        </button>
        <button
          type="button"
          disabled={
            !desktop().inputReady() ||
            desktop().busy() ||
            desktop().controlling()
          }
          onClick={() => void desktop().takeover()}
        >
          Take control
        </button>
        <button
          type="button"
          disabled={!desktop().controlling() || desktop().busy()}
          onClick={() => void desktop().release()}
        >
          Release control
        </button>
      </header>
      <p class="rieul-desktop-status" role="status">
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
      <p class="rieul-desktop-input-help">
        Keyboard input uses physical keys. IME and OS-reserved shortcuts are
        unavailable. Ctrl+Alt+Escape leaves remote keyboard focus.
      </p>
      <fieldset
        class="rieul-desktop-displays"
        disabled={desktop().busy() || desktop().phase() !== "viewing"}
      >
        <legend>Displays</legend>
        {desktop()
          .displays()
          .map((display) => (
            <label>
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
      <div class="rieul-desktop-viewports">
        {desktop()
          .configuration()
          ?.tracks.map((track) => (
            <DesktopSurface track={track} />
          ))}
      </div>
      {desktop().stats() && (
        <output
          class="rieul-desktop-metrics"
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
  const cursor = createMemo(() => {
    const cursor = desktop().cursor(),
      display = desktop()
        .displays()
        .find((d) => d.displayId === props.track.viewport.displayId),
      crop = props.track.viewport.crop;
    if (
      !cursor?.visible ||
      !display ||
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
      class="rieul-desktop-viewport"
      data-viewport-id={props.track.viewport.viewportId}
    >
      <header class="rieul-desktop-viewport-toolbar">
        <h3>{props.track.viewport.displayId}</h3>
        <button
          type="button"
          onClick={() => desktop().openWindow(props.track.viewport.viewportId)}
        >
          Open in another window
        </button>
      </header>
      <div class="rieul-desktop-frame" style={{ position: "relative" }}>
        <canvas
          ref={setCanvas}
          class="rieul-desktop-canvas"
          tabindex={0}
          aria-label={`Remote display ${props.track.viewport.displayId}`}
          aria-description="Physical keys only. Ctrl+Alt+Escape leaves remote keyboard focus."
        />
        <span
          class="rieul-desktop-cursor"
          data-visible={!!cursor()}
          aria-hidden="true"
          style={{
            position: "absolute",
            "pointer-events": "none",
            display: cursor() ? undefined : "none",
            left: cursor()?.left,
            top: cursor()?.top,
          }}
        >
          ↖
        </span>
      </div>
    </article>
  );
}
