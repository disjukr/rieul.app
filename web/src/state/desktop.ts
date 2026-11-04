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
import {
  configureDesktopViewports,
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
  const rpc = bunja.use(rpcSessionBunja);
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
  const qualitySupported = createMemo(() => {
    const info = rpc.daemonInfo();
    return (
      info.phase === "ready" &&
      [
        ProcId.AttachExistingDesktop,
        ProcId.QueryDesktopQualitySupport,
        ProcId.SetDesktopQuality,
      ].every((id) => info.daemonInfo.supportedProcIds.includes(id))
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
      info.phase === "ready" &&
      info.daemonInfo.supportedProcIds.includes(ProcId.AttachExistingDesktop)
    );
  });
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
  let configKey = "",
    configVersion = 0;
  let offeredCodecs: string[] = [],
    currentCodec = "",
    h264Fallback = false;
  let inputFeatures: Pick<DesktopCapabilities, "physicalKeys" | "wheelUnits"> =
    {};
  const surfaces = new Map<string, Set<HTMLCanvasElement>>();
  const popups = new Map<Window, () => void>();
  function disconnect() {
    generation++;
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
    setCursor(undefined);
    setAttachId(undefined);
    setConfiguration(undefined);
    setControl({ inputEpoch: 0 });
    setDisplays([]);
    setBusy(false);
    setPhase("idle");
  }
  function failed(error: unknown) {
    if (
      active &&
      !h264Fallback &&
      currentCodec.startsWith("av01.") &&
      offeredCodecs.some((c) => /^avc[13]\./.test(c))
    ) {
      void connect(true);
      return;
    }
    disconnect();
    if (active) {
      setPhase("error");
      setMessage(error instanceof Error ? error.message : String(error));
    }
  }
  function send(event: DesktopInputEvent): boolean {
    return controlling() && !!input?.send(event);
  }
  function registerSurface(
    viewportId: string,
    canvas: HTMLCanvasElement,
  ): () => void {
    let set = surfaces.get(viewportId);
    if (!set) {
      set = new Set();
      surfaces.set(viewportId, set);
    }
    set.add(canvas);
    const cleanup = bindDesktopInput(canvas, viewportId, send, () => ({
      active: controlling(),
      epoch: control().inputEpoch,
      ...inputFeatures,
    }));
    return () => {
      cleanup();
      set!.delete(canvas);
      if (set!.size === 0) surfaces.delete(viewportId);
    };
  }
  async function applyConfiguration(next: DesktopConfiguration, token: number) {
    const key = JSON.stringify(next);
    if (key === configKey) return;
    const previous = configuration();
    if (
      previous &&
      (next.layoutEpoch < previous.layoutEpoch ||
        (next.layoutEpoch === previous.layoutEpoch &&
          Math.max(0, ...next.tracks.map((t) => t.codecEpoch)) <
            Math.max(0, ...previous.tracks.map((t) => t.codecEpoch))))
    )
      return;
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
    await video?.configure(next);
    if (token !== generation) return;
    setConfiguration(next);
  }
  async function queryQuality(candidate?: DesktopQualityTarget) {
    if (!transport || !attachId() || !qualitySupported() || qualityBusy())
      return;
    const token = generation;
    setQualityBusy(true);
    setQualityMessage(undefined);
    setQualitySupport(undefined);
    try {
      const support = await queryDesktopQualitySupport(transport, {
        attachId: attachId()!,
        candidates: candidate ? [candidate] : undefined,
      });
      if (token !== generation) return;
      setQualitySupport(support);
      setQualityPolicy(support.policy);
    } catch (error) {
      if (token === generation) setQualityMessage(String(error));
    } finally {
      if (token === generation) setQualityBusy(false);
    }
  }
  async function applyQuality(policy: DesktopQualityPolicy) {
    const support = qualitySupport();
    if (!support || !transport || !attachId() || qualityBusy()) return;
    const token = generation;
    setQualityBusy(true);
    setQualityMessage(undefined);
    try {
      await setDesktopQuality(transport, {
        attachId: attachId()!,
        layoutEpoch: support.layoutEpoch,
        revision: support.revision,
        policy,
      });
      if (token !== generation) return;
      setQualityPolicy(policy);
      setQualitySupport(undefined);
    } catch (error) {
      if (token === generation) {
        setQualityMessage(
          `${String(error)}. Check support again before retrying.`,
        );
        setQualitySupport(undefined);
      }
    } finally {
      if (token === generation) setQualityBusy(false);
    }
  }
  async function configure(
    ids: string[],
    attachment = attachId(),
    layout?: DesktopDisplay[],
  ) {
    if (automaticDisplays() || !transport || !attachment || (busy() && !layout))
      return;
    const token = generation,
      version = ++configVersion;
    setBusy(true);
    try {
      send({ type: "releaseAll" });
      await input?.flush();
      if (token !== generation) return;
      const selected = (layout ?? displays())
        .filter((d) => ids.includes(d.displayId))
        .slice(0, maxViewports());
      const totalBitrate = 20_000_000;
      const next = await configureDesktopViewports(transport, {
        attachId: attachment,
        layoutEpoch,
        totalBitrate,
        viewports: selected.map((d) => {
          const scale = Math.min(
            1,
            (outputHeight() * 16) / 9 / d.bounds.width,
            outputHeight() / d.bounds.height,
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
            width: Math.max(2, Math.floor((d.bounds.width * scale) / 2) * 2),
            height: Math.max(2, Math.floor((d.bounds.height * scale) / 2) * 2),
            fps: 60,
            bitrate: Math.floor(totalBitrate / Math.max(1, selected.length)),
          };
        }),
      });
      if (token === generation && version === configVersion)
        await applyConfiguration(next, token);
    } catch (error) {
      if (token === generation) failed(error);
    } finally {
      if (token === generation) setBusy(false);
    }
  }
  async function resize(height: number) {
    if (automaticDisplays() || ![720, 1080, 2160].includes(height) || busy())
      return;
    setOutputHeight(height);
    if (phase() === "viewing")
      await configure(
        configuration()?.tracks.map((t) => t.viewport.displayId) ?? [],
      );
  }
  async function connect(h264Only = false) {
    disconnect();
    h264Fallback = h264Only;
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
      transport = nextTransport;
      eventsAbort = new AbortController();
      const iterator = desktopEvents(
        nextTransport,
        {
          profile: 1,
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
              setMessage(caps.reason);
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
                    `${error.message} View remains connected; reconnect to control.`,
                  );
                  void setDesktopControl(nextTransport, {
                    attachId: event.attachId,
                    action: DesktopControlAction.Release,
                  }).catch(() => {});
                },
              );
              video = new DesktopVideoReceiver(
                nextTransport,
                event.attachId,
                (viewportId, frame) => {
                  for (const canvas of surfaces.get(viewportId) ?? []) {
                    const ctx = canvas.getContext("2d");
                    ctx?.drawImage(frame, 0, 0, canvas.width, canvas.height);
                  }
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
                  if (token === generation && codec.startsWith("av01."))
                    failed(new Error("AV1 decoder failed"));
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
                await configure(
                  event.displays
                    .slice(0, maxViewports())
                    .map((d) => d.displayId),
                  event.attachId,
                  event.displays,
                );
                if (token === generation) setPhase("viewing");
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
              configKey = "";
              send({ type: "releaseAll" });
              layoutEpoch = event.layoutEpoch;
              setDisplays(event.displays);
              setConfiguration(undefined);
              if (!automaticDisplays())
                await configure(
                  event.displays
                    .slice(0, maxViewports())
                    .map((d) => d.displayId),
                  attachId(),
                  event.displays,
                );
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
  async function setAction(action: DesktopControlAction) {
    if (
      !transport ||
      !attachId() ||
      busy() ||
      (action !== DesktopControlAction.Release && !inputReady())
    )
      return;
    const token = generation;
    setBusy(true);
    try {
      if (action === DesktopControlAction.Release) {
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
        setMessage(undefined);
      }
    } catch (error) {
      if (token === generation)
        setMessage(error instanceof Error ? error.message : String(error));
    } finally {
      if (token === generation) setBusy(false);
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
  bunja.effect(() => {
    active = true;
    const dispose = runWithOwner(owner, () =>
      createRoot((dispose) => {
        createEffect(rpc.daemonInfo, () => {
          untrack(disconnect);
          setMessage(undefined);
        });
        return dispose;
      }),
    );
    return () => {
      active = false;
      untrack(disconnect);
      dispose();
    };
  });
  return {
    phase,
    message,
    displays,
    configuration,
    control,
    attachId,
    stats,
    busy,
    supported,
    automaticDisplays,
    qualitySupported,
    qualitySupport,
    qualityBusy,
    qualityMessage,
    qualityPolicy,
    queryQuality,
    applyQuality,
    modes,
    availabilityMessage,
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
    openWindow,
    acquire: () => setAction(DesktopControlAction.Acquire),
    takeover: () => setAction(DesktopControlAction.Takeover),
    release: () => setAction(DesktopControlAction.Release),
  };
});
