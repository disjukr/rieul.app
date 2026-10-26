// Source adapter only: intentionally not selected by host.ts until macOS QA.
import { dlopen } from "bun:ffi";
import { fileURLToPath } from "node:url";
import type { NativeShell, ShellCallbacks } from "./platform.ts";

export function createMacosShell(callbacks: ShellCallbacks): NativeShell {
  if (process.platform !== "darwin")
    throw new Error("AppKit bridge requires macOS");
  const native = dlopen(
    fileURLToPath(
      new URL("../native/bin/librieul_pairing_macos.dylib", import.meta.url),
    ),
    {
      rieul_macos_init: { args: ["ptr"], returns: "i32" },
      rieul_macos_take_events: { args: [], returns: "u32" },
      rieul_macos_show: { args: ["i32"], returns: "i32" },
      rieul_macos_visible: { args: [], returns: "i32" },
      rieul_macos_destroy: { args: [], returns: "i32" },
    },
  );
  const result = native.symbols.rieul_macos_init(null);
  if (result !== 1) {
    native.close();
    throw new Error(
      `AppKit bridge initialization failed (${result}); requires an existing GPUiX window on the AppKit main thread`,
    );
  }
  let disposed = false;
  const timer = setInterval(() => {
    const events = native.symbols.rieul_macos_take_events();
    if (events & 1) callbacks.onClose();
    if (events & 2) callbacks.onOpen();
    if (events & 4) callbacks.onDaemonInfo();
    if (events & 8) callbacks.onQuit();
  }, 25);
  return {
    show() {
      if (!native.symbols.rieul_macos_show(1))
        throw new Error("AppKit show requires main thread");
    },
    hide() {
      if (!native.symbols.rieul_macos_show(0))
        throw new Error("AppKit hide requires main thread");
    },
    visible() {
      return !!native.symbols.rieul_macos_visible();
    },
    async notify() {
      return false;
    }, // Visible-window fallback; requests no notification permission.
    destroy() {
      if (disposed) return;
      // Never unload a library whose delegate remains installed.
      if (!native.symbols.rieul_macos_destroy())
        throw new Error("AppKit disposal requires main thread");
      disposed = true;
      clearInterval(timer);
      native.close();
    },
  };
}
