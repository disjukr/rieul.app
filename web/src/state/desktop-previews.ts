import { bunja } from "bunja";
import { createSignal } from "solid-js";
import { MachineIdScope } from "./machine-scopes.ts";
import { rpcSessionBunja } from "./rpc-session.ts";

export const desktopPreviewsBunja = bunja(() => {
  bunja.use(MachineIdScope);
  bunja.use(rpcSessionBunja);
  const sinks = new Map<string, Map<HTMLCanvasElement, number>>();
  const publishers = new Map<string, number>();
  const selected = new Map<string, number>();
  const [previewIds, setPreviewIds] = createSignal<string[]>([]);
  const [publisherIds, setPublisherIds] = createSignal<string[]>([]);
  const [selectedIds, setSelectedIds] = createSignal<string[]>([]);
  function reserveSelected(displayId: string) {
    selected.set(displayId, (selected.get(displayId) ?? 0) + 1);
    setSelectedIds([...selected.keys()]);
    let registered = true;
    return () => {
      if (!registered) return;
      registered = false;
      const count = (selected.get(displayId) ?? 1) - 1;
      if (count) selected.set(displayId, count);
      else selected.delete(displayId);
      setSelectedIds([...selected.keys()]);
    };
  }
  function registerPreview(displayId: string, canvas: HTMLCanvasElement) {
    let canvases = sinks.get(displayId);
    if (!canvases) {
      canvases = new Map();
      sinks.set(displayId, canvases);
    }
    canvases.set(canvas, -Infinity);
    setPreviewIds([...sinks.keys()]);
    let registered = true;
    return () => {
      if (!registered) return;
      registered = false;
      canvases.delete(canvas);
      if (!canvases.size && sinks.get(displayId) === canvases)
        sinks.delete(displayId);
      setPreviewIds([...sinks.keys()]);
    };
  }
  function registerPublisher(displayId: string) {
    publishers.set(displayId, (publishers.get(displayId) ?? 0) + 1);
    setPublisherIds([...publishers.keys()]);
    let registered = true;
    return () => {
      if (!registered) return;
      registered = false;
      const count = (publishers.get(displayId) ?? 1) - 1;
      if (count) publishers.set(displayId, count);
      else publishers.delete(displayId);
      setPublisherIds([...publishers.keys()]);
    };
  }
  function publish(
    displayId: string,
    frame: VideoFrame,
    source: "selected" | "preview",
  ) {
    let drawn = false;
    const now = performance.now();
    for (const [canvas, last] of sinks.get(displayId) ?? []) {
      if (!canvas.isConnected) continue;
      if (source === "selected" && now - last < 1000) continue;
      try {
        const context = canvas.getContext("2d");
        if (!context || context.isContextLost?.()) continue;
        context.drawImage(frame, 0, 0, canvas.width, canvas.height);
        sinks.get(displayId)!.set(canvas, now);
        drawn = true;
      } catch {
        const canvases = sinks.get(displayId)!;
        canvases.delete(canvas);
        if (!canvases.size) sinks.delete(displayId);
        setPreviewIds([...sinks.keys()]);
      }
    }
    return drawn;
  }
  return {
    previewIds,
    publisherIds,
    selectedIds,
    reserveSelected,
    registerPreview,
    registerPublisher,
    publish,
    hasPublisher: (displayId: string) => publishers.has(displayId),
  };
});
