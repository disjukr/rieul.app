import { RpcError } from "../protocol/client.ts";
import { desktopModes } from "../protocol/desktop-support.ts";
import { desktopCursorPng } from "../protocol/desktop-cursor.ts";
import { copyDocumentStyles } from "../solid/popup-styles.ts";
import { desktopEvents } from "../protocol/desktop-session.ts";
import { bunja } from "bunja";
import {
  createSignal,
  createMemo,
  createEffect,
  createRoot,
  getOwner,
  runWithOwner,
  untrack,
} from "solid-js";
import { rpcSessionBunja } from "./rpc-session.ts";
import { DesktopDisplayIdScope } from "./desktop-scopes.ts";
import { MachineIdScope } from "./machine-scopes.ts";
import { desktopPreviewsBunja } from "./desktop-previews.ts";
import {
  configureDesktopViewports,
  selectExistingDesktop,
  detachDesktop,
  getDesktopCapabilities,
  renewDesktopLease,
  setDesktopControl,
  queryDesktopQualitySupport,
  setDesktopQuality,
} from "../protocol/generated/client.ts";
import {
  DesktopAvailability,
  DesktopControlAction,
  DesktopKeyboardMode,
  type DesktopQualitySupport,
  type DesktopQualityPolicy,
  type DesktopQualityTarget,
  ProcId,
  type DesktopConfiguration,
  type DesktopCapabilities,
  type DesktopControl,
  type DesktopDisplay,
  type DesktopEvent,
  type DesktopInputEvent,
} from "../protocol/generated/rpc.ts";
import {
  DesktopInputChannel,
  bindDesktopInput,
} from "../protocol/desktop-input.ts";
import {
  DesktopVideoReceiver,
  supportedDesktopCodecs,
  type DesktopVideoStats,
} from "../protocol/desktop-video.ts";

