import { test, mock } from "node:test";
import assert from "node:assert/strict";
import { createBunjaStore, createReadScopeFn, override } from "bunja";
import { createRoot, createSignal, flush as flushSolid } from "solid-js";
import * as client from "../src/protocol/generated/client.ts";
import {
  DesktopAvailability,
  DesktopControlAction,
  ProcId,
  type DesktopEvent,
  type ConfigureDesktopViewportsReq,
  type SelectExistingDesktopReq,
  type DesktopConfiguration,
  type DesktopQualitySupport,
  type AttachDesktopReq,
  type DesktopInputEvent,
} from "../src/protocol/generated/rpc.ts";
import { DesktopDisplayIdScope } from "../src/state/desktop-scopes.ts";
import { MachineIdScope } from "../src/state/machine-scopes.ts";
import { rpcSessionStub } from "./helpers/rpc-session.ts";
import type { DesktopVideoStats } from "../src/protocol/desktop-video.ts";
import { RpcError } from "../src/protocol/client.ts";
const displays = ["first", "second"].map((displayId) => ({
  displayId,
  bounds: { x: 0, y: 0, width: 1280, height: 720 },
  scale: 1,
  dpi: 96,
}));
const configurations: ConfigureDesktopViewportsReq[] = [];
const selections: SelectExistingDesktopReq[] = [];
const inputBindings = new WeakMap<
  HTMLCanvasElement,
  () => { active: boolean }
>();
const renderers = new Map<
  string,
  (viewportId: string, frame: VideoFrame) => boolean
>();
const feedbackReceivers = new Map<string, (stats: DesktopVideoStats) => void>();
const sentInput: { attachId: string; event: DesktopInputEvent }[] = [];
let stripeCodec = false;
const fixtureCodec = () => (stripeCodec ? "avc1.fixture" : "fixture");
let encoderCapacity = Infinity;
let beforePreviewConfigure:
  | ((request: ConfigureDesktopViewportsReq) => Promise<void>)
  | undefined;
const encoderSlots = new Map<string, number>();
const attachedProfiles = new Map<string, number>();
function reserveEncoderSlots(id: string, slots: number) {
  if (!Number.isFinite(encoderCapacity)) return;
  const total =
    [...encoderSlots.values()].reduce((sum, value) => sum + value, 0) -
    (encoderSlots.get(id) ?? 0) +
    slots;
  if (total > encoderCapacity)
    throw new RpcError("limitExceeded", "Synthetic encoder capacity reached");
  encoderSlots.set(id, slots);
}
let receiverCount = 0;
let queryCount = 0;
let capabilityError: Error | undefined;
let releaseError = false;
let flushError: boolean | Error = false;
let configureReceiver:
  | ((configuration: DesktopConfiguration) => Promise<void>)
  | undefined;
let queryResponse: (() => Promise<DesktopQualitySupport>) | undefined;
let applyResponse: (() => Promise<DesktopConfiguration>) | undefined;
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
const controls: { attachId: string; action: DesktopControlAction }[] = [];
const detached: string[] = [];
const streams = new Map<
  string,
  { signal: AbortSignal; push: (event: DesktopEvent | undefined) => void }
>();
let sequence = 0,
  codecEpoch = 0;
