import { dlopen } from "bun:ffi";
import { fileURLToPath } from "node:url";
import type { NativeShell, ShellCallbacks } from "./platform.ts";

export async function createMacosShell(
  callbacks: ShellCallbacks,
): Promise<NativeShell> {
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
      rieul_macos_close: { args: [], returns: "i32" },
      rieul_macos_notify: { args: ["ptr", "ptr"], returns: "u32" },
      rieul_macos_notification_result: { args: ["u32"], returns: "i32" },
    },
  );
  let result = native.symbols.rieul_macos_init(null);
  for (let attempt = 0; result === 0 && attempt < 100; attempt++) {
    await new Promise((resolve) => setTimeout(resolve, 20));
    result = native.symbols.rieul_macos_init(null);
  }
  if (result !== 1) {
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
    requestClose() {
      if (!native.symbols.rieul_macos_close())
        throw new Error("AppKit close requires main thread");
    },
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
    async notify(title, body) {
      const token = native.symbols.rieul_macos_notify(
        Buffer.from(`${title}\0`),
        Buffer.from(`${body}\0`),
      );
      if (!token) return false;
      for (let attempt = 0; !disposed && attempt < 80; attempt++) {
        const result = native.symbols.rieul_macos_notification_result(token);
        if (result !== 0) return result === 1;
        await new Promise((resolve) => setTimeout(resolve, 25));
      }
      return false;
    }, // Never requests permission; unapproved/unavailable notifications use the window fallback.
    destroy() {
      if (disposed) return;
      // Never unload a library whose delegate remains installed.
      if (!native.symbols.rieul_macos_destroy())
        throw new Error("AppKit disposal requires main thread");
      disposed = true;
      clearInterval(timer);
      // Objective-C classes and asynchronous UN blocks keep code pointers. The
      // process owns this tiny library until exit; only UI resources are disposed.
    },
  };
}
