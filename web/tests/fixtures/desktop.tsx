import "../../src/theme.css";
import { TestBunjaStoreProvider } from "./bunja-store.tsx";
import { bunja, override } from "bunja";
import { createSignal, createMemo } from "solid-js";
import { render } from "@solidjs/web";
import { managedDesktopBunja } from "../../src/state/desktop.ts";
import { DesktopDisplayIdScope } from "../../src/state/desktop-scopes.ts";
import { DesktopTool } from "../../src/view/workbench/tool/desktop/index.tsx";
import { bindDesktopInput } from "../../src/protocol/desktop-input.ts";
import {
  DesktopQualityVerification,
  type DesktopQualityPolicy,
  type DesktopDisplay,
  type DesktopQualitySupport,
  type DesktopConfiguration,
  type DesktopInputEvent,
} from "../../src/protocol/generated/rpc.ts";
function Fixture() {
  const [events, setEvents] = createSignal<DesktopInputEvent[]>([]);
  const [active, setActive] = createSignal(true);
  const [previewSubscriptions, setPreviewSubscriptions] = createSignal(0);
  const [holder, setHolder] = createSignal<string | undefined>(
    new URLSearchParams(location.search).has("occupied") ? "other" : undefined,
  );
  function createModel(initialDisplayId?: string) {
    const params = new URLSearchParams(location.search);
    const [phase, setPhase] = createSignal<
      "idle" | "connecting" | "viewing" | "error"
    >("idle");
    const [controlling, setControlling] = createSignal(false);
    const [selectedDisplayId, setSelectedDisplayId] =
      createSignal(initialDisplayId);
    const [inputOwner, setInputOwner] = createSignal<symbol>();
    const [configuration, setConfiguration] =
      createSignal<DesktopConfiguration>();
    const [outputHeight, setOutputHeight] = createSignal(1080);
    const [epoch, setEpoch] = createSignal(1);
    const spatial = new URLSearchParams(location.search).has("spatial");
    const display: DesktopDisplay = {
      displayId: "fixture",
      bounds: {
        x: 0,
        y: 0,
        width: new URLSearchParams(location.search).has("portrait") ? 180 : 320,
        height: new URLSearchParams(location.search).has("portrait")
          ? 320
          : 180,
      },
      scale: spatial ? 2 : 1,
      dpi: 96,
      ...(spatial
        ? {
            bounds: { x: 0, y: 0, width: 3840, height: 2160 },
            arrangementBounds: { x: 0, y: 0, width: 1920, height: 1080 },
          }
        : {}),
    };
    const [qualitySupport, setQualitySupport] =
      createSignal<DesktopQualitySupport>();
    const [qualityPolicy, setQualityPolicy] =
      createSignal<DesktopQualityPolicy>();
    const [inputReady, setInputReady] = createSignal(false);
    const model = {
      qualitySupported: createMemo(() =>
        new URLSearchParams(location.search).has("quality"),
      ),
      qualitySupport,
      qualityPolicy,
      qualityBusy: createMemo(() => false),
      qualityMessage: createSignal<string>()[0],
      async queryQuality() {
        setQualitySupport({
          layoutEpoch: 1,
          revision: 1,
          automaticAvailable: true,
          concurrentThroughputVerified: false,
          policy: {
            type: "manual",
            target: { fps: 60, totalBitrate: 20_000_000 },
          },
          candidates: [
            {
              target: { fps: 30, totalBitrate: 5_000_000 },
              tracks: configuration()!.tracks,
              verification: DesktopQualityVerification.Verified,
              reason: "Fixture encoder verified; throughput unverified.",
            },
            {
              target: { fps: 120, totalBitrate: 50_000_000 },
              tracks: configuration()!.tracks,
              verification: DesktopQualityVerification.Unknown,
              reason: "Unverified.",
            },
          ],
        });
      },
      async applyQuality(policy: DesktopQualityPolicy) {
        setQualityPolicy(policy);
        const target =
          policy.type === "manual"
            ? policy.target
            : { fps: 30, totalBitrate: 5_000_000 };
        setConfiguration((c) => ({
          ...c!,
          totalBitrate: target.totalBitrate,
          tracks: c!.tracks.map((t) => ({
            ...t,
            codecEpoch: t.codecEpoch + 1,
            viewport: {
              ...t.viewport,
              fps: target.fps,
              bitrate: target.totalBitrate,
            },
          })),
        }));
      },
      catalogStatusPending: createMemo(
        () => params.has("loading") || phase() === "connecting",
      ),
      availabilityMessage: createMemo(() =>
        params.has("loading")
          ? "Checking daemon support…"
          : params.has("unavailable")
            ? "This daemon version does not offer Screen. Update the daemon to continue."
            : params.has("unpaired")
              ? "Select a paired daemon to connect."
              : undefined,
      ),
      outputHeight,
      maxViewports: createSignal(8)[0],
      resize: async (height: number) => {
        setOutputHeight(height);
      },
      phase,
      controlling,
      configuration,
      control: createMemo(() => ({
        inputEpoch: epoch(),
        holderAttachId: controlling() ? "fixture" : holder(),
      })),
      attachId: createSignal<string | undefined>("fixture")[0],
      hostOs: createMemo(() =>
        new URLSearchParams(location.search).has("legacy-mac")
          ? "macOS Sequoia"
          : "Windows 11",
      ),
      displays: createSignal(
        params.has("no-displays")
          ? []
          : [
              display,
              {
                ...display,
                displayId: "second",
                bounds: spatial
                  ? { x: -1080, y: -400, width: 1080, height: 1920 }
                  : {
                      ...display.bounds,
                      x: new URLSearchParams(location.search).has("mirrored")
                        ? 0
                        : display.bounds.width,
                    },
                ...(spatial
                  ? {
                      arrangementBounds: {
                        x: -1080,
                        y: -400,
                        width: 1080,
                        height: 1920,
                      },
                      scale: 1,
                    }
                  : {}),
              },
            ],
      )[0],
      supported: createMemo(() => true),
      connect: async () => {},
      serverOwnsGeometry: createMemo(() =>
        new URLSearchParams(location.search).has("automatic"),
      ),
      automaticDisplays: createMemo(() =>
        new URLSearchParams(location.search).has("automatic"),
      ),
      modes: createMemo(() => ({ existing: true, custom: false })),
      inputReady,
      busy: createSignal(false)[0],
      message: createMemo(() =>
        params.has("failure")
          ? "Screen connection failed."
          : params.has("stale-error")
            ? "Old connection failure"
            : new URLSearchParams(location.search).has("input-error") &&
                phase() === "viewing"
              ? "Input connection failed. View remains connected; reconnect to control."
              : undefined,
      ),
      stats: createSignal<
        import("../../src/protocol/desktop-video.ts").DesktopVideoStats
      >({
        trackId: 1,
        codecEpoch: 1,
        groupId: 1,
        decodeMicros: 20,
        renderMicros: 10,
        queueDepth: 2,
        requestKeyframe: false,
      })[0],
      cursor:
        createSignal<
          Extract<
            import("../../src/protocol/generated/rpc.ts").DesktopEvent,
            { type: "cursor" }
          >
        >()[0],
      selectedDisplayId,
      start() {
        setPhase(
          params.has("failure")
            ? "error"
            : params.has("connecting")
              ? "connecting"
              : params.has("loading") || params.has("unpaired")
                ? "idle"
                : "viewing",
        );
        if (selectedDisplayId()) void model.selectDisplay(selectedDisplayId()!);
      },
      stop() {
        setControlling(false);
        setInputReady(false);
        setConfiguration(undefined);
      },
      async leaveDisplay() {
        setControlling(false);
        setSelectedDisplayId(undefined);
        setInputReady(false);
        setConfiguration(undefined);
      },
      async selectDisplay(displayId: string) {
        setSelectedDisplayId(displayId);
        setPhase("viewing");
        setInputReady(!new URLSearchParams(location.search).has("no-input"));
        setConfiguration({
          totalBitrate: 1,
          layoutEpoch: 1,
          tracks: [
            {
              trackId: 1,
              codecEpoch: 1,
              codec: { codec: "fixture", hardware: false },
              viewport: {
                viewportId: displayId,
                displayId,
                crop: {
                  x: 0,
                  y: 0,
                  width: display.bounds.width,
                  height: display.bounds.height,
                },
                width: display.bounds.width,
                height: display.bounds.height,
                fps: 60,
                bitrate: 1,
              },
            },
          ],
        });
      },
      disconnect() {
        setControlling(false);
        setPhase("idle");
        setInputReady(false);
        setConfiguration(undefined);
      },
      async configure() {},
      registerViewer(viewer: symbol) {
        return () => {
          if (inputOwner() === viewer) {
            setInputOwner(undefined);
            setControlling(false);
          }
        };
      },
      ownsInput: (viewer: symbol) => inputOwner() === viewer,
      async acquire(viewer?: symbol) {
        if (!holder()) {
          setControlling(true);
          setInputOwner(viewer);
        }
      },
      async takeover(viewer?: symbol) {
        setEpoch((n) => n + 1);
        setHolder(undefined);
        setControlling(true);
        setInputOwner(viewer);
      },
      async release() {
        setControlling(false);
      },
      openWindow() {},
      previewAvailable: (_displayId: string) => true,
      registerPreviewSurface(_displayId: string, canvas: HTMLCanvasElement) {
        setPreviewSubscriptions((count) => count + 1);
        const ctx = canvas.getContext("2d")!;
        ctx.fillStyle = "#2367d1";
        ctx.fillRect(0, 0, canvas.width, canvas.height);
        return () => setPreviewSubscriptions((count) => count - 1);
      },
      registerSurface(id: string, canvas: HTMLCanvasElement, viewer?: symbol) {
        const ctx = canvas.getContext("2d")!;
        ctx.fillStyle = "#2367d1";
        ctx.fillRect(0, 0, canvas.width, canvas.height);
        return bindDesktopInput(
          canvas,
          id,
          (event) => {
            setEvents((previous) => [...previous, event]);
            return true;
          },
          () => ({
            active:
              controlling() &&
              (viewer === undefined || inputOwner() === viewer),
            epoch: epoch(),
          }),
        );
      },
    };
    return model;
  }
  return (
    <>
      <TestBunjaStoreProvider
        overrides={[
          override(managedDesktopBunja, () => {
            const model = createModel(bunja.use(DesktopDisplayIdScope));
            bunja.effect(() => {
              model.start();
              return () => model.stop();
            });
            return model;
          }),
        ]}
      >
        <button onClick={() => setActive(!active())}>
          {active() ? "Hide Screen tab" : "Show Screen tab"}
        </button>
        <div hidden={!active()}>
          <section
            aria-label="First pane"
            style={{
              height: new URLSearchParams(location.search).has("split")
                ? "calc((100dvh - 40px) / 2)"
                : "calc(100dvh - 40px)",
              "min-height": "0",
            }}
          >
            <DesktopTool active={active()} />
          </section>
          {new URLSearchParams(location.search).has("split") && (
            <section
              aria-label="Second pane"
              style={{ height: "calc((100dvh - 40px) / 2)", "min-height": "0" }}
            >
              <DesktopTool active={active()} />
            </section>
          )}
        </div>
      </TestBunjaStoreProvider>
      <output aria-label="Preview subscriptions">
        {previewSubscriptions()}
      </output>
      <output aria-label="Recorded input">{JSON.stringify(events())}</output>
    </>
  );
}
render(() => <Fixture />, document.getElementById("root")!);
