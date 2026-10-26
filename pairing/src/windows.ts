import { dlopen } from "bun:ffi";
import { fileURLToPath } from "node:url";
import { readFile } from "node:fs/promises";
import { createWindowsTray } from "./windows-tray.ts";
import type { NativeShell } from "./platform.ts";

export async function createWindowsShell(
  onClose: () => void,
  onOpen: () => void,
  onInfo: () => void,
  onQuit: () => void,
): Promise<NativeShell> {
  const native = dlopen(
    fileURLToPath(
      new URL("../native/bin/rieul_pairing_windows.dll", import.meta.url),
    ),
    {
      rieul_pairing_window: { args: ["u32"], returns: "ptr" },
      rieul_pairing_visible: { args: ["ptr"], returns: "i32" },
      rieul_pairing_show: { args: ["ptr", "i32"], returns: "void" },
      rieul_install_close_guard: { args: ["ptr"], returns: "i32" },
      rieul_take_close_requests: { args: [], returns: "u32" },
      rieul_uninstall_close_guard: { args: [], returns: "void" },
    },
  );
  let window = native.symbols.rieul_pairing_window(process.pid);
  for (let i = 0; !window && i < 100; ++i) {
    await new Promise((resolve) => setTimeout(resolve, 20));
    window = native.symbols.rieul_pairing_window(process.pid);
  }
  if (!window) {
    native.close();
    throw new Error("GPUiX native window not found");
  }
  const installed = native.symbols.rieul_install_close_guard(window);
  if (installed <= 0) {
    native.close();
    throw new Error(`close guard installation failed: ${installed}`);
  }
  let tray: ReturnType<typeof createWindowsTray>;
  try {
    tray = createWindowsTray({
      icon: await readFile(
        new URL(
          import.meta.url.endsWith(".js")
            ? "./assets/icon.ico"
            : "../../web/desktop/icon.ico",
          import.meta.url,
        ),
      ),
      onOpen,
      onDaemonInfo: onInfo,
      onQuit,
    });
  } catch (error) {
    native.symbols.rieul_uninstall_close_guard();
    native.close();
    throw error;
  }
  const poll = setInterval(() => {
    if (native.symbols.rieul_take_close_requests()) onClose();
  }, 25);
  let destroyed = false;
  return {
    show() {
      native.symbols.rieul_pairing_show(window, 1);
    },
    hide() {
      native.symbols.rieul_pairing_show(window, 0);
    },
    visible() {
      return !!native.symbols.rieul_pairing_visible(window);
    },
    async notify(title: string, body: string) {
      tray.showBalloon(title, body);
      return true;
    },
    destroy() {
      if (destroyed) return;
      destroyed = true;
      clearInterval(poll);
      tray.destroy();
      native.symbols.rieul_uninstall_close_guard();
      native.close();
    },
  };
}