mock.module("../src/protocol/generated/client.ts", {
  namedExports: {
    ...client,
    getDesktopCapabilities: async () => {
      if (capabilityError) throw capabilityError;
      return {
        profile: 1,
        capture: DesktopAvailability.Available,
        input: DesktopAvailability.Available,
        codecs: [{ codec: fixtureCodec(), hardware: false }],
        supportedProfiles: [1, 2],
        maxViewports: 8,
        feedback: true,
      };
    },
    configureDesktopViewports: async (
      _: unknown,
      request: ConfigureDesktopViewportsReq,
    ) => {
      configurations.push(request);
      await beforePreviewConfigure?.(request);
      reserveEncoderSlots(request.attachId, request.viewports.length);
      const epoch = ++codecEpoch;
      return {
        layoutEpoch: request.layoutEpoch,
        totalBitrate: request.totalBitrate,
        tracks: request.viewports.map((viewport, index) => ({
          trackId: index + 1,
          codecEpoch: epoch,
          codec: { codec: fixtureCodec(), hardware: false },
          viewport,
        })),
      };
    },
    selectExistingDesktop: async (
      _: unknown,
      request: SelectExistingDesktopReq,
    ) => {
      selections.push(request);
      const selection = request.selection;
      const chosen =
        selection.type === "display"
          ? displays.find((d) => d.displayId === selection.displayId)
          : undefined;
      reserveEncoderSlots(request.attachId, chosen ? (stripeCodec ? 2 : 1) : 0);
      const epoch = ++codecEpoch;
      return {
        layoutEpoch: request.expectedLayoutEpoch,
        totalBitrate: 20_000_000,
        tracks: chosen
          ? [
              {
                trackId: 1,
                codecEpoch: epoch,
                codec: { codec: fixtureCodec(), hardware: false },
                viewport: {
                  viewportId: chosen.displayId,
                  displayId: chosen.displayId,
                  crop: chosen.bounds,
                  width: 1280,
                  height: 720,
                  fps: 60,
                  bitrate: 20_000_000,
                },
              },
            ]
          : [],
      };
    },
    queryDesktopQualitySupport: async () => {
      queryCount++;
      if (queryResponse) return queryResponse();
      return {
        layoutEpoch: 1,
        revision: 1,
        automaticAvailable: true,
        concurrentThroughputVerified: true,
        candidates: [],
        policy: { type: "auto" },
      };
    },
    setDesktopQuality: async () =>
      applyResponse
        ? applyResponse()
        : { layoutEpoch: 1, totalBitrate: 1, tracks: [] },
    setDesktopControl: async (
      _: unknown,
      request: { attachId: string; action: DesktopControlAction },
    ) => {
      controls.push(request);
      if (releaseError && request.action === DesktopControlAction.Release)
        throw new Error("Release failed");
      return {
        inputEpoch: controls.length,
        holderAttachId:
          request.action === DesktopControlAction.Release
            ? undefined
            : request.attachId,
      };
    },
    detachDesktop: async (_: unknown, request: { attachId: string }) => {
      detached.push(request.attachId);
      encoderSlots.delete(request.attachId);
    },
    renewDesktopLease: async () => ({ remainingMs: 15000 }),
  },
});
mock.module("../src/protocol/desktop-session.ts", {
  namedExports: {
    desktopEvents: async function* (
      _transport: unknown,
      request: AttachDesktopReq,
      signal: AbortSignal,
      proc: number,
    ) {
      assert.equal(proc, ProcId.AttachDesktop);
      const id = `catalog-${++sequence}`;
      attachedProfiles.set(id, request.profile);
      const queue: (DesktopEvent | undefined)[] = [];
      let wake: (() => void) | undefined;
      const push = (event: DesktopEvent | undefined) => {
        queue.push(event);
        wake?.();
      };
      streams.set(id, { signal, push });
      signal.addEventListener("abort", () => push(undefined), { once: true });
      yield {
        type: "attached",
        attachId: id,
        layoutEpoch: 1,
        displays,
        control: { inputEpoch: 1 },
        leaseMs: 15000,
      } satisfies DesktopEvent;
      for (;;) {
        if (!queue.length)
          await new Promise<void>((resolve) => {
            wake = resolve;
          });
        const event = queue.shift();
        if (!event) return;
        yield event;
      }
    },
  },
});
mock.module("../src/protocol/desktop-input.ts", {
  namedExports: {
    DesktopInputChannel: class {
      constructor(
        _transport: unknown,
        private attachId: string,
      ) {}
      abort() {}
      send(event: DesktopInputEvent) {
        sentInput.push({ attachId: this.attachId, event });
        return true;
      }
      async flush() {
        if (flushError)
          throw flushError instanceof Error
            ? flushError
            : new Error("Flush failed");
      }
    },
    bindDesktopInput: (
      canvas: HTMLCanvasElement,
      _viewport: string,
      _send: unknown,
      control: () => { active: boolean },
    ) => {
      inputBindings.set(canvas, control);
      return () => inputBindings.delete(canvas);
    },
  },
});
mock.module("../src/protocol/desktop-video.ts", {
  namedExports: {
    supportedDesktopCodecs: async () => [fixtureCodec()],
    DesktopVideoReceiver: class {
      constructor(
        _transport: unknown,
        attachId: string,
        render: (viewportId: string, frame: VideoFrame) => boolean,
        feedback: (stats: DesktopVideoStats) => void,
      ) {
        receiverCount++;
        renderers.set(attachId, render);
        feedbackReceivers.set(attachId, feedback);
      }
      prepareConfiguration() {}
      requestRefresh() {}
      async configure(configuration: DesktopConfiguration) {
        await configureReceiver?.(configuration);
      }
      close() {}
    },
  },
});
const { rpcSessionBunja } = await import("../src/state/rpc-session.ts");
const { desktopBunja, managedDesktopBunja } = await import(
  "../src/state/desktop.ts"
);
async function flush() {
  for (let i = 0; i < 80; i++) {
    flushSolid();
    await Promise.resolve();
  }
}
function fixture(scoped = false) {
  const store = createBunjaStore({
    wrapInstance: (init) => createRoot(init),
    overrides: [
      override(rpcSessionBunja, () =>
        rpcSessionStub({
          daemonInfo: createSignal({
            phase: "ready" as const,
            receivedAtMs: 0,
            daemonInfo: {
              instanceId: "catalog",
              version: "1",
              os: "macos",
              startedAtMs: 0,
              serverTimeMs: 0,
              supportedProcIds: [
                ...(scoped ? [ProcId.SelectExistingDesktop] : []),
                ProcId.GetDesktopCapabilities,
                ProcId.AttachDesktop,
                ProcId.ConfigureDesktopViewports,
                ProcId.AttachExistingDesktop,
                ProcId.QueryDesktopQualitySupport,
                ProcId.SetDesktopQuality,
              ],
            },
          })[0],
          webTransport: async () => ({}) as WebTransport,
        }),
      ),
    ],
  });
  const cleanups: (() => void)[] = [];
  return {
    tab(id: string) {
      const entry = store.get(
        desktopBunja,
        createReadScopeFn(
          [[DesktopDisplayIdScope, id]],
          () => undefined as never,
        ),
      );
      cleanups.push(entry.mount());
      return entry.value;
    },
    consumer(displayId: string | undefined, machineId = "machine") {
      const entry = store.get(
        managedDesktopBunja,
        createReadScopeFn(
          [
            [DesktopDisplayIdScope, displayId],
            [MachineIdScope, machineId],
          ],
          () => undefined as never,
        ),
      );
      let stop: (() => void) | undefined = entry.mount();
      const release = () => {
        stop?.();
        stop = undefined;
      };
      cleanups.push(release);
      return { value: entry.value, release };
    },
    close() {
      for (const cleanup of cleanups) cleanup();
      store.dispose();
    },
  };
}
test("managed Screen discovers without media or control and selects only one display", async () => {
  configurations.length = controls.length = detached.length = 0;
  const f = fixture(),
    screen = f.tab("one");
  try {
    screen.start();
    await flush();
    assert.equal(screen.phase(), "viewing");
    assert.deepEqual(screen.displays(), displays);
    assert.equal(screen.configuration(), undefined);
    assert.equal(configurations.length, 0);
    assert.equal(controls.length, 0);
    assert.equal(screen.qualitySupported(), false);
    await screen.selectDisplay("second");
    assert.deepEqual(
      configurations.at(-1)?.viewports.map((v) => v.displayId),
      ["second"],
    );
    assert.equal(screen.selectedDisplayId(), "second");
    assert.equal(screen.controlling(), false);
    await screen.acquire();
    assert.equal(screen.controlling(), true);
    await screen.leaveDisplay();
    assert.equal(screen.selectedDisplayId(), undefined);
    assert.equal(controls.at(-1)?.action, DesktopControlAction.Release);
    assert.deepEqual(configurations.at(-1)?.viewports, []);
    assert.equal(screen.controlling(), false);
    assert.equal(detached.length, 0);
  } finally {
    f.close();
  }
});
test("separate tabs retain selection but never authority across hide and show", async () => {
  const f = fixture(),
    first = f.tab("first"),
    second = f.tab("second");
  try {
    first.start();
    second.start();
    await flush();
    assert.notEqual(first, second);
    assert.notEqual(first.attachId(), second.attachId());
    await first.selectDisplay("first");
    await second.selectDisplay("second");
    await first.acquire();
    const secondAttach = second.attachId(),
      firstAttach = first.attachId()!;
    first.stop();
    await flush();
    assert.equal(streams.get(firstAttach)?.signal.aborted, true);
    assert.equal(streams.get(secondAttach!)?.signal.aborted, false);
    assert.equal(second.attachId(), secondAttach);
    assert.equal(second.selectedDisplayId(), "second");
    assert.equal(first.selectedDisplayId(), "first");
    first.start();
    await flush();
    assert.equal(first.selectedDisplayId(), "first");
    assert.equal(first.controlling(), false);
    assert.notEqual(first.attachId(), firstAttach);
    assert.deepEqual(
      first.configuration()?.tracks.map((t) => t.viewport.displayId),
      ["first"],
    );
  } finally {
    f.close();
  }
});
test("removing selected display returns to catalog and never substitutes a different monitor", async () => {
  const f = fixture(),
    screen = f.tab("hotplug");
  try {
    screen.start();
    await flush();
    await screen.selectDisplay("second");
    await screen.acquire();
    streams
      .get(screen.attachId()!)!
      .push({ type: "layout", layoutEpoch: 2, displays: [displays[0]!] });
    await flush();
    assert.equal(screen.selectedDisplayId(), undefined);
    assert.equal(screen.controlling(), false);
    assert.deepEqual(screen.configuration()?.tracks, []);
    assert.match(screen.message()!, /disconnected/);
    assert.deepEqual(configurations.at(-1)?.viewports, []);
  } finally {
    f.close();
  }
});

