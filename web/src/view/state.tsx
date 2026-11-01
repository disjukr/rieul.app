import { bunja } from "bunja";
import { createMemo, createSignal } from "solid-js";

const machinePanelMinWidth = 176;
const machinePanelMaxWidth = 320;
const machinePanelTransitionMs = 180;
const minimumWorkbenchWidth = 360;
const machineRailWidth = 48;
const machinePanelCollapsedStorageKey = "rieul.machine-panel-collapsed.v1";
const machinePanelWidthStorageKey = "rieul.app-rail-width.v1";

type MachinePanelWidthUpdate = number | ((width: number) => number);

export const layoutBunja = bunja(() => {
  function readMachinePanelWidth(): number {
    try {
      const stored = globalThis.localStorage?.getItem(
        machinePanelWidthStorageKey,
      );
      return stored === null || stored === undefined ? 204 : JSON.parse(stored);
    } catch {
      return 204;
    }
  }
  function readMachinePanelCollapsed(): boolean {
    try {
      const stored = globalThis.localStorage?.getItem(
        machinePanelCollapsedStorageKey,
      );
      return stored === null || stored === undefined
        ? false
        : JSON.parse(stored);
    } catch {
      return false;
    }
  }
  const [storedMachinePanelWidth, setStoredMachinePanelWidth] = createSignal(
    readMachinePanelWidth(),
  );
  const machinePanelWidth = createMemo(() =>
    clampMachinePanelWidth(storedMachinePanelWidth()),
  );
  const [machinePanelCollapsed, updateMachinePanelCollapsed] = createSignal(
    readMachinePanelCollapsed(),
  );
  const [machinePanelTransitioning, setMachinePanelTransitioning] =
    createSignal(false);

  function setMachinePanelWidth(update: MachinePanelWidthUpdate) {
    const next = setStoredMachinePanelWidth((current) =>
      clampMachinePanelWidth(
        typeof update === "function" ? update(current) : update,
      ),
    );
    globalThis.localStorage?.setItem(
      machinePanelWidthStorageKey,
      JSON.stringify(next),
    );
  }
  function setMachinePanelCollapsed(
    update: boolean | ((collapsed: boolean) => boolean),
  ) {
    const next = updateMachinePanelCollapsed((current) =>
      typeof update === "function" ? update(current) : update,
    );
    globalThis.localStorage?.setItem(
      machinePanelCollapsedStorageKey,
      JSON.stringify(next),
    );
  }
  let machinePanelTransitionTimeout:
    | ReturnType<typeof globalThis.setTimeout>
    | undefined;

  let stopActiveResize: (() => void) | undefined;

  bunja.effect(() => {
    function onStorage(event: StorageEvent) {
      if (event.storageArea !== globalThis.localStorage) return;
      if (event.key === machinePanelWidthStorageKey)
        setStoredMachinePanelWidth(readMachinePanelWidth());
      if (event.key === machinePanelCollapsedStorageKey)
        updateMachinePanelCollapsed(readMachinePanelCollapsed());
    }
    globalThis.addEventListener?.("storage", onStorage);
    return () => {
      globalThis.removeEventListener?.("storage", onStorage);
      stopActiveResize?.();
      if (machinePanelTransitionTimeout !== undefined) {
        globalThis.clearTimeout(machinePanelTransitionTimeout);
        machinePanelTransitionTimeout = undefined;
      }
      setMachinePanelTransitioning(false);
    };
  });

  function clampMachinePanelWidth(width: number) {
    const maxByViewport = Math.max(
      machinePanelMinWidth,
      globalThis.innerWidth - machineRailWidth - minimumWorkbenchWidth,
    );
    return Math.round(
      Math.min(
        Math.max(width, machinePanelMinWidth),
        Math.min(machinePanelMaxWidth, maxByViewport),
      ),
    );
  }

  function startMachinePanelResize(event: PointerEvent) {
    event.preventDefault();
    stopActiveResize?.();
    setMachinePanelTransitioning(false);
    const initialX = event.clientX;
    // A resize may follow another command before Solid commits its frame.
    const initialWidth = clampMachinePanelWidth(
      setStoredMachinePanelWidth((width) => width),
    );
    const previousCursor = document.body.style.cursor;
    const previousUserSelect = document.body.style.userSelect;

    document.body.style.cursor = "col-resize";
    document.body.style.userSelect = "none";

    function resize(moveEvent: PointerEvent) {
      setMachinePanelWidth(
        clampMachinePanelWidth(initialWidth + moveEvent.clientX - initialX),
      );
    }

    function stopResize() {
      stopActiveResize = undefined;
      document.body.style.cursor = previousCursor;
      document.body.style.userSelect = previousUserSelect;
      globalThis.removeEventListener("pointermove", resize);
      globalThis.removeEventListener("pointerup", stopResize);
      globalThis.removeEventListener("pointercancel", stopResize);
    }

    stopActiveResize = stopResize;
    globalThis.addEventListener("pointermove", resize);
    globalThis.addEventListener("pointerup", stopResize);
    globalThis.addEventListener("pointercancel", stopResize);
  }

  function resizeMachinePanelWithKeyboard(event: KeyboardEvent) {
    const step = event.shiftKey ? 40 : 16;
    if (event.key === "ArrowLeft") {
      event.preventDefault();
      setMachinePanelTransitioning(false);
      setMachinePanelWidth((width) => clampMachinePanelWidth(width - step));
    }
    if (event.key === "ArrowRight") {
      event.preventDefault();
      setMachinePanelTransitioning(false);
      setMachinePanelWidth((width) => clampMachinePanelWidth(width + step));
    }
    if (event.key === "Home") {
      event.preventDefault();
      setMachinePanelTransitioning(false);
      setMachinePanelWidth(machinePanelMinWidth);
    }
    if (event.key === "End") {
      event.preventDefault();
      setMachinePanelTransitioning(false);
      setMachinePanelWidth((width) =>
        clampMachinePanelWidth(Math.max(width, machinePanelMaxWidth)),
      );
    }
  }

  function toggleMachinePanel() {
    if (machinePanelTransitionTimeout !== undefined) {
      globalThis.clearTimeout(machinePanelTransitionTimeout);
    }
    setMachinePanelTransitioning(true);
    setMachinePanelCollapsed((collapsed) => !collapsed);
    machinePanelTransitionTimeout = globalThis.setTimeout(() => {
      setMachinePanelTransitioning(false);
      machinePanelTransitionTimeout = undefined;
    }, machinePanelTransitionMs);
  }

  return {
    machinePanelCollapsed,
    machinePanelMaxWidth,
    machinePanelMinWidth,
    machinePanelTransitioning,
    machinePanelWidth,
    setMachinePanelWidth,
    setMachinePanelCollapsed,
    setMachinePanelTransitioning,
    resizeMachinePanelWithKeyboard,
    startMachinePanelResize,
    toggleMachinePanel,
  };
});
