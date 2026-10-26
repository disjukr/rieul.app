import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { PairingController, type Shell } from "./controller.ts";
import { profile, endpoint, daemonInfo } from "./profile.ts";
import { activateExisting, startIpc } from "./ipc.ts";
import type { HostToUi, UiToHost } from "./messages.ts";

if (process.platform !== "win32")
  throw new Error(
    "GPUiX pairing macOS shell is unverified; use the existing CEF launcher",
  );
const index = process.argv.indexOf("--config");
const config = index >= 0 ? process.argv[index + 1] : undefined;
if (index >= 0 && !config) throw new Error("--config requires a path");
const identity = await profile(
  config ??
    path.join(
      process.env.ProgramData ?? "C:\\ProgramData",
      "Rieul",
      "rieul.yaml",
    ),
);
const address = endpoint(identity.profileId);
if (await activateExisting(address)) process.exit(0);
let ready = false,
  visible = false,
  title = "Daemon info",
  serial = 0;
const pending = new Map<
  number,
  {
    resolve(value: unknown): void;
    reject(error: Error): void;
    timer: ReturnType<typeof setTimeout>;
  }
>();
const send = (message: HostToUi) => {
  if (ui?.connected) ui.send(message);
};
function call(method: "notify" | "openConfig", args: string[] = []) {
  return new Promise<unknown>((resolve, reject) => {
    const id = ++serial;
    const timer = setTimeout(() => {
      pending.delete(id);
      reject(new Error(`UI ${method} timed out`));
    }, 5000);
    pending.set(id, { resolve, reject, timer });
    send({ type: "call", id, method, args });
  });
}
const shell: Shell = {
  show() {
    visible = true;
    if (ready) send({ type: "show" });
  },
  hide() {
    visible = false;
    if (ready) send({ type: "hide" });
  },
  title(value) {
    title = value;
    if (ready) send({ type: "title", value });
  },
  async notify(title, body) {
    return ready
      ? (await call("notify", [title, body]).catch(() => false)) === true
      : false;
  },
  async openConfig() {
    await call("openConfig", [identity.configPath]);
  },
};
const controller = new PairingController(
  await daemonInfo(identity.configPath, identity.profileId),
  shell,
);
const server = await startIpc(address, controller);
if (!server) process.exit(0);
let quitting = false;
async function quit(code = 0) {
  if (quitting) return;
  quitting = true;
  controller.dispose();
  for (const item of pending.values()) {
    clearTimeout(item.timer);
    item.reject(new Error("UI disposed"));
  }
  pending.clear();
  await server!.dispose();
  if (ui && ui.exitCode === null) {
    send({ type: "quit" });
    setTimeout(() => ui?.kill(), 2000).unref();
  } else process.exit(code);
  process.exitCode = code;
}
controller.subscribe((snapshot) => {
  if (ready)
    send({ type: "snapshot", snapshot, generation: controller.generation });
});
const ui = spawn(
  process.env.RIEUL_PAIRING_BUN ?? "bun",
  [
    fileURLToPath(
      new URL(
        import.meta.url.endsWith(".js") ? "./main.js" : "./main.tsx",
        import.meta.url,
      ),
    ),
  ],
  {
    cwd: fileURLToPath(new URL("..", import.meta.url)),
    stdio: ["inherit", "inherit", "inherit", "ipc"],
    windowsHide: true,
  },
);
ui.on("error", (error) => {
  console.error(error.message);
  void quit(1);
});
ui.on("exit", (code) => {
  if (quitting) process.exit(process.exitCode ?? 0);
  else void quit(code ?? 1);
});
ui.on("message", async (message: UiToHost) => {
  if (message.type === "ready") {
    ready = true;
    send({
      type: "initial",
      snapshot: await controller.getSnapshot(),
      generation: controller.generation,
      visible: visible || process.argv.includes("--show"),
      title,
    });
  } else if (message.type === "result") {
    const item = pending.get(message.id);
    if (!item) return;
    pending.delete(message.id);
    clearTimeout(item.timer);
    if (message.error) item.reject(new Error(message.error));
    else item.resolve(message.value);
  } else if (message.type === "action") {
    try {
      switch (message.method) {
        case "close":
          controller.close();
          break;
        case "activate":
          controller.activate();
          break;
        case "showDaemonInfo":
          await controller.showDaemonInfo();
          break;
        case "openConfig":
          await controller.openConfig();
          break;
        case "resolvePairingConfirmation":
          await controller.resolvePairingConfirmation(
            message.args[0] === true,
            message.generation,
          );
          break;
        case "quit":
          await quit();
          break;
        default:
          throw new Error("Unknown UI action");
      }
      send({ type: "actionResult", id: message.id });
    } catch (error) {
      send({ type: "actionResult", id: message.id, error: String(error) });
    }
  }
});
for (const signal of ["SIGINT", "SIGTERM"] as const)
  process.on(signal, () => {
    void quit();
  });