test("additive scoped selection preserves daemon-owned geometry and automatic quality", async () => {
  selections.length = 0;
  const before = configurations.length;
  const f = fixture(true),
    screen = f.tab("scoped");
  try {
    screen.start();
    await flush();
    assert.equal(selections.length, 0);
    assert.equal(screen.qualitySupported(), true);
    assert.equal(screen.serverOwnsGeometry(), true);
    await screen.selectDisplay("second");
    assert.deepEqual(selections.at(-1)?.selection, {
      type: "display",
      displayId: "second",
    });
    assert.equal(configurations.length, before);
    await screen.queryQuality();
    assert.equal(queryCount, 1);
    assert.equal(screen.qualitySupport()?.automaticAvailable, true);
    const oldConfiguration = screen.configuration()!;
    await screen.leaveDisplay();
    streams
      .get(screen.attachId()!)!
      .push({ type: "configured", configuration: oldConfiguration });
    await flush();
    assert.deepEqual(selections.at(-1)?.selection, { type: "clear" });
    assert.equal(screen.selectedDisplayId(), undefined);
    assert.deepEqual(screen.configuration()?.tracks, []);
  } finally {
    f.close();
  }
});

test("transient retry preserves only the selected monitor, adds jitter and never restores control", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  t.mock.method(Math, "random", () => 0.75);
  const f = fixture(),
    screen = f.tab("retry");
  try {
    screen.start();
    await flush();
    await screen.selectDisplay("second");
    await screen.acquire();
    const firstAttach = screen.attachId()!,
      actions = controls.length;
    streams.get(firstAttach)!.push(undefined);
    await flush();
    assert.equal(screen.phase(), "error");
    assert.equal(screen.selectedDisplayId(), "second");
    assert.equal(screen.controlling(), false);
    t.mock.timers.tick(1099);
    await flush();
    assert.equal(screen.attachId(), undefined);
    t.mock.timers.tick(1);
    await flush();
    assert.notEqual(screen.attachId(), firstAttach);
    assert.equal(screen.selectedDisplayId(), "second");
    assert.deepEqual(
      screen.configuration()?.tracks.map((track) => track.viewport.displayId),
      ["second"],
    );
    assert.equal(screen.controlling(), false);
    assert.equal(controls.length, actions);
    const nextAttach = screen.attachId()!;
    streams.get(nextAttach)!.push(undefined);
    await flush();
    screen.stop();
    await flush();
    const attempts = sequence;
    t.mock.timers.tick(20_000);
    await flush();
    assert.equal(sequence, attempts);
  } finally {
    f.close();
  }
});
for (const code of [
  "permissionDenied",
  "unauthorized",
  "invalidCredentials",
] as const) {
  test(`${code} stops automatic recovery without opening another attachment`, async (t) => {
    t.mock.timers.enable({ apis: ["setTimeout"] });
    const f = fixture(),
      screen = f.tab(code),
      attempts = sequence;
    capabilityError = new RpcError(code, "User action is required");
    try {
      screen.start();
      await flush();
      assert.equal(screen.phase(), "error");
      assert.equal(screen.controlling(), false);
      t.mock.timers.tick(60_000);
      await flush();
      assert.equal(sequence, attempts);
      assert.match(screen.message()!, /User action/);
    } finally {
      capabilityError = undefined;
      f.close();
    }
  });
}

test("Back detaches instead of retaining authority when release acknowledgement fails", async () => {
  const f = fixture(),
    screen = f.tab("release-failure");
  try {
    screen.start();
    await flush();
    await screen.selectDisplay("first");
    await screen.acquire();
    const oldAttach = screen.attachId()!;
    releaseError = true;
    await screen.leaveDisplay();
    await flush();
    assert.equal(detached.includes(oldAttach), true);
    assert.equal(screen.selectedDisplayId(), undefined);
    assert.equal(screen.controlling(), false);
    assert.notEqual(screen.attachId(), oldAttach);
  } finally {
    releaseError = false;
    f.close();
  }
});

