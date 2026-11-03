import "../../src/theme.css";
import { TestBunjaStoreProvider } from "./bunja-store.tsx";
import { override } from "bunja";
import { createSignal, createMemo } from "solid-js";
import { render } from "@solidjs/web";
import { desktopBunja } from "../../src/state/desktop.ts";
import { DesktopTool } from "../../src/view/workbench/tool/desktop/index.tsx";
import { bindDesktopInput } from "../../src/protocol/desktop-input.ts";
import {
  DesktopQualityVerification,
  type DesktopQualityPolicy,
  type DesktopQualitySupport,
  type DesktopConfiguration,
  type DesktopInputEvent,
} from "../../src/protocol/generated/rpc.ts";
function Fixture() {
  const [phase, setPhase] = createSignal<"idle" | "viewing">("idle");
  const [controlling, setControlling] = createSignal(false);
  const [configuration, setConfiguration] =
    createSignal<DesktopConfiguration>();
  const [events, setEvents] = createSignal<DesktopInputEvent[]>([]);
  const [outputHeight, setOutputHeight] = createSignal(1080);
  const [epoch, setEpoch] = createSignal(1);
  const display = {
    displayId: "fixture",
    bounds: { x: 0, y: 0, width: 320, height: 180 },
    scale: 1,
    dpi: 96,
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
    availabilityMessage: createMemo(() => undefined),
    outputHeight,
    maxViewports: createSignal(8)[0],
    resize: async (height: number) => {
      setOutputHeight(height);
    },
    phase,
    controlling,
    configuration,
    control: createSignal({ inputEpoch: 1 })[0],
    attachId: createSignal<string | undefined>("fixture")[0],
    displays: createSignal([display])[0],
    supported: createMemo(() => true),
    automaticDisplays: createMemo(() =>
      new URLSearchParams(location.search).has("automatic"),
    ),
    modes: createMemo(() => ({ existing: true, custom: false })),
    inputReady,
    busy: createSignal(false)[0],
    message: createSignal<string>()[0],
    stats:
      createSignal<
        import("../../src/protocol/desktop-video.ts").DesktopVideoStats
      >()[0],
    cursor:
      createSignal<
        Extract<
          import("../../src/protocol/generated/rpc.ts").DesktopEvent,
          { type: "cursor" }
        >
      >()[0],
    async connect() {
      setPhase("viewing");
      setInputReady(true);
      setConfiguration({
        totalBitrate: 1,
        layoutEpoch: 1,
        tracks: [
          {
            trackId: 1,
            codecEpoch: 1,
            codec: { codec: "fixture", hardware: false },
            viewport: {
              viewportId: "fixture",
              displayId: "fixture",
              crop: { x: 0, y: 0, width: 320, height: 180 },
              width: 320,
              height: 180,
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
    async acquire() {
      setControlling(true);
    },
    async takeover() {
      setEpoch((n) => n + 1);
      setControlling(true);
    },
    async release() {
      setControlling(false);
    },
    openWindow() {},
    registerSurface(id: string, canvas: HTMLCanvasElement) {
      return bindDesktopInput(
        canvas,
        id,
        (event) => {
          setEvents((previous) => [...previous, event]);
          return true;
        },
        () => ({ active: controlling(), epoch: epoch() }),
      );
    },
  };
  return (
    <>
      <TestBunjaStoreProvider overrides={[override(desktopBunja, () => model)]}>
        <DesktopTool />
      </TestBunjaStoreProvider>
      <output aria-label="Recorded input">{JSON.stringify(events())}</output>
    </>
  );
}
render(() => <Fixture />, document.getElementById("root")!);
