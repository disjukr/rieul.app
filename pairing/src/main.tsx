import { spawn } from "node:child_process";
import { dlopen } from "bun:ffi";
import { createRoot, GpuixRenderer } from "@gpuix/solid";
import { createRendererState } from "@gpuix/native/host";
import { startFrameLoop, enableAutomation } from "@gpuix/native/runtime";
import { createWindowsShell } from "./windows.ts";
import { PairingView, type ViewController } from "./view.tsx";
import type { DaemonMainSnapshot } from "../../web/src/desktop-bindings.d.ts";
import type { HostToUi, UiToHost, UiAction } from "./messages.ts";

if (!process.send)
  throw new Error(
    "Launch through Node src/host.ts; direct Bun IPC is unsupported",
  );
const send = (message: UiToHost) => process.send!(message);
let serial = 0,
  generation = 0;
let snapshot: DaemonMainSnapshot | undefined;
const snapshotEvents = new EventTarget();
const listeners = new Set<(snapshot: DaemonMainSnapshot) => void>();
const pending = new Map<
  number,
  { resolve(): void; reject(error: Error): void }
>();
function action(method: UiAction, args: unknown[] = [], version = generation) {
  return new Promise<void>((resolve, reject) => {
    const id = ++serial;
    pending.set(id, { resolve, reject });
    send({ type: "action", id, method, args, generation: version });
  });
}
const controller: ViewController = {
  getSnapshot: async () => {
    if (!snapshot) throw new Error("Snapshot not initialized");
    return snapshot;
  },
  get generation() {
    return generation;
  },
  subscribe(listener) {
    listeners.add(listener);
    return () => {
      listeners.delete(listener);
    };
  },
  showDaemonInfo: () => action("showDaemonInfo"),
  openConfig: () => action("openConfig"),
  resolvePairingConfirmation: (accepted, version) =>
    action("resolvePairingConfirmation", [accepted], version),
  close: () => {
    void action("close");
  },
};
const renderer = new GpuixRenderer((error, event) => {
  if (error) console.error(error);
  else createRendererState(renderer).dispatch(event);
});
renderer.init({
  title: "Daemon info",
  width: 680,
  height: 410,
  show: false,
  focus: false,
  resizable: false,
});
const windows = await createWindowsShell(
  () => {
    void action("close");
  },
  () => {
    void action("activate");
  },
  () => {
    void action("showDaemonInfo");
  },
  () => {
    void action("quit");
  },
);
const root = createRoot(renderer);
const loop = startFrameLoop(renderer, { onTerminated: () => dispose() });
let disposed = false;
function dispose() {
  if (disposed) return;
  disposed = true;
  loop.stop();
  root.unmount();
  windows.destroy();
  for (const item of pending.values()) item.reject(new Error("UI disposed"));
  pending.clear();
  listeners.clear();
  process.exit(0);
}
process.on("disconnect", dispose);
process.on("message", async (message: HostToUi) => {
  switch (message.type) {
    case "initial":
      snapshot = message.snapshot;
      generation = message.generation;
      root.render(() => (
        <PairingView
          controller={controller}
          initial={message.snapshot}
          copy={copyText}
        />
      ));
      renderer.setWindowTitle(message.title);
      if (message.visible) {
        renderer.activateWindow();
        windows.show();
      }
      root.flush();
      if (process.env.RIEUL_PAIRING_AUTOMATION === "1")
        enableAutomation(renderer);
      break;
    case "snapshot":
      snapshot = message.snapshot;
      generation = message.generation;
      snapshotEvents.dispatchEvent(
        new CustomEvent("rieul-daemon-snapshot", { detail: snapshot }),
      );
      for (const listener of listeners) listener(message.snapshot);
      break;
    case "show":
      renderer.activateWindow();
      windows.show();
      break;
    case "hide":
      windows.hide();
      break;
    case "title":
      renderer.setWindowTitle(message.value);
      break;
    case "quit":
      dispose();
      break;
    case "actionResult": {
      const item = pending.get(message.id);
      if (!item) break;
      pending.delete(message.id);
      if (message.error) item.reject(new Error(message.error));
      else item.resolve();
      break;
    }
    case "call":
      try {
        let value: unknown;
        if (message.method === "notify")
          value = await windows.notify(message.args[0], message.args[1]);
        else if (message.method === "openConfig") {
          const library = dlopen("shell32.dll", {
            ShellExecuteW: {
              args: ["ptr", "ptr", "ptr", "ptr", "ptr", "i32"],
              returns: "i64",
            },
          });
          try {
            const result = library.symbols.ShellExecuteW(
              null,
              Buffer.from("open\0", "utf16le"),
              Buffer.from(`${message.args[0]}\0`, "utf16le"),
              null,
              null,
              1,
            );
            if (result <= 32n)
              throw new Error(`Open config failed (${result})`);
          } finally {
            library.close();
          }
        } else throw new Error("Unknown shell call");
        send({ type: "result", id: message.id, value });
      } catch (error) {
        send({ type: "result", id: message.id, error: String(error) });
      }
  }
});
// Same four bindings and named snapshot event; no HTTP mutation endpoint is needed.
Reflect.set(globalThis, "bindings", {
  getSnapshot: controller.getSnapshot,
  openConfig: controller.openConfig,
  showDaemonInfo: controller.showDaemonInfo,
  resolvePairingConfirmation: controller.resolvePairingConfirmation,
});
Reflect.set(globalThis, "rieulDesktopEvents", snapshotEvents);
send({ type: "ready" });
async function copyText(text: string) {
  await new Promise<void>((resolve, reject) => {
    const child = spawn(
      "powershell.exe",
      [
        "-NoProfile",
        "-NonInteractive",
        "-Command",
        "Set-Clipboard -Value ([Console]::In.ReadToEnd())",
      ],
      { windowsHide: true, stdio: ["pipe", "ignore", "pipe"] },
    );
    child.once("error", reject);
    child.once("exit", (code) =>
      code === 0 ? resolve() : reject(new Error(`Clipboard failed (${code})`)),
    );
    child.stdin.end(text);
  });
}