for (const replacement of [false, true]) {
  test(`late decoder configuration cannot restore a monitor after Back${replacement ? " and new selection" : ""}`, async () => {
    const f = fixture(true),
      screen = f.tab(`late-${replacement}`);
    const pending = deferred<void>();
    try {
      screen.start();
      await flush();
      await screen.selectDisplay("first");
      const old = {
        ...screen.configuration()!,
        tracks: screen
          .configuration()!
          .tracks.map((track) => ({ ...track, codecEpoch: ++codecEpoch })),
      };
      configureReceiver = async (next) => {
        if (next === old) await pending.promise;
      };
      streams
        .get(screen.attachId()!)!
        .push({ type: "configured", configuration: old });
      await flush();
      await screen.leaveDisplay();
      if (replacement) await screen.selectDisplay("second");
      const expected = screen.configuration();
      pending.resolve();
      await flush();
      assert.equal(screen.configuration(), expected);
      assert.equal(
        screen.selectedDisplayId(),
        replacement ? "second" : undefined,
      );
      assert.deepEqual(
        screen.configuration()?.tracks.map((track) => track.viewport.displayId),
        replacement ? ["second"] : [],
      );
    } finally {
      pending.resolve();
      configureReceiver = undefined;
      f.close();
    }
  });
}
test("quality query and apply results cannot cross selected-monitor lifetimes", async () => {
  const f = fixture(true),
    screen = f.tab("late-quality");
  const pendingQuery = deferred<DesktopQualitySupport>(),
    pendingApply = deferred<DesktopConfiguration>();
  const support = (revision: number): DesktopQualitySupport => ({
    layoutEpoch: 1,
    revision,
    automaticAvailable: true,
    concurrentThroughputVerified: true,
    candidates: [],
    policy: { type: "auto" },
  });
  try {
    screen.start();
    await flush();
    await screen.selectDisplay("first");
    queryResponse = () => pendingQuery.promise;
    const oldQuery = screen.queryQuality();
    await flush();
    await screen.leaveDisplay();
    await screen.selectDisplay("second");
    queryResponse = async () => support(20);
    await screen.queryQuality();
    pendingQuery.resolve(support(10));
    await oldQuery;
    assert.equal(screen.qualitySupport()?.revision, 20);
    assert.equal(screen.qualityBusy(), false);
    applyResponse = () => pendingApply.promise;
    const oldApply = screen.applyQuality({
      type: "manual",
      target: { fps: 30, totalBitrate: 1_000_000 },
    });
    await flush();
    await screen.leaveDisplay();
    await screen.selectDisplay("first");
    queryResponse = async () => support(30);
    await screen.queryQuality();
    pendingApply.resolve({ layoutEpoch: 1, totalBitrate: 1, tracks: [] });
    await oldApply;
    assert.equal(screen.qualitySupport()?.revision, 30);
    assert.equal(screen.qualityPolicy()?.type, "auto");
    assert.equal(screen.qualityBusy(), false);
  } finally {
    pendingQuery.resolve(support(0));
    pendingApply.resolve({ layoutEpoch: 1, totalBitrate: 1, tracks: [] });
    queryResponse = undefined;
    applyResponse = undefined;
    f.close();
  }
});

test("same monitor consumers share one capture and frame fan-out until the final viewer leaves", async () => {
  const f = fixture(true),
    beforeReceivers = receiverCount;
  const first = f.consumer("first"),
    second = f.consumer("first");
  const owner = Symbol("owner"),
    mirror = Symbol("mirror");
  const drawn: VideoFrame[][] = [[], []];
  const canvas = (index: number) =>
    ({
      isConnected: true,
      width: 1280,
      height: 720,
      addEventListener() {},
      removeEventListener() {},
      getContext: () => ({
        drawImage: (frame: VideoFrame) => drawn[index]!.push(frame),
      }),
    }) as unknown as HTMLCanvasElement;
  try {
    await flush();
    assert.equal(first.value, second.value);
    assert.equal(receiverCount - beforeReceivers, 1);
    const session = first.value,
      attachId = session.attachId()!;
    const removeOwner = session.registerViewer(owner),
      removeMirror = session.registerViewer(mirror);
    const firstCanvas = canvas(0),
      secondCanvas = canvas(1);
    const removeFirst = session.registerSurface("first", firstCanvas, owner),
      removeSecond = session.registerSurface("first", secondCanvas, mirror);
    const frame = {} as VideoFrame;
    renderers.get(attachId)!("first", frame);
    assert.deepEqual(drawn, [[frame], [frame]]);
    await session.acquire(owner);
    assert.equal(session.ownsInput(owner), true);
    assert.equal(inputBindings.get(firstCanvas)!().active, true);
    assert.equal(inputBindings.get(secondCanvas)!().active, false);
    const actions = controls.length;
    removeMirror();
    removeSecond();
    second.release();
    await flush();
    assert.equal(session.attachId(), attachId);
    assert.equal(streams.get(attachId)!.signal.aborted, false);
    assert.equal(controls.length, actions);
    assert.equal(session.controlling(), true);
    renderers.get(attachId)!("first", frame);
    assert.deepEqual(drawn, [[frame, frame], [frame]]);
    removeOwner();
    removeFirst();
    await flush();
    assert.equal(controls.at(-1)?.action, DesktopControlAction.Release);
    assert.equal(session.controlling(), false);
    first.release();
    await flush();
    assert.equal(streams.get(attachId)!.signal.aborted, true);
    assert.equal(detached.includes(attachId), true);
  } finally {
    f.close();
  }
});
test("display, machine and store scopes isolate shared monitor sessions", async () => {
  const f = fixture(true),
    otherStore = fixture(true);
  const first = f.consumer("first", "machine-a"),
    otherDisplay = f.consumer("second", "machine-a"),
    otherMachine = f.consumer("first", "machine-b"),
    other = otherStore.consumer("first", "machine-a");
  try {
    await flush();
    assert.equal(
      new Set([
        first.value,
        otherDisplay.value,
        otherMachine.value,
        other.value,
      ]).size,
      4,
    );
    assert.equal(
      new Set([
        first.value.attachId(),
        otherDisplay.value.attachId(),
        otherMachine.value.attachId(),
        other.value.attachId(),
      ]).size,
      4,
    );
    first.release();
    await flush();
    assert.equal(otherDisplay.value.phase(), "viewing");
    assert.equal(otherMachine.value.phase(), "viewing");
    assert.equal(other.value.phase(), "viewing");
  } finally {
    f.close();
    otherStore.close();
  }
});

