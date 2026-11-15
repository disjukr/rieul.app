import "../../src/solid/scopes.ts";
import "../../src/theme.css";
import { TestBunjaStoreProvider } from "./bunja-store.tsx";
import { bunja, override } from "bunja";
import { For, createSignal, createMemo } from "solid-js";
import { render } from "@solidjs/web";
import { useBunja } from "bunja/solid";
import {
  workbenchBunja,
  workbenchPaneBunja,
} from "../../src/state/workbench.ts";
import {
  WorkbenchPaneIdContext,
  WorkbenchTabIdContext,
} from "../../src/state/workbench-context.ts";
import { WorkbenchToolContent } from "../../src/view/workbench/tool/index.tsx";
import { AppTopbar } from "../../src/view/top-bar/app-topbar.tsx";
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
  type DesktopInputSources,
} from "../../src/protocol/generated/rpc.ts";
function cursorPng(width: number, height: number): Uint8Array {
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext("2d")!;
  ctx.fillStyle = "white";
  ctx.fillRect(0, 0, width, height);
  return Uint8Array.from(
    atob(canvas.toDataURL("image/png").split(",")[1]),
    (c) => c.charCodeAt(0),
  );
}
function Fixture() {
  const [cursorKind, setCursorKind] = createSignal("ibeam");
  const cursorShape = createMemo(() =>
    cursorKind() === "ibeam" ? cursorPng(8, 80) : cursorPng(24, 24),
  );
  const [events, setEvents] = createSignal<DesktopInputEvent[]>([]);
  const [starts, setStarts] = createSignal(0);
  const [stops, setStops] = createSignal(0);
  const [qualityActions, setQualityActions] = createSignal<string[]>([]);
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
    const [inputSources, setInputSources] = createSignal<DesktopInputSources>({
      currentId: "english",
      sources: [
        { id: "english", name: "ABC" },
        { id: "korean", name: "두벌식" },
      ],
    });
    const [inputSourceMessage, setInputSourceMessage] = createSignal<string>();
    const model = {
      inputSources: createMemo(() =>
        params.has("ime") ? inputSources() : undefined,
      ),
      inputSourceBusy: createSignal(false)[0],
      inputSourceMessage,
      async refreshInputSources() {},
      async chooseInputSource(id: string, viewer: symbol) {
        if (!controlling() || inputOwner() !== viewer) return;
        if (params.has("ime-error"))
          setInputSourceMessage("Input source change failed: fixture failure");
        else setInputSources({ ...inputSources(), currentId: id });
      },
      qualitySupported: createMemo(() =>
        new URLSearchParams(location.search).has("quality"),
      ),
      qualitySupport,
      qualityPolicy,
      qualityBusy: createMemo(() => false),
      qualityMessage: createSignal<string>()[0],
      async queryQuality() {
        setQualityActions((actions) => [...actions, "query"]);
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
        setQualityActions((actions) => [...actions, `apply-${policy.type}`]);
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
      cursor: createMemo(() =>
        params.has("cursor") && selectedDisplayId()
          ? {
              type: "cursor" as const,
              layoutEpoch: 1,
              visible: true,
              displayId: selectedDisplayId(),
              x: display.bounds.width / 2,
              y: display.bounds.height / 2,
              shape: cursorShape(),
              hotspotX: cursorKind() === "ibeam" ? 4 : 3,
              hotspotY: cursorKind() === "ibeam" ? 40 : 2,
            }
          : undefined,
      ),
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
              setStarts((value) => value + 1);
              model.start();
              return () => {
                setStops((value) => value + 1);
                model.stop();
              };
            });
            return model;
          }),
        ]}
      >
        {new URLSearchParams(location.search).has("shortcuts") ? (
          <ShortcutWorkbench />
        ) : (
          <>
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
                  style={{
                    height: "calc((100dvh - 40px) / 2)",
                    "min-height": "0",
                  }}
                >
                  <DesktopTool active={active()} />
                </section>
              )}
            </div>
          </>
        )}
      </TestBunjaStoreProvider>
      {new URLSearchParams(location.search).has("cursor") && (
        <button
          onClick={() =>
            setCursorKind(cursorKind() === "ibeam" ? "arrow" : "ibeam")
          }
        >
          Change cursor shape
        </button>
      )}
      <output aria-label="Screen lifetimes">
        {JSON.stringify({ starts: starts(), stops: stops() })}
      </output>
      <output aria-label="Preview subscriptions">
        {previewSubscriptions()}
      </output>
      <output aria-label="Recorded input">{JSON.stringify(events())}</output>
      <output hidden aria-label="Quality actions">
        {JSON.stringify(qualityActions())}
      </output>
    </>
  );
}
function ShortcutWorkbench() {
  const wb = useBunja(workbenchBunja);
  const monitors = ["fixture", "second"].map((displayId) => ({
    displayId,
    bounds: { x: 0, y: 0, width: 320, height: 180 },
    scale: 1,
    dpi: 96,
  }));
  const [displays, setDisplays] = createSignal(monitors);
  const [machineId, setMachineId] = createSignal("A");
  const machines = ["A", "B"].map((id) => ({
    id,
    name: `Fixture ${id}`,
    baseUrl: `https://${id.toLowerCase()}.invalid:9012`,
  }));
  return (
    <div
      class="app-shell"
      style={{
        display: "grid",
        "grid-template-columns": "220px minmax(0,1fr)",
        height: "100dvh",
      }}
    >
      <AppTopbar
        activeTool={wb().activeTool()}
        daemonInfo={{ phase: "idle" }}
        machine={machines.find((m) => m.id === machineId())}
        machinePanelCollapsed={false}
        machines={machines}
        panes={wb().panes()}
        selectedMachineId={machineId()}
        terminalShells={[]}
        desktopDisplays={displays()}
        onOpenDesktopDisplay={(id) => wb().openDesktopDisplay(id)}
        onRefreshDesktopDisplays={async () => {}}
        onAddMachine={() => {}}
        onOpenDaemonTab={() => {}}
        onOpenDesktopTab={() => wb().selectTool("desktop")}
        onOpenFilesTab={() => {}}
        onOpenProcessesTab={() => {}}
        onOpenTerminalTab={() => {}}
        onOpenWindowsTab={() => {}}
        onSelectTab={(pane, tab) => wb().selectTab(pane, tab)}
        onConfigureMachine={() => {}}
        onDeleteMachine={() => {}}
        onReconnectMachine={() => {}}
        onSelectMachine={setMachineId}
        onToggleMachinePanel={() => {}}
        onUnpairMachine={() => {}}
        onUpdateMachineIcon={() => {}}
      />
      <main style={{ "min-width": "0", overflow: "auto" }}>
        <button onClick={() => setDisplays(monitors.slice(0, 1))}>
          One monitor
        </button>
        <button onClick={() => setDisplays(monitors)}>Two monitors</button>
        <button onClick={() => setMachineId("B")}>Replace host</button>
        <button
          onClick={() => {
            const pane = wb()
              .panes()
              .find((p) => p.id === wb().activePaneId())!;
            wb().moveTab(
              pane.id,
              pane.activeTabId,
              pane.id === "p1" ? "p2" : "p1",
              undefined,
              "end",
            );
          }}
        >
          Move active Screen tab
        </button>
        <output aria-label="Workbench state">
          {JSON.stringify(wb().panes())}
        </output>
        <For
          each={wb()
            .panes()
            .map((pane) => pane.id)}
        >
          {(id) => (
            <WorkbenchPaneIdContext value={() => id}>
              <ShortcutPane />
            </WorkbenchPaneIdContext>
          )}
        </For>
      </main>
    </div>
  );
}
function ShortcutPane() {
  const pane = useBunja(workbenchPaneBunja);
  return (
    <section
      aria-label={`Pane ${pane().paneId}`}
      style={{ height: "400px", "min-height": "0" }}
    >
      <button onClick={() => pane().focusPane()}>Focus {pane().paneId}</button>
      <For
        each={pane()
          .pane()
          ?.tabs.map((tab) => tab.id)}
      >
        {(id) => (
          <WorkbenchTabIdContext value={() => id}>
            <div
              hidden={pane().pane()?.activeTabId !== id}
              style={{ height: "350px" }}
            >
              <WorkbenchToolContent />
            </div>
          </WorkbenchTabIdContext>
        )}
      </For>
    </section>
  );
}
if (new URLSearchParams(location.search).has("shortcuts")) {
  localStorage.setItem(
    "rieul.workbench.none.v1",
    JSON.stringify({
      activePaneId: "p1",
      layout: {
        rootId: "root",
        nodes: {
          root: {
            type: "branch",
            id: "root",
            direction: "horizontal",
            children: ["n1", "n2"],
            ratios: [0.5, 0.5],
          },
          n1: { type: "leaf", id: "n1", paneId: "p1" },
          n2: { type: "leaf", id: "n2", paneId: "p2" },
        },
      },
      panes: ["p1", "p2"].map((id) => ({
        id,
        activeTabId: `${id}-placeholder`,
        tabs: [
          { id: `${id}-placeholder`, title: "Placeholder", tool: "agent" },
        ],
      })),
    }),
  );
}
render(() => <Fixture />, document.getElementById("root")!);
