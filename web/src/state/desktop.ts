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
} from "solid-js";
import { rpcSessionBunja } from "./rpc-session.ts";
import {
  configureDesktopViewports,
  detachDesktop,
  getDesktopCapabilities,
  renewDesktopLease,
  setDesktopControl,
} from "../protocol/generated/client.ts";
import {
  DesktopAvailability,
  DesktopControlAction,
  DesktopKeyboardMode,
  ProcId,
  type DesktopConfiguration,
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
  const [inputReady, setInputReady] = createSignal(false);
  const [cursor, setCursor] =
    createSignal<Extract<DesktopEvent, { type: "cursor" }>>();
  const supported = createMemo(() => {
    const info = rpc.daemonInfo();
    return (
      info.phase === "ready" &&
      info.daemonInfo.supportedProcIds.includes(ProcId.GetDesktopCapabilities)
    );
  });
  const controlling = createMemo(
    () =>
      inputReady() && !!attachId() && control().holderAttachId === attachId(),
  );
  let active = false,
    generation = 0,
    layoutEpoch = 0,
    lastStats = 0;
  let transport: WebTransport | undefined,
    video: DesktopVideoReceiver | undefined,
    input: DesktopInputChannel | undefined;
  let events: AsyncGenerator<DesktopEvent> | undefined,
    renew: ReturnType<typeof setInterval> | undefined;
  let eventsAbort: AbortController | undefined,
    attachTimeout: ReturnType<typeof setTimeout> | undefined;
  let configKey = "",
    configVersion = 0;
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
    for (const [popup, cleanup] of popups) {
      cleanup();
      popup.close();
    }
    popups.clear();
    if (oldTransport && id)
      void detachDesktop(oldTransport, { attachId: id }).catch(() => {});
    void oldEvents?.return(undefined).catch(() => {});
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
    configKey = key;
    // Popup geometry belongs to one configuration; reopen after a layout change.
    for (const [popup, cleanup] of popups) {
      cleanup();
      popup.close();
    }
    popups.clear();
    await video?.configure(next);
    if (token !== generation) return;
    setConfiguration(next);
  }
  async function configure(ids: string[]) {
    if (!transport || !attachId() || busy()) return;
    const token = generation,
      version = ++configVersion;
    setBusy(true);
    try {
      const selected = displays()
        .filter((d) => ids.includes(d.displayId))
        .slice(0, 8);
      const totalBitrate = 20_000_000;
      const next = await configureDesktopViewports(transport, {
        attachId: attachId()!,
        layoutEpoch,
        totalBitrate,
        viewports: selected.map((d) => {
          const scale = Math.min(
            1,
            1920 / d.bounds.width,
            1080 / d.bounds.height,
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
            width: Math.max(1, Math.floor(d.bounds.width * scale)),
            height: Math.max(1, Math.floor(d.bounds.height * scale)),
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
  async function connect() {
    disconnect();
    if (!active) return;
    const token = generation;
    setMessage(undefined);
    setPhase("connecting");
    try {
      const nextTransport = await rpc.webTransport();
      if (token !== generation) return;
      const caps = await getDesktopCapabilities(nextTransport);
      if (token !== generation) return;
      if (caps.capture !== DesktopAvailability.Available) {
        setPhase("unsupported");
        setMessage(
          caps.reason ??
            "Screen capture is unavailable or needs OS permission.",
        );
        return;
      }
      const codecs = await supportedDesktopCodecs(caps.codecs);
      if (token !== generation) return;
      if (!codecs.length) {
        setPhase("unsupported");
        setMessage(
          "This browser and daemon have no supported video codec in common.",
        );
        return;
      }
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
      );
      attachTimeout = setTimeout(() => {
        if (token === generation) failed(new Error("Desktop attach timed out"));
      }, 10_000);
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
              clearTimeout(attachTimeout);
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
                  if (
                    token === generation &&
                    (next.requestKeyframe ||
                      performance.now() - lastStats > 500)
                  ) {
                    lastStats = performance.now();
                    setStats(next);
                  }
                },
                (error) => {
                  if (token === generation) failed(error);
                },
              );
              setPhase("viewing");
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
              await configure(
                event.displays.slice(0, 8).map((d) => d.displayId),
              );
            } else if (event.type === "control") {
              setControl(event.control);
              if (!controlling()) input?.flush();
            } else if (event.type === "configured")
              await applyConfiguration(event.configuration, token);
            else if (event.type === "layout") {
              send({ type: "releaseAll" });
              layoutEpoch = event.layoutEpoch;
              setDisplays(event.displays);
              await configure(
                event.displays.slice(0, 8).map((d) => d.displayId),
              );
            } else if (event.type === "cursor") setCursor(event);
            else if (event.type === "closed") throw new Error(event.reason);
          }
          if (token === generation)
            failed(
              new Error("Desktop session ended. Reconnect to view again."),
            );
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
      if (token === generation) setControl(next);
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
    popup.document.title = "Rieul desktop";
    popup.document.body.className = "rieul-desktop-window";
    const note = popup.document.createElement("p");
    note.textContent =
      "Move this window to your other monitor. Control is shared with the main viewer.";
    const canvas = popup.document.createElement("canvas");
    canvas.className = "rieul-desktop-canvas";
    canvas.width = track.viewport.width;
    canvas.height = track.viewport.height;
    canvas.tabIndex = 0;
    canvas.setAttribute(
      "aria-label",
      `Remote display ${track.viewport.displayId}`,
    );
    popup.document.body.append(note, canvas);
    const stopStyles = copyDocumentStyles(document, popup.document);
    const releaseSurface = registerSurface(viewportId, canvas);
    const cleanup = () => {
      releaseSurface();
      stopStyles();
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
          disconnect();
          setMessage(undefined);
        });
        return dispose;
      }),
    );
    return () => {
      active = false;
      disconnect();
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