for (const failure of ["release", "flush"]) {
  test(`owner removal fails closed on ${failure} rejection while mirror survives`, async (t) => {
    t.mock.timers.enable({ apis: ["setTimeout"] });
    t.mock.method(Math, "random", () => 0.5);
    const f = fixture(true),
      ownerView = f.consumer("first"),
      mirrorView = f.consumer("first");
    try {
      await flush();
      const session = ownerView.value,
        owner = Symbol("owner"),
        mirror = Symbol("mirror");
      assert.equal(mirrorView.value, session);
      const removeOwner = session.registerViewer(owner),
        removeMirror = session.registerViewer(mirror);
      await session.acquire(owner);
      const oldAttach = session.attachId()!,
        actions = controls.length;
      releaseError = failure === "release";
      flushError = failure === "flush";
      removeOwner();
      ownerView.release();
      await flush();
      assert.equal(session.attachId(), undefined);
      assert.equal(detached.includes(oldAttach), true);
      assert.equal(streams.get(oldAttach)!.signal.aborted, true);
      assert.equal(session.controlling(), false);
      assert.equal(session.ownsInput(mirror), false);
      releaseError = flushError = false;
      t.mock.timers.tick(1000);
      await flush();
      assert.notEqual(session.attachId(), oldAttach);
      assert.equal(session.selectedDisplayId(), "first");
      assert.equal(session.controlling(), false);
      assert.equal(session.ownsInput(mirror), false);
      assert.equal(
        controls
          .slice(actions)
          .some((action) => action.action !== DesktopControlAction.Release),
        false,
      );
      removeMirror();
    } finally {
      releaseError = flushError = false;
      f.close();
    }
  });
}

test("catalog previews use one bounded legacy attachment without control or canvas input", async () => {
  const f = fixture(true),
    catalog = f.consumer(undefined);
  const beforeControls = controls.length,
    beforeSelections = selections.length;
  const canvases = displays.map(
    () =>
      ({
        isConnected: true,
        width: 320,
        height: 180,
        getContext: () => ({ drawImage() {} }),
      }) as unknown as HTMLCanvasElement,
  );
  const stops: (() => void)[] = [];
  try {
    await flush();
    const id = catalog.value.attachId()!;
    for (let i = 0; i < displays.length; i++)
      stops.push(
        catalog.value.registerPreviewSurface(
          displays[i]!.displayId,
          canvases[i]!,
        ),
      );
    await flush();
    const request = configurations.at(-1)!;
    assert.equal(request.attachId, id);
    assert.equal(request.viewports.length, 2);
    assert.equal(request.totalBitrate, 250_000);
    for (const viewport of request.viewports) {
      assert.equal(viewport.fps, 1);
      assert.ok(viewport.width <= 320 && viewport.height <= 180);
      assert.equal(viewport.bitrate, 125_000);
      assert.deepEqual(
        viewport.crop,
        displays.find((display) => display.displayId === viewport.displayId)!
          .bounds,
      );
    }
    await catalog.value.acquire();
    await catalog.value.takeover();
    assert.equal(controls.length, beforeControls);
    assert.equal(selections.length, beforeSelections);
    assert.equal(
      canvases.some((canvas) => inputBindings.has(canvas)),
      false,
    );
    for (const stop of stops.splice(0)) stop();
    await flush();
    assert.deepEqual(configurations.at(-1)?.viewports, []);
    assert.equal(catalog.value.attachId(), id);
    catalog.release();
    await flush();
    assert.equal(detached.includes(id), true);
  } finally {
    for (const stop of stops) stop();
    f.close();
  }
});
test("catalog preview reuses only a usable full publisher and resumes low-rate capture after its failure", async (t) => {
  let now = 0;
  t.mock.method(performance, "now", () => now);
  const f = fixture(true),
    catalog = f.consumer(undefined),
    full = f.consumer("first");
  let previewDraws = 0,
    fullDraws = 0;
  const previewCanvas = {
    isConnected: true,
    width: 320,
    height: 180,
    getContext: () => ({
      drawImage() {
        previewDraws++;
      },
    }),
  } as unknown as HTMLCanvasElement;
  const fullCanvas = {
    isConnected: true,
    width: 1280,
    height: 720,
    addEventListener() {},
    removeEventListener() {},
    getContext: () => ({
      drawImage() {
        fullDraws++;
      },
    }),
  } as unknown as HTMLCanvasElement;
  let stopPreview: (() => void) | undefined,
    stopSurface: (() => void) | undefined;
  try {
    await flush();
    stopPreview = catalog.value.registerPreviewSurface("first", previewCanvas);
    await flush();
    assert.deepEqual(
      configurations.at(-1)?.viewports.map((viewport) => viewport.displayId),
      ["first"],
    );
    stopSurface = full.value.registerSurface("first", fullCanvas);
    const fullId = full.value.attachId()!;
    renderers.get(fullId)!("first", {} as VideoFrame);
    await flush();
    assert.equal(previewDraws, 1);
    assert.equal(fullDraws, 1);
    assert.deepEqual(configurations.at(-1)?.viewports, []);
    now = 500;
    renderers.get(fullId)!("first", {} as VideoFrame);
    assert.equal(previewDraws, 1);
    assert.equal(fullDraws, 2);
    now = 1000;
    renderers.get(fullId)!("first", {} as VideoFrame);
    assert.equal(previewDraws, 2);
    assert.equal(fullDraws, 3);
    streams.get(fullId)!.push(undefined);
    await flush();
    assert.deepEqual(
      configurations.at(-1)?.viewports.map((viewport) => viewport.displayId),
      ["first"],
    );
    assert.equal(configurations.at(-1)?.viewports[0]?.fps, 1);
  } finally {
    stopSurface?.();
    stopPreview?.();
    f.close();
  }
});
test("visible catalog demand is capped at eight exact monitor IDs and advances when one leaves", async () => {
  const f = fixture(true),
    catalog = f.consumer(undefined),
    stops: (() => void)[] = [];
  try {
    await flush();
    const many = Array.from({ length: 9 }, (_, index) => ({
      ...displays[0]!,
      displayId: `opaque-monitor-${index}`,
    }));
    streams
      .get(catalog.value.attachId()!)!
      .push({ type: "layout", layoutEpoch: 2, displays: many });
    await flush();
    for (const display of many)
      stops.push(
        catalog.value.registerPreviewSurface(display.displayId, {
          isConnected: true,
          width: 320,
          height: 180,
          getContext: () => ({ drawImage() {} }),
        } as unknown as HTMLCanvasElement),
      );
    await flush();
    assert.equal(catalog.value.displays().length, 9);
    assert.deepEqual(
      configurations.at(-1)?.viewports.map((viewport) => viewport.displayId),
      many.slice(0, 8).map((display) => display.displayId),
    );
    assert.equal(configurations.at(-1)?.totalBitrate, 1_000_000);
    stops.shift()!();
    await flush();
    assert.deepEqual(
      configurations.at(-1)?.viewports.map((viewport) => viewport.displayId),
      many.slice(1).map((display) => display.displayId),
    );
  } finally {
    for (const stop of stops) stop();
    f.close();
  }
});