export const desktopBunja = bunja(() => {
  bunja.use(MachineIdScope);
  const displayId = bunja.use(DesktopDisplayIdScope);
  const rpc = bunja.use(rpcSessionBunja);
  const previews = bunja.use(desktopPreviewsBunja);
  const [sessionMode, setSessionMode] = createSignal<
    "manual" | "active" | "suspended"
  >("manual");
  const managed = createMemo(() => sessionMode() === "active");
  const catalogMode = createMemo(() => sessionMode() !== "manual");
  const [selectedDisplayId, setSelectedDisplayId] = createSignal(displayId);
  const viewers = new Set<symbol>();
  const [inputOwner, setInputOwner] = createSignal<symbol>();
  let releaseOwnerPending = false;
  const owner = getOwner();
  const [phase, setPhase] = createSignal<
    "idle" | "connecting" | "viewing" | "unsupported" | "error"
  >("idle");
  const [message, setMessage] = createSignal<string>();
  const [displays, setDisplays] = createSignal<DesktopDisplay[]>([]);
  const [configuration, setConfiguration] =
    createSignal<DesktopConfiguration>();
  const [control, setControl] = createSignal<DesktopControl>({ inputEpoch: 0 });
  const [attachId, setAttachId] = createSignal<string>();
  const [stats, setStats] = createSignal<DesktopVideoStats>();
  const [busy, setBusy] = createSignal(false);
  const [qualitySupport, setQualitySupport] =
    createSignal<DesktopQualitySupport>();
  const [qualityBusy, setQualityBusy] = createSignal(false);
  const [qualityMessage, setQualityMessage] = createSignal<string>();
  const [qualityPolicy, setQualityPolicy] =
    createSignal<DesktopQualityPolicy>();
  const scopedSelectionSupported = createMemo(() => {
    const info = rpc.daemonInfo();
    return (
      info.phase === "ready" &&
      info.daemonInfo.supportedProcIds.includes(ProcId.SelectExistingDesktop)
    );
  });
  const qualitySupported = createMemo(() => {
    const info = rpc.daemonInfo();
    return (
      info.phase === "ready" &&
      (!managed() || displayId !== undefined) &&
      (!catalogMode() || scopedSelectionSupported()) &&
      [ProcId.QueryDesktopQualitySupport, ProcId.SetDesktopQuality].every(
        (id) => info.daemonInfo.supportedProcIds.includes(id),
      )
    );
  });
  const [outputHeight, setOutputHeight] = createSignal(1080);
  const [maxViewports, setMaxViewports] = createSignal(8);
  const [inputReady, setInputReady] = createSignal(false);
  const [cursor, setCursor] =
    createSignal<Extract<DesktopEvent, { type: "cursor" }>>();
  const modes = createMemo(() => {
    const info = rpc.daemonInfo();
    return desktopModes(
      info.phase === "ready" ? info.daemonInfo.supportedProcIds : [],
    );
  });
  const supported = createMemo(() => modes().existing);
  const automaticDisplays = createMemo(() => {
    const info = rpc.daemonInfo();
    return (
      !catalogMode() &&
      info.phase === "ready" &&
      info.daemonInfo.supportedProcIds.includes(ProcId.AttachExistingDesktop)
    );
  });
  const serverOwnsGeometry = createMemo(
    () =>
      automaticDisplays() ||
      (catalogMode() && displayId !== undefined && scopedSelectionSupported()),
  );
  const availabilityMessage = createMemo(() => {
    const info = rpc.daemonInfo();
    if (info.phase === "loading") return "Checking daemon support…";
    if (info.phase === "error")
      return "Daemon connection failed. Reconnect to the daemon and retry.";
    if (info.phase !== "ready") return "Select a paired daemon to connect.";
    if (!supported())
      return "This daemon version does not offer Screen. Update the daemon to continue.";
    return undefined;
  });
  const controlling = createMemo(
    () =>
      inputReady() && !!attachId() && control().holderAttachId === attachId(),
  );
  let active = false,
    generation = 0,
    layoutEpoch = 0;
  const lastStats = new Map<number, number>();
  let transport: WebTransport | undefined,
    video: DesktopVideoReceiver | undefined,
    input: DesktopInputChannel | undefined;
  let events: AsyncGenerator<DesktopEvent> | undefined,
    renew: ReturnType<typeof setInterval> | undefined;
  let eventsAbort: AbortController | undefined,
    attachTimeout: ReturnType<typeof setTimeout> | undefined;
  let stopPreviewPublisher: (() => void) | undefined;
  let releaseSelectedReservation: (() => void) | undefined;
  let previewCapture = false;
  let previewRequestedIds = new Set<string>();
  let previewKey = "";
  let previewRetryTimer: ReturnType<typeof setTimeout> | undefined;
  let previewRetryDelay = 1000;
  let previewMessage: string | undefined;
  function clearPreviewMessage() {
    if (previewMessage !== undefined && message() === previewMessage)
      setMessage(undefined);
    previewMessage = undefined;
  }
  const [previewRetry, setPreviewRetry] = createSignal(0);
  function retryPreviews() {
    clearTimeout(previewRetryTimer);
    previewRetryTimer = setTimeout(
      () => {
        previewRetryTimer = undefined;
        previewKey = "";
        setPreviewRetry((revision) => revision + 1);
      },
      Math.round(previewRetryDelay * (0.8 + Math.random() * 0.4)),
    );
    previewRetryDelay = Math.min(10_000, previewRetryDelay * 2);
  }
  function matchesSelectedView(next: DesktopConfiguration) {
    return (
      !catalogMode() ||
      next.tracks.every((track) =>
        previewCapture && displayId === undefined
          ? previewRequestedIds.has(track.viewport.displayId)
          : track.viewport.displayId === selectedDisplayId(),
      )
    );
  }
  let configKey = "",
    configVersion = 0,
    newestCodecEpoch = 0,
    selectionRevision = 0,
    configurationRevision = 0,
    qualityRevision = 0;
  function invalidateSelectedView() {
    selectionRevision++;
    configurationRevision++;
    qualityRevision++;
    configKey = "";
    setQualitySupport(undefined);
    setQualityPolicy(undefined);
    setQualityMessage(undefined);
    setQualityBusy(false);
  }
  let offeredCodecs: string[] = [],
    currentCodec = "",
    h264Fallback = false,
    profileFallback = false,
    fallbackPending = false,
    currentProfile = 1;
  let inputFeatures: Pick<DesktopCapabilities, "physicalKeys" | "wheelUnits"> =
    {};
  const surfaces = new Map<string, Set<HTMLCanvasElement>>();
  const popups = new Map<Window, () => void>();
  let retryTimer: ReturnType<typeof setTimeout> | undefined;
  let retryDelay = 1000;
  function scheduleManagedRetry(error?: unknown) {
    if (
      !active ||
      !managed() ||
      retryTimer ||
      (error instanceof RpcError &&
        [
          "permissionDenied",
          "invalidCredentials",
          "unauthorized",
          "unsupported",
          "invalid",
        ].includes(error.code))
    )
      return;
    retryTimer = setTimeout(
      () => {
        retryTimer = undefined;
        if (active && managed()) void connect();
      },
      Math.round(retryDelay * (0.8 + Math.random() * 0.4)),
    );
    retryDelay = Math.min(10_000, retryDelay * 2);
  }
  function disconnect(preserveSelection = false) {
    generation++;
    invalidateSelectedView();
    stopPreviewPublisher?.();
    stopPreviewPublisher = undefined;
    previewCapture = false;
    previewRequestedIds = new Set();
    previewKey = "";
    clearTimeout(previewRetryTimer);
    previewRetryTimer = undefined;
    previewRetryDelay = 1000;
    previewMessage = undefined;
    clearTimeout(retryTimer);
    retryTimer = undefined;
    if (!preserveSelection) setSelectedDisplayId(undefined);
    fallbackPending = false;
    currentProfile = 1;
    eventsAbort?.abort();
    eventsAbort = undefined;
    clearTimeout(attachTimeout);
    configVersion++;
    clearInterval(renew);
    renew = undefined;
    const oldTransport = transport,
      id = attachId(),
      oldEvents = events;
    input?.abort();
    input = undefined;
    video?.close();
    video = undefined;
    transport = undefined;
    events = undefined;
    configKey = "";
    newestCodecEpoch = 0;
    offeredCodecs = [];
    currentCodec = "";
    inputFeatures = {};
    for (const [popup, cleanup] of popups) {
      cleanup();
      popup.close();
    }
    popups.clear();
    if (oldTransport && id)
      void detachDesktop(oldTransport, { attachId: id }).catch(() => {});
    void oldEvents?.return(undefined).catch(() => {});
    lastStats.clear();
    setQualitySupport(undefined);
    setQualityPolicy(undefined);
    setQualityMessage(undefined);
    setQualityBusy(false);
    setStats(undefined);
    setMessage(undefined);
    setInputReady(false);
    setInputOwner(undefined);
    releaseOwnerPending = false;
    setCursor(undefined);
    setAttachId(undefined);
    setConfiguration(undefined);
    setControl({ inputEpoch: 0 });
    setDisplays([]);
    setBusy(false);
    setPhase("idle");
  }
  async function retryFullFrame() {
    const token = generation,
      oldTransport = transport,
      id = attachId();
    profileFallback = true;
    fallbackPending = true;
    setMessage(
      "Stripe video failed. Reconnecting with full-frame video; control will remain released.",
    );
    input?.send({ type: "releaseAll" });
    await Promise.resolve(input?.flush()).catch(() => {});
    if (token !== generation || !active) return;
    if (oldTransport && id) {
      try {
        await detachDesktop(oldTransport, { attachId: id });
      } catch (error) {
        if (!(error instanceof RpcError && error.code === "notFound"))
          throw error;
      }
    }
    if (token === generation && active) await connect(h264Fallback, true);
  }
  function failed(error: unknown) {
    if (fallbackPending) return;
    if (
      active &&
      currentProfile === 2 &&
      !profileFallback &&
      !(
        error instanceof RpcError &&
        ["permissionDenied", "invalidCredentials", "unauthorized"].includes(
          error.code,
        )
      )
    ) {
      const token = generation;
      void retryFullFrame().catch((e) => {
        if (token === generation) {
          fallbackPending = false;
          failed(e);
        }
      });
      return;
    }
    if (
      active &&
      !h264Fallback &&
      /^(av01|hev1)\./.test(currentCodec) &&
      offeredCodecs.some((c) => /^avc[13]\./.test(c)) &&
      !(
        error instanceof RpcError &&
        ["permissionDenied", "invalidCredentials", "unauthorized"].includes(
          error.code,
        )
      )
    ) {
      void connect(true, profileFallback);
      return;
    }
    disconnect(managed());
    if (active) {
      setPhase("error");
      setMessage(error instanceof Error ? error.message : String(error));
      scheduleManagedRetry(error);
    }
  }
  function send(event: DesktopInputEvent): boolean {
    return controlling() && !!input?.send(event);
  }
  function registerSurface(
    viewportId: string,
    canvas: HTMLCanvasElement,
    viewer?: symbol,
  ): () => void {
    let set = surfaces.get(viewportId);
    if (!set) {
      set = new Set();
      surfaces.set(viewportId, set);
    }
    set.add(canvas);
    video?.requestRefresh(viewportId);
    const restored = () => video?.requestRefresh(viewportId);
    canvas.addEventListener("contextrestored", restored);
    const cleanup = bindDesktopInput(canvas, viewportId, send, () => ({
      active:
        controlling() && (viewer === undefined || inputOwner() === viewer),
      epoch: control().inputEpoch,
      ...inputFeatures,
    }));
    return () => {
      cleanup();
      canvas.removeEventListener("contextrestored", restored);
      set!.delete(canvas);
      if (set!.size === 0 && surfaces.get(viewportId) === set)
        surfaces.delete(viewportId);
      if (displayId !== undefined && surfaces.size === 0) {
        stopPreviewPublisher?.();
        stopPreviewPublisher = undefined;
      }
    };
  }
  async function applyConfiguration(next: DesktopConfiguration, token: number) {
    if (!matchesSelectedView(next)) return;
    const nextCodecEpoch = Math.max(0, ...next.tracks.map((t) => t.codecEpoch));
    if (next.tracks.length && nextCodecEpoch < newestCodecEpoch) return;
    const key = JSON.stringify(next);
    if (key === configKey) {
      if (configuration() && JSON.stringify(configuration()) === key)
        await video?.configure(next);
      return;
    }
    const previous = configuration();
    if (
      previous &&
      (next.layoutEpoch < previous.layoutEpoch ||
        (next.tracks.length > 0 &&
          next.layoutEpoch === previous.layoutEpoch &&
          Math.max(0, ...next.tracks.map((t) => t.codecEpoch)) <
            Math.max(0, ...previous.tracks.map((t) => t.codecEpoch))))
    )
      return;
    const applyRevision = ++configurationRevision;
    const selectedRevision = selectionRevision;
    configKey = key;
    const geometry = (value: DesktopConfiguration | undefined) =>
      JSON.stringify([
        value?.layoutEpoch,
        value?.tracks.map((t) => ({
          ...t.viewport,
          fps: undefined,
          bitrate: undefined,
        })),
      ]);
    if (geometry(previous) !== geometry(next)) {
      for (const [popup, cleanup] of popups) {
        cleanup();
        popup.close();
      }
      popups.clear();
      setQualitySupport(undefined);
      setQualityPolicy(undefined);
    }
    if (next.tracks.some((t) => !offeredCodecs.includes(t.codec.codec)))
      throw new Error("Daemon selected an unoffered screen codec");
    currentCodec = next.tracks[0]?.codec.codec ?? "";
    try {
      await video?.configure(next);
    } catch (error) {
      if (
        token !== generation ||
        applyRevision !== configurationRevision ||
        selectedRevision !== selectionRevision
      )
        return;
      throw error;
    }
    if (
      token !== generation ||
      applyRevision !== configurationRevision ||
      selectedRevision !== selectionRevision ||
      next.layoutEpoch !== layoutEpoch ||
      !matchesSelectedView(next)
    )
      return;
    newestCodecEpoch = Math.max(newestCodecEpoch, nextCodecEpoch);
    setConfiguration(next);
  }
  async function queryQuality(candidate?: DesktopQualityTarget) {
    if (!transport || !attachId() || !qualitySupported() || qualityBusy())
      return;
    const token = generation,
      selectedRevision = selectionRevision,
      selectedConfiguration = configuration(),
      requestRevision = ++qualityRevision;
    const current = () =>
      token === generation &&
      selectedRevision === selectionRevision &&
      selectedConfiguration === configuration() &&
      requestRevision === qualityRevision;
    setQualityBusy(true);
    setQualityMessage(undefined);
    setQualitySupport(undefined);
    try {
      const support = await queryDesktopQualitySupport(transport, {
        attachId: attachId()!,
        candidates: candidate ? [candidate] : undefined,
      });
      if (!current()) return;
      setQualitySupport(support);
      setQualityPolicy(support.policy);
    } catch (error) {
      if (current()) setQualityMessage(String(error));
    } finally {
      if (requestRevision === qualityRevision) setQualityBusy(false);
    }
  }
  async function applyQuality(policy: DesktopQualityPolicy) {
    const support = qualitySupport();
    if (!support || !transport || !attachId() || qualityBusy()) return;
    const token = generation,
      selectedRevision = selectionRevision,
      selectedConfiguration = configuration(),
      requestRevision = ++qualityRevision;
    const current = () =>
      token === generation &&
      selectedRevision === selectionRevision &&
      requestRevision === qualityRevision;
    setQualityBusy(true);
    setQualityMessage(undefined);
    try {
      video?.prepareConfiguration();
      const next = await setDesktopQuality(transport, {
        attachId: attachId()!,
        layoutEpoch: support.layoutEpoch,
        revision: support.revision,
        policy,
      });
      if (!current()) return;
      await applyConfiguration(next, token);
      if (!current()) return;
      setQualityPolicy(policy);
      setQualitySupport(undefined);
    } catch (error) {
      if (current()) {
        if (selectedConfiguration) {
          try {
            await video?.configure(selectedConfiguration);
          } catch (restoreError) {
            if (current()) failed(restoreError);
          }
        }
        if (!current()) return;
        setQualityMessage(
          `${String(error)}. Check support again before retrying.`,
        );
        setQualitySupport(undefined);
      }
    } finally {
      if (requestRevision === qualityRevision) setQualityBusy(false);
    }
  }
  async function configure(
    ids: string[],
    attachment = attachId(),
    layout?: DesktopDisplay[],
    purpose: "selected" | "preview" = "selected",
  ) {
    if (automaticDisplays() || !transport || !attachment || (busy() && !layout))
      return;
    const token = generation,
      version = ++configVersion;
    let previewRequestPending = false;
    setBusy(true);
    try {
      send({ type: "releaseAll" });
      await input?.flush();
      if (token !== generation) return;
      const selected = (layout ?? displays())
        .filter((d) => ids.includes(d.displayId))
        .slice(0, maxViewports());
      if (purpose === "preview") {
        invalidateSelectedView();
        previewCapture = true;
        previewRequestedIds = new Set(
          selected.map((display) => display.displayId),
        );
      }
      const totalBitrate =
        purpose === "preview"
          ? Math.max(1, selected.length) * 125_000
          : 20_000_000;
      video?.prepareConfiguration();
      previewRequestPending = purpose === "preview";
      const next =
        purpose === "selected" && catalogMode() && scopedSelectionSupported()
          ? await selectExistingDesktop(transport, {
              attachId: attachment,
              expectedLayoutEpoch: layoutEpoch,
              selection: selected[0]
                ? { type: "display", displayId: selected[0].displayId }
                : { type: "clear" },
            })
          : await configureDesktopViewports(transport, {
              attachId: attachment,
              layoutEpoch,
              totalBitrate,
              viewports: selected.map((d) => {
                const scale = Math.min(
                  1,
                  (purpose === "preview" ? 320 : (outputHeight() * 16) / 9) /
                    d.bounds.width,
                  (purpose === "preview" ? 180 : outputHeight()) /
                    d.bounds.height,
                );
                return {
                  viewportId: d.displayId,
                  displayId: d.displayId,
                  crop: {
                    x: 0,
                    y: 0,
                    width: d.bounds.width,
                    height: d.bounds.height,
                  },
                  width: Math.max(
                    2,
                    Math.floor((d.bounds.width * scale) / 2) * 2,
                  ),
                  height: Math.max(
                    2,
                    Math.floor((d.bounds.height * scale) / 2) * 2,
                  ),
                  fps: purpose === "preview" ? 1 : 60,
                  bitrate: Math.floor(
                    totalBitrate / Math.max(1, selected.length),
                  ),
                };
              }),
            });
      previewRequestPending = false;
      if (token === generation && version === configVersion) {
        await applyConfiguration(next, token);
        if (purpose === "preview" && token === generation) {
          previewRetryDelay = 1000;
          clearPreviewMessage();
        }
      }
    } catch (error) {
      if (token !== generation || version !== configVersion) return;
      if (
        previewRequestPending &&
        error instanceof RpcError &&
        ["busy", "limitExceeded", "staleEpoch"].includes(error.code)
      ) {
        // A rejected optional preview request does not invalidate discovery.
        // Reopen the prepared media gate for the still-current configuration.
        try {
          await video?.configure(
            configuration() ?? { layoutEpoch, totalBitrate: 1, tracks: [] },
          );
        } catch (restoreError) {
          if (token === generation) failed(restoreError);
          return;
        }
        if (token !== generation || version !== configVersion) return;
        previewMessage = `Screen previews temporarily unavailable. Retrying… ${error.message}`;
        setMessage(previewMessage);
        retryPreviews();
      } else failed(error);
    } finally {
      if (token === generation && version === configVersion) {
        setBusy(false);
        drainOwnerRelease();
      }
    }
  }
  async function resize(height: number) {
    if (serverOwnsGeometry() || ![720, 1080, 2160].includes(height) || busy())
      return;
    setOutputHeight(height);
    if (phase() === "viewing")
      await configure(
        configuration()?.tracks.map((t) => t.viewport.displayId) ?? [],
      );
  }
  async function connect(h264Only = false, fullFrame = false) {
    disconnect(managed());
    h264Fallback = h264Only;
    profileFallback = fullFrame;
    if (!active || !supported()) return;
    const token = generation;
    setMessage(undefined);
    setPhase("connecting");
    attachTimeout = setTimeout(() => {
      if (token === generation)
        failed(
          new Error("Screen connection timed out. Retry to connect again."),
        );
    }, 10_000);
    try {
      const nextTransport = await rpc.webTransport();
      if (token !== generation) return;
      const caps = await getDesktopCapabilities(nextTransport);
      if (token !== generation) return;
      setMaxViewports(Math.max(1, Math.min(8, caps.maxViewports)));
      if (caps.capture !== DesktopAvailability.Available) {
        clearTimeout(attachTimeout);
        setPhase("unsupported");
        setMessage(
          caps.reason ??
            "Screen capture is unavailable or needs OS permission.",
        );
        return;
      }
      const supportedCodecs = await supportedDesktopCodecs(caps.codecs);
      const codecs = h264Only
        ? supportedCodecs.filter((c) => /^avc[13]\./.test(c))
        : supportedCodecs;
      if (token !== generation) return;
      if (!codecs.length) {
        clearTimeout(attachTimeout);
        setPhase("unsupported");
        setMessage(
          "This browser and daemon have no supported video codec in common.",
        );
        return;
      }
      offeredCodecs = codecs;
      // Before configuration arrives, recover a failed preferred-codec attach too.
      currentCodec = codecs[0];
      transport = nextTransport;
      eventsAbort = new AbortController();
      currentProfile =
        !fullFrame &&
        !(managed() && displayId === undefined) &&
        caps.supportedProfiles?.includes(2) &&
        typeof OffscreenCanvas !== "undefined" &&
        /^(avc1|hev1)\./.test(codecs[0] ?? "")
          ? 2
          : 1;
      const iterator = desktopEvents(
        nextTransport,
        {
          profile: currentProfile,
          codecs,
          mediaUniStreams: true,
          keyboardMode: DesktopKeyboardMode.Physical,
        },
        eventsAbort.signal,
        automaticDisplays()
          ? ProcId.AttachExistingDesktop
          : ProcId.AttachDesktop,
      );
      events = iterator;
      void (async () => {
        try {
          for await (const event of iterator) {
            if (token !== generation) {
              if (event.type === "attached")
                void detachDesktop(nextTransport, {
                  attachId: event.attachId,
                }).catch(() => {});
              break;
            }
            if (event.type === "attached") {
              if (!automaticDisplays()) clearTimeout(attachTimeout);
              inputFeatures = {
                physicalKeys: caps.physicalKeys,
                wheelUnits: caps.wheelUnits,
              };
              setMessage(
                fullFrame
                  ? "Using full-frame video after stripe initialization failed. Control remains released."
                  : caps.reason,
              );
              setInputReady(caps.input === DesktopAvailability.Available);
              setAttachId(event.attachId);
              setControl(event.control);
              setDisplays(event.displays);
              layoutEpoch = event.layoutEpoch;
              input = new DesktopInputChannel(
                nextTransport,
                event.attachId,
                () => ({ inputEpoch: control().inputEpoch, layoutEpoch }),
                (error) => {
                  if (token !== generation) return;
                  setInputReady(false);
                  setMessage(
                    managed()
                      ? `${error.message} Reconnecting to restore control…`
                      : `${error.message} View remains connected; reconnect to control.`,
                  );
                  void setDesktopControl(nextTransport, {
                    attachId: event.attachId,
                    action: DesktopControlAction.Release,
                  }).catch(() => {});
                  scheduleManagedRetry(error);
                },
              );
              video = new DesktopVideoReceiver(
                nextTransport,
                event.attachId,
                (viewportId, frame) => {
                  if (token !== generation) return false;
                  let drawn = false;
                  for (const canvas of surfaces.get(viewportId) ?? []) {
                    const ctx = canvas.getContext("2d");
                    if (
                      !canvas.isConnected ||
                      !canvas.width ||
                      !canvas.height ||
                      !ctx ||
                      ctx.isContextLost?.()
                    )
                      continue;
                    ctx.drawImage(frame, 0, 0, canvas.width, canvas.height);
                    drawn = true;
                  }
                  if (displayId !== undefined && drawn) {
                    stopPreviewPublisher ??=
                      previews.registerPublisher(displayId);
                    previews.publish(displayId, frame, "selected");
                  } else if (displayId !== undefined) {
                    stopPreviewPublisher?.();
                    stopPreviewPublisher = undefined;
                  } else if (
                    displayId === undefined &&
                    previewCapture &&
                    !previews.hasPublisher(viewportId)
                  ) {
                    drawn =
                      previews.publish(viewportId, frame, "preview") || drawn;
                  }
                  return drawn;
                },
                (next) => {
                  if (token !== generation) return;
                  // ACKs drive the sender's bounded receipt window. Throttle
                  // only visible statistics, never transport acknowledgements.
                  if (caps.feedback) input?.send({ type: "feedback", ...next });
                  if (
                    next.requestKeyframe ||
                    performance.now() - (lastStats.get(next.trackId) ?? 0) > 500
                  ) {
                    lastStats.set(next.trackId, performance.now());
                    setStats(next);
                  }
                },
                (error) => {
                  if (token === generation) failed(error);
                },
                (codec) => {
                  if (
                    token === generation &&
                    (currentProfile === 2 || /^(av01|hev1)\./.test(codec))
                  )
                    failed(
                      new Error(
                        currentProfile === 2
                          ? "Stripe decoder failed"
                          : "Video decoder failed",
                      ),
                    );
                },
              );
              renew = setInterval(
                () => {
                  if (token === generation)
                    void renewDesktopLease(nextTransport, {
                      attachId: event.attachId,
                    }).catch((error) => {
                      if (token === generation) failed(error);
                    });
                },
                Math.max(1000, Math.min(5000, event.leaseMs / 3)),
              );
              if (!automaticDisplays()) {
                const selected = selectedDisplayId();
                if (!catalogMode() || selected) {
                  if (
                    selected &&
                    !event.displays.some((d) => d.displayId === selected)
                  ) {
                    setSelectedDisplayId(undefined);
                  } else {
                    await configure(
                      catalogMode()
                        ? [selected!]
                        : event.displays
                            .slice(0, maxViewports())
                            .map((d) => d.displayId),
                      event.attachId,
                      event.displays,
                    );
                  }
                }
                if (token === generation) {
                  retryDelay = 1000;
                  setPhase("viewing");
                }
              }
            } else if (event.type === "control") {
              setControl(event.control);
              if (!controlling()) input?.flush();
            } else if (event.type === "configured") {
              if (event.configuration.layoutEpoch < layoutEpoch) continue;
              clearTimeout(attachTimeout);
              await applyConfiguration(event.configuration, token);
              if (token === generation) setPhase("viewing");
            } else if (event.type === "layout") {
              if (event.layoutEpoch <= layoutEpoch) continue;
              invalidateSelectedView();
              send({ type: "releaseAll" });
              layoutEpoch = event.layoutEpoch;
              setDisplays(event.displays);
              setConfiguration(undefined);
              if (!automaticDisplays()) {
                const selected = selectedDisplayId();
                if (
                  catalogMode() &&
                  selected &&
                  !event.displays.some((d) => d.displayId === selected)
                ) {
                  await leaveDisplay();
                  setMessage(
                    "This display was disconnected. Choose another display.",
                  );
                } else if (!catalogMode() || selected) {
                  await configure(
                    catalogMode()
                      ? [selected!]
                      : event.displays
                          .slice(0, maxViewports())
                          .map((d) => d.displayId),
                    attachId(),
                    event.displays,
                  );
                }
              }
            } else if (event.type === "cursor") setCursor(event);
            else if (event.type === "closed") throw new Error(event.reason);
          }
          if (token === generation)
            failed(new Error("Screen session ended. Reconnect to view again."));
        } catch (error) {
          if (token === generation) failed(error);
        }
      })();
    } catch (error) {
      if (token === generation) failed(error);
    }
  }
  function drainOwnerRelease() {
    if (!releaseOwnerPending || busy() || !active) return;
    releaseOwnerPending = false;
    void setAction(DesktopControlAction.Release);
  }
  function registerViewer(viewer: symbol) {
    viewers.add(viewer);
    return () => {
      viewers.delete(viewer);
      if (inputOwner() === viewer) {
        send({ type: "releaseAll" });
        setInputOwner(undefined);
        releaseOwnerPending = true;
        drainOwnerRelease();
      }
    };
  }
  async function setAction(action: DesktopControlAction, viewer?: symbol) {
    if (
      managed() &&
      displayId === undefined &&
      action !== DesktopControlAction.Release
    )
      return;
    if (
      !transport ||
      !attachId() ||
      busy() ||
      (action !== DesktopControlAction.Release && !inputReady()) ||
      (viewer !== undefined && !viewers.has(viewer))
    )
      return;
    const token = generation;
    setBusy(true);
    try {
      if (
        action === DesktopControlAction.Release ||
        (controlling() && viewer !== undefined && inputOwner() !== viewer)
      ) {
        send({ type: "releaseAll" });
        await input?.flush();
        if (token !== generation) return;
      }
      const next = await setDesktopControl(transport, {
        attachId: attachId()!,
        action,
      });
      if (token === generation) {
        setControl(next);
        if (action === DesktopControlAction.Release) setInputOwner(undefined);
        else if (viewer !== undefined && next.holderAttachId === attachId()) {
          if (viewers.has(viewer)) setInputOwner(viewer);
          else releaseOwnerPending = true;
        }
        setMessage(undefined);
      }
    } catch (error) {
      if (token === generation) {
        if (action === DesktopControlAction.Release && managed()) {
          disconnect(true);
          setPhase("error");
          setMessage(
            `Control could not be released. ${error instanceof Error ? error.message : String(error)}`,
          );
          scheduleManagedRetry(error);
        } else
          setMessage(error instanceof Error ? error.message : String(error));
      }
    } finally {
      if (token === generation) {
        setBusy(false);
        drainOwnerRelease();
      }
    }
  }
  function openWindow(viewportId: string) {
    const track = configuration()?.tracks.find(
      (t) => t.viewport.viewportId === viewportId,
    );
    if (!track) return;
    const popup = window.open(
      "about:blank",
      "_blank",
      "popup,width=1000,height=700",
    );
    if (!popup) {
      setMessage("Allow this window to open, or keep using the embedded view.");
      return;
    }
    popup.document.title = "Rieul Screen";
    popup.document.body.className = "rieul-desktop-window";
    const note = popup.document.createElement("p");
    note.textContent =
      "Move this window to your other monitor. Control is shared with the main viewer.";
    const canvas = popup.document.createElement("canvas");
    canvas.className = "rieul-desktop-canvas";
    canvas.width = track.viewport.width;
    canvas.height = track.viewport.height;
    canvas.tabIndex = 0;
    canvas.setAttribute("aria-label", `Display ${track.viewport.displayId}`);
    const frame = popup.document.createElement("div");
    frame.className = "rieul-desktop-frame";
    frame.style.position = "relative";
    const cursorImage = popup.document.createElement("img");
    cursorImage.alt = "";
    cursorImage.className = "rieul-desktop-cursor";
    Object.assign(cursorImage.style, {
      position: "absolute",
      pointerEvents: "none",
      display: "none",
    });
    frame.append(canvas, cursorImage);
    popup.document.body.append(note, frame);
    let cursorUrl: string | undefined;
    const stopCursor = runWithOwner(owner, () =>
      createRoot((dispose) => {
        createEffect(
          createMemo(() => ({
            cursor: cursor(),
            displays: displays(),
            configuration: configuration(),
          })),
          (snapshot) => {
            if (cursorUrl) {
              URL.revokeObjectURL(cursorUrl);
              cursorUrl = undefined;
            }
            const c = snapshot.cursor,
              d = snapshot.displays.find(
                (d) => d.displayId === track.viewport.displayId,
              ),
              crop = track.viewport.crop;
            const shape = c?.shape && desktopCursorPng(c.shape);
            if (
              !c?.visible ||
              !shape ||
              !d ||
              c.layoutEpoch !== snapshot.configuration?.layoutEpoch ||
              (c.displayId !== undefined && c.displayId !== d.displayId)
            ) {
              cursorImage.style.display = "none";
              return;
            }
            const x = c.x - d.bounds.x - crop.x,
              y = c.y - d.bounds.y - crop.y;
            if (x < 0 || y < 0 || x >= crop.width || y >= crop.height) {
              cursorImage.style.display = "none";
              return;
            }
            cursorUrl = URL.createObjectURL(
              new Blob([new Uint8Array(c.shape!)], { type: "image/png" }),
            );
            cursorImage.src = cursorUrl;
            Object.assign(cursorImage.style, {
              display: "block",
              left: `${(x / crop.width) * 100}%`,
              top: `${(y / crop.height) * 100}%`,
              width: `${(shape.width / crop.width) * 100}%`,
              transform: `translate(-${(c.hotspotX / shape.width) * 100}%, -${(c.hotspotY / shape.height) * 100}%)`,
            });
          },
        );
        return dispose;
      }),
    );
    const stopStyles = copyDocumentStyles(document, popup.document);
    const releaseSurface = registerSurface(viewportId, canvas);
    const cleanup = () => {
      releaseSurface();
      stopStyles();
      stopCursor();
      if (cursorUrl) {
        URL.revokeObjectURL(cursorUrl);
        cursorUrl = undefined;
      }
    };
    popups.set(popup, cleanup);
    popup.addEventListener(
      "pagehide",
      () => {
        cleanup();
        popups.delete(popup);
      },
      { once: true },
    );
  }
  async function selectDisplay(displayId: string) {
    if (
      !catalogMode() ||
      phase() !== "viewing" ||
      busy() ||
      !displays().some((d) => d.displayId === displayId)
    )
      return;
    invalidateSelectedView();
    setSelectedDisplayId(displayId);
    await configure([displayId]);
  }
  async function leaveDisplay() {
    const token = generation;
    invalidateSelectedView();
    setSelectedDisplayId(undefined);
    if (busy()) {
      await connect();
      return;
    }
    await setAction(DesktopControlAction.Release);
    if (token !== generation) return;
    if (attachId() && control().holderAttachId === attachId()) {
      await connect();
      return;
    }
    if (phase() === "viewing") await configure([]);
  }
  function start() {
    if (displayId !== undefined)
      releaseSelectedReservation ??= previews.reserveSelected(displayId);
    setSessionMode("active");
  }
  function stop() {
    releaseSelectedReservation?.();
    releaseSelectedReservation = undefined;
    setSessionMode("suspended");
    disconnect(true);
  }
  bunja.effect(() => {
    active = true;
    const dispose = runWithOwner(owner, () =>
      createRoot((dispose) => {
        createEffect(
          createMemo(() => ({ info: rpc.daemonInfo(), managed: managed() })),
          ({ info, managed }) => {
            untrack(() => disconnect(catalogMode()));
            setMessage(undefined);
            if (managed && info.phase === "ready") {
              const ids = info.daemonInfo.supportedProcIds;
              if (
                [ProcId.GetDesktopCapabilities, ProcId.AttachDesktop].every(
                  (id) => ids.includes(id),
                ) &&
                (ids.includes(ProcId.ConfigureDesktopViewports) ||
                  scopedSelectionSupported())
              ) {
                untrack(() => void connect());
              } else {
                setPhase("unsupported");
                setMessage(
                  "This daemon needs an update to browse individual displays.",
                );
              }
            }
          },
        );
        createEffect(
          createMemo(() => ({
            ids: previews.previewIds(),
            publishers: previews.publisherIds(),
            selected: previews.selectedIds(),
            displays: displays(),
            ready: phase() === "viewing",
            busy: busy(),
            managed: managed(),
            cap: maxViewports(),
            retry: previewRetry(),
          })),
          (snapshot) => {
            if (
              displayId !== undefined ||
              !snapshot.managed ||
              !snapshot.ready ||
              snapshot.busy
            )
              return;
            const needed = new Set(snapshot.ids),
              published = new Set(snapshot.publishers);
            const ids = snapshot.displays
              .filter(
                (display) =>
                  needed.has(display.displayId) &&
                  !published.has(display.displayId),
              )
              .map((display) => display.displayId)
              .slice(
                0,
                Math.min(
                  8,
                  snapshot.cap,
                  Math.max(0, 8 - snapshot.selected.length * 2),
                ),
              );
            const key = JSON.stringify([
              layoutEpoch,
              ids,
              snapshot.displays
                .filter((display) => ids.includes(display.displayId))
                .map((display) => display.bounds),
            ]);
            if (key === previewKey) return;
            previewKey = key;
            clearTimeout(previewRetryTimer);
            previewRetryTimer = undefined;
            if (!ids.length && !untrack(configuration)?.tracks.length) {
              clearPreviewMessage();
              return;
            }
            untrack(
              () => void configure(ids, attachId(), undefined, "preview"),
            );
          },
        );
        return dispose;
      }),
    );
    return () => {
      active = false;
      releaseSelectedReservation?.();
      releaseSelectedReservation = undefined;
      untrack(disconnect);
      dispose();
    };
  });
  return {
    phase,
    message,
    selectedDisplayId,
    start,
    stop,
    selectDisplay,
    leaveDisplay,
    displays,
    hostOs: createMemo(() => {
      const info = rpc.daemonInfo();
      return info.phase === "ready" ? info.daemonInfo.os : undefined;
    }),
    configuration,
    control,
    attachId,
    stats,
    busy,
    supported,
    automaticDisplays,
    serverOwnsGeometry,
    qualitySupported,
    qualitySupport,
    qualityBusy,
    qualityMessage,
    qualityPolicy,
    queryQuality,
    applyQuality,
    modes,
    availabilityMessage,
    catalogStatusPending: createMemo(() => {
      const info = rpc.daemonInfo();
      return (
        info.phase !== "error" &&
        phase() !== "error" &&
        phase() !== "unsupported" &&
        (info.phase === "loading" || phase() === "connecting")
      );
    }),
    outputHeight,
    maxViewports,
    resize,
    controlling,
    inputReady,
    cursor,
    connect,
    disconnect,
    configure,
    registerSurface,
    registerPreviewSurface: previews.registerPreview,
    registerViewer,
    ownsInput: (viewer: symbol) => inputOwner() === viewer,
    openWindow,
    acquire: (viewer?: symbol) =>
      setAction(DesktopControlAction.Acquire, viewer),
    takeover: (viewer?: symbol) =>
      setAction(DesktopControlAction.Takeover, viewer),
    release: () => setAction(DesktopControlAction.Release),
  };
});

export const managedDesktopBunja = bunja(() => {
  const session = bunja.use(desktopBunja);
  bunja.effect(() => {
    session.start();
    return () => session.stop();
  });
  return session;
});