test("a broken preview canvas cannot interrupt a full monitor renderer", async () => {
  const f = fixture(true),
    catalog = f.consumer(undefined),
    full = f.consumer("first");
  let fullDraws = 0;
  let stopPreview: (() => void) | undefined,
    stopSurface: (() => void) | undefined;
  try {
    await flush();
    stopPreview = catalog.value.registerPreviewSurface("first", {
      isConnected: true,
      width: 320,
      height: 180,
      getContext: () => ({
        drawImage() {
          throw new Error("Detached preview context");
        },
      }),
    } as unknown as HTMLCanvasElement);
    stopSurface = full.value.registerSurface("first", {
      isConnected: true,
      width: 1280,
      height: 720,
      addEventListener() {},
      removeEventListener() {},
      getContext: () => ({
        drawImage() {
          fullDraws++;
        },
      }),
    } as unknown as HTMLCanvasElement);
    assert.doesNotThrow(() =>
      renderers.get(full.value.attachId()!)!("first", {} as VideoFrame),
    );
    assert.equal(fullDraws, 1);
    assert.equal(full.value.phase(), "viewing");
    let replacementDraws = 0;
    const replacementStop = catalog.value.registerPreviewSurface("first", {
      isConnected: true,
      width: 320,
      height: 180,
      getContext: () => ({
        drawImage() {
          replacementDraws++;
        },
      }),
    } as unknown as HTMLCanvasElement);
    stopPreview();
    stopPreview = replacementStop;
    renderers.get(full.value.attachId()!)!("first", {} as VideoFrame);
    assert.equal(replacementDraws, 1);
  } finally {
    stopSurface?.();
    stopPreview?.();
    f.close();
  }
});

test("catalog preview reconfigures a retained monitor ID after its source geometry changes", async () => {
  const f = fixture(true),
    catalog = f.consumer(undefined);
  let stop: (() => void) | undefined;
  try {
    await flush();
    stop = catalog.value.registerPreviewSurface("first", {
      isConnected: true,
      width: 320,
      height: 180,
      getContext: () => ({ drawImage() {} }),
    } as unknown as HTMLCanvasElement);
    await flush();
    const before = configurations.length;
    streams.get(catalog.value.attachId()!)!.push({
      type: "layout",
      layoutEpoch: 2,
      displays: [
        {
          ...displays[0]!,
          bounds: { x: -720, y: 200, width: 720, height: 1280 },
        },
      ],
    });
    await flush();
    assert.ok(configurations.length > before);
    assert.equal(configurations.at(-1)?.layoutEpoch, 2);
    assert.deepEqual(configurations.at(-1)?.viewports[0]?.crop, {
      x: 0,
      y: 0,
      width: 720,
      height: 1280,
    });
    assert.equal(configurations.at(-1)?.viewports[0]?.height, 180);
    assert.ok(configurations.at(-1)!.viewports[0]!.width < 180);
  } finally {
    stop?.();
    f.close();
  }
});

for (const failure of ["context", "surface"]) {
  test(`catalog preview resumes when a usable full publisher loses its ${failure}`, async () => {
    const f = fixture(true),
      catalog = f.consumer(undefined),
      full = f.consumer("first");
    let lost = false;
    let stopPreview: (() => void) | undefined,
      stopSurface: (() => void) | undefined;
    try {
      await flush();
      stopPreview = catalog.value.registerPreviewSurface("first", {
        isConnected: true,
        width: 320,
        height: 180,
        getContext: () => ({ drawImage() {} }),
      } as unknown as HTMLCanvasElement);
      await flush();
      stopSurface = full.value.registerSurface("first", {
        isConnected: true,
        width: 1280,
        height: 720,
        addEventListener() {},
        removeEventListener() {},
        getContext: () => ({ isContextLost: () => lost, drawImage() {} }),
      } as unknown as HTMLCanvasElement);
      renderers.get(full.value.attachId()!)!("first", {} as VideoFrame);
      await flush();
      assert.deepEqual(configurations.at(-1)?.viewports, []);
      if (failure === "surface") {
        stopSurface();
        stopSurface = undefined;
      } else {
        lost = true;
        assert.equal(
          renderers.get(full.value.attachId()!)!("first", {} as VideoFrame),
          false,
        );
      }
      await flush();
      assert.deepEqual(
        configurations.at(-1)?.viewports.map((viewport) => viewport.displayId),
        ["first"],
      );
      assert.equal(configurations.at(-1)?.viewports[0]?.fps, 1);
    } finally {
      stopSurface?.();
      stopPreview?.();
      f.close();
    }
  });
}

test("eight previews yield encoder headroom to one shared profile2 selection without local starvation", async () => {
  const oldOffscreen = Object.getOwnPropertyDescriptor(
    globalThis,
    "OffscreenCanvas",
  );
  Object.defineProperty(globalThis, "OffscreenCanvas", {
    configurable: true,
    value: class {},
  });
  stripeCodec = true;
  encoderCapacity = 8;
  encoderSlots.clear();
  const f = fixture(true),
    catalog = f.consumer(undefined),
    stops: (() => void)[] = [];
  try {
    await flush();
    const many = [
      ...displays,
      ...Array.from({ length: 6 }, (_, index) => ({
        ...displays[0]!,
        displayId: `other-${index}`,
      })),
    ];
    streams
      .get(catalog.value.attachId()!)!
      .push({ type: "layout", layoutEpoch: 2, displays: many });
    await flush();
    for (const display of many)
      stops.push(
        catalog.value.registerPreviewSurface(display.displayId, {
          isConnected: true,
          width: 320,
          height: 180,
          getContext: () => ({ drawImage() {} }),
        } as unknown as HTMLCanvasElement),
      );
    await flush();
    const catalogId = catalog.value.attachId()!;
    assert.equal(attachedProfiles.get(catalogId), 1);
    assert.equal(encoderSlots.get(catalogId), 8);
    const full = f.consumer("first"),
      mirror = f.consumer("first");
    await flush();
    assert.equal(full.value, mirror.value);
    assert.equal(full.value.phase(), "viewing");
    assert.equal(attachedProfiles.get(full.value.attachId()!), 2);
    assert.equal(encoderSlots.get(catalogId), 6);
    assert.equal(encoderSlots.get(full.value.attachId()!), 2);
    assert.equal(
      [...encoderSlots.values()].reduce((sum, value) => sum + value, 0),
      8,
    );
    full.release();
    await flush();
    assert.equal(encoderSlots.get(catalogId), 6);
    mirror.release();
    await flush();
    assert.equal(encoderSlots.get(catalogId), 8);
  } finally {
    for (const stop of stops) stop();
    f.close();
    stripeCodec = false;
    encoderCapacity = Infinity;
    encoderSlots.clear();
    if (oldOffscreen)
      Object.defineProperty(globalThis, "OffscreenCanvas", oldOffscreen);
    else Reflect.deleteProperty(globalThis, "OffscreenCanvas");
  }
});

test("selected profile2 recovers when it races a preview capacity reduction without acquiring input", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  t.mock.method(Math, "random", () => 0.5);
  const oldOffscreen = Object.getOwnPropertyDescriptor(
    globalThis,
    "OffscreenCanvas",
  );
  Object.defineProperty(globalThis, "OffscreenCanvas", {
    configurable: true,
    value: class {},
  });
  stripeCodec = true;
  encoderCapacity = 8;
  encoderSlots.clear();
  const f = fixture(true),
    catalog = f.consumer(undefined),
    stops: (() => void)[] = [];
  const reduction = deferred<void>();
  try {
    await flush();
    const many = [
      ...displays,
      ...Array.from({ length: 6 }, (_, index) => ({
        ...displays[0]!,
        displayId: `race-other-${index}`,
      })),
    ];
    streams
      .get(catalog.value.attachId()!)!
      .push({ type: "layout", layoutEpoch: 2, displays: many });
    await flush();
    for (const display of many)
      stops.push(
        catalog.value.registerPreviewSurface(display.displayId, {
          isConnected: true,
          width: 320,
          height: 180,
          getContext: () => ({ drawImage() {} }),
        } as unknown as HTMLCanvasElement),
      );
    await flush();
    let blocked = false;
    beforePreviewConfigure = async (request) => {
      if (!blocked && request.viewports.length === 6) {
        blocked = true;
        await reduction.promise;
      }
    };
    const controlCount = controls.length;
    const full = f.consumer("first");
    await flush();
    assert.equal(blocked, true);
    assert.equal(full.value.phase(), "error");
    assert.equal(full.value.controlling(), false);
    reduction.resolve();
    await flush();
    assert.equal(encoderSlots.get(catalog.value.attachId()!), 6);
    t.mock.timers.tick(1000);
    await flush();
    assert.equal(full.value.phase(), "viewing");
    assert.equal(attachedProfiles.get(full.value.attachId()!), 2);
    assert.equal(full.value.controlling(), false);
    assert.equal(
      controls
        .slice(controlCount)
        .some((request) => request.action !== DesktopControlAction.Release),
      false,
    );
  } finally {
    reduction.resolve();
    beforePreviewConfigure = undefined;
    for (const stop of stops) stop();
    f.close();
    stripeCodec = false;
    encoderCapacity = Infinity;
    encoderSlots.clear();
    if (oldOffscreen)
      Object.defineProperty(globalThis, "OffscreenCanvas", oldOffscreen);
    else Reflect.deleteProperty(globalThis, "OffscreenCanvas");
  }
});

for (const code of ["limitExceeded", "busy", "staleEpoch"]) {
  test(`catalog ${code} retries previews without replacing its descriptor attachment`, async (t) => {
    t.mock.timers.enable({ apis: ["setTimeout"] });
    t.mock.method(Math, "random", () => 0.5);
    const f = fixture(true),
      catalog = f.consumer(undefined);
    let stop: (() => void) | undefined;
    try {
      await flush();
      const id = catalog.value.attachId()!,
        attempts = sequence;
      let rejected = false;
      beforePreviewConfigure = async () => {
        if (!rejected) {
          rejected = true;
          throw new RpcError(code, "Synthetic preview unavailable");
        }
      };
      stop = catalog.value.registerPreviewSurface("first", {
        isConnected: true,
        width: 320,
        height: 180,
        getContext: () => ({ drawImage() {} }),
      } as unknown as HTMLCanvasElement);
      await flush();
      assert.equal(rejected, true);
      assert.equal(catalog.value.phase(), "viewing");
      assert.equal(catalog.value.attachId(), id);
      assert.deepEqual(catalog.value.displays(), displays);
      assert.equal(streams.get(id)!.signal.aborted, false);
      assert.match(catalog.value.message()!, /preview/i);
      t.mock.timers.tick(1000);
      await flush();
      assert.equal(sequence, attempts);
      assert.equal(catalog.value.attachId(), id);
      assert.equal(
        catalog.value.configuration()?.tracks[0]?.viewport.displayId,
        "first",
      );
      assert.equal(catalog.value.message(), undefined);
    } finally {
      beforePreviewConfigure = undefined;
      stop?.();
      f.close();
    }
  });
}

const previewCanvas = () =>
  ({
    isConnected: true,
    width: 320,
    height: 180,
    getContext: () => ({ drawImage() {} }),
  }) as unknown as HTMLCanvasElement;

test("stale preview rejection consumes a newer layout on the same attachment", async () => {
  const f = fixture(true),
    catalog = f.consumer(undefined),
    pending = deferred<void>();
  let stop: (() => void) | undefined;
  try {
    await flush();
    const id = catalog.value.attachId()!;
    beforePreviewConfigure = async (request) => {
      if (request.layoutEpoch === 1) {
        await pending.promise;
        throw new RpcError("staleEpoch", "Screen: Stale");
      }
    };
    stop = catalog.value.registerPreviewSurface("first", previewCanvas());
    await flush();
    const nextDisplays = [
      { ...displays[0]!, bounds: { x: 0, y: 0, width: 720, height: 1280 } },
    ];
    streams
      .get(id)!
      .push({ type: "layout", layoutEpoch: 2, displays: nextDisplays });
    await flush();
    pending.resolve();
    await flush();
    assert.equal(catalog.value.attachId(), id);
    assert.equal(streams.get(id)!.signal.aborted, false);
    assert.deepEqual(catalog.value.displays(), nextDisplays);
    assert.equal(catalog.value.configuration()?.layoutEpoch, 2);
    assert.equal(
      catalog.value.configuration()?.tracks[0]?.viewport.crop.height,
      1280,
    );
    assert.equal(catalog.value.message(), undefined);
  } finally {
    pending.resolve();
    beforePreviewConfigure = undefined;
    stop?.();
    f.close();
  }
});

test("preview backoff stays bounded, preserves committed media, and stops with demand", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  t.mock.method(Math, "random", () => 0.5);
  const f = fixture(true),
    catalog = f.consumer(undefined);
  const stops: (() => void)[] = [];
  try {
    await flush();
    const id = catalog.value.attachId()!,
      attached = sequence;
    stops.push(catalog.value.registerPreviewSurface("first", previewCanvas()));
    await flush();
    const committed = catalog.value.configuration()!,
      restores: DesktopConfiguration[] = [];
    configureReceiver = async (next) => {
      restores.push(next);
    };
    let failures = 0;
    beforePreviewConfigure = async () => {
      failures++;
      throw new RpcError("busy", "Screen: Busy");
    };
    stops.push(catalog.value.registerPreviewSurface("second", previewCanvas()));
    await flush();
    assert.equal(failures, 1);
    assert.equal(restores.at(-1), committed);
    assert.equal(catalog.value.configuration(), committed);
    for (const delay of [1000, 2000, 4000, 8000, 10000, 10000]) {
      const before: number = failures;
      t.mock.timers.tick(delay - 1);
      await flush();
      assert.equal(failures, before);
      t.mock.timers.tick(1);
      await flush();
      assert.equal(failures, before + 1);
      assert.equal(catalog.value.attachId(), id);
    }
    beforePreviewConfigure = undefined;
    for (const stop of stops) stop();
    await flush();
    assert.deepEqual(catalog.value.configuration()?.tracks, []);
    const requests = configurations.length;
    t.mock.timers.tick(60_000);
    await flush();
    assert.equal(configurations.length, requests);
    assert.equal(sequence, attached);
    assert.equal(catalog.value.message(), undefined);
  } finally {
    configureReceiver = undefined;
    beforePreviewConfigure = undefined;
    for (const stop of stops) stop();
    f.close();
  }
});

for (const error of [
  new RpcError("permissionDenied", "No permission"),
  new Error("Transport failed"),
]) {
  test(`preview ${error.message} still invalidates a failed attachment`, async () => {
    const f = fixture(true),
      catalog = f.consumer(undefined);
    let stop: (() => void) | undefined;
    try {
      await flush();
      const id = catalog.value.attachId()!;
      beforePreviewConfigure = async () => {
        throw error;
      };
      stop = catalog.value.registerPreviewSurface("first", previewCanvas());
      await flush();
      assert.equal(catalog.value.phase(), "error");
      assert.equal(catalog.value.attachId(), undefined);
      assert.equal(streams.get(id)!.signal.aborted, true);
      assert.equal(catalog.value.message(), error.message);
    } finally {
      beforePreviewConfigure = undefined;
      stop?.();
      f.close();
    }
  });
}

test("closing a catalog cancels its pending preview retry", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const f = fixture(true),
    catalog = f.consumer(undefined);
  let stop: (() => void) | undefined;
  try {
    await flush();
    beforePreviewConfigure = async () => {
      throw new RpcError("busy", "Screen: Busy");
    };
    stop = catalog.value.registerPreviewSurface("first", previewCanvas());
    await flush();
    catalog.release();
    await flush();
    const count = configurations.length,
      attached = sequence;
    t.mock.timers.tick(60_000);
    await flush();
    assert.equal(configurations.length, count);
    assert.equal(sequence, attached);
    assert.equal(catalog.value.phase(), "idle");
  } finally {
    beforePreviewConfigure = undefined;
    stop?.();
    f.close();
  }
});

test("catalog keeps acknowledging preview frames during a retry without acquiring control", async () => {
  const f = fixture(true),
    catalog = f.consumer(undefined);
  let stop: (() => void) | undefined;
  try {
    await flush();
    const id = catalog.value.attachId()!,
      before = controls.length;
    beforePreviewConfigure = async () => {
      throw new RpcError("busy", "Screen: Busy");
    };
    stop = catalog.value.registerPreviewSurface("first", previewCanvas());
    await flush();
    const stats: DesktopVideoStats = {
      trackId: 1,
      codecEpoch: 1,
      groupId: 1,
      objectId: 1,
      decodeMicros: 1,
      renderMicros: 1,
      queueDepth: 0,
      requestKeyframe: false,
    };
    const count = sentInput.length;
    for (let objectId = 1; objectId <= 3; objectId++)
      feedbackReceivers.get(id)!({ ...stats, objectId });
    assert.deepEqual(
      sentInput.slice(count),
      [1, 2, 3].map((objectId) => ({
        attachId: id,
        event: { type: "feedback", ...stats, objectId },
      })),
    );
    assert.equal(controls.length, before);
    assert.equal(catalog.value.controlling(), false);
    assert.equal(catalog.value.attachId(), id);
  } finally {
    beforePreviewConfigure = undefined;
    stop?.();
    f.close();
  }
});

for (const failure of ["flush", "decode", "restore"] as const) {
  test(`preview ${failure} errors cannot be mistaken for retryable RPC rejections`, async () => {
    const f = fixture(true),
      catalog = f.consumer(undefined);
    let stop: (() => void) | undefined;
    try {
      await flush();
      const id = catalog.value.attachId()!,
        requests = configurations.length;
      const error = new RpcError("busy", `Synthetic ${failure} failure`);
      if (failure === "flush") flushError = error;
      else
        configureReceiver = async () => {
          throw error;
        };
      if (failure === "restore")
        beforePreviewConfigure = async () => {
          throw new RpcError("staleEpoch", "Screen: Stale");
        };
      stop = catalog.value.registerPreviewSurface("first", previewCanvas());
      await flush();
      assert.equal(catalog.value.phase(), "error");
      assert.equal(catalog.value.attachId(), undefined);
      assert.equal(streams.get(id)!.signal.aborted, true);
      assert.equal(catalog.value.message(), error.message);
      if (failure === "flush") assert.equal(configurations.length, requests);
    } finally {
      flushError = false;
      configureReceiver = undefined;
      beforePreviewConfigure = undefined;
      stop?.();
      f.close();
    }
  });
}
