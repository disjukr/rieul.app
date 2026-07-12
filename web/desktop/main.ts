import path from "node:path";
import net from "node:net";
import { fileURLToPath } from "node:url";
import {
  applyWindowsWindowIcon,
  createWindowsCloseGuard,
  removeWindowsMinimizeMaximizeButtons,
  type WindowsCloseGuard,
} from "./windows-window-icon.ts";
import { createWindowsTray, type WindowsTray } from "./windows-tray.ts";
import {
  decodeActivateGuiReq,
  decodeConfirmPairingReq,
  decodeShowDaemonInfoReq,
  decodeShowPairingCodeReq,
  decodeSocketUnaryRequestPrefix,
  encodeActivateGuiReq,
  encodeConfirmPairingRes,
  encodeSocketUnaryErrorResponse,
  encodeSocketUnaryOkResponse,
  encodeSocketUnaryRequest,
  IPC_PROC_ACTIVATE_GUI,
  IPC_PROC_CONFIRM_PAIRING,
  IPC_PROC_PAIRING_COMPLETED,
  IPC_PROC_SHOW_DAEMON_INFO,
  IPC_PROC_SHOW_PAIRING_CODE,
  type SocketUnaryRequest,
} from "../src/protocol/socket-ipc.ts";

interface Args {
  configPath: string;
  devUrl?: string;
}

interface DaemonInfoModel {
  configPath: string;
  daemonUrl: string;
  daemonVersion: string;
  profileId: string;
}

interface PairingCodeModel {
  daemonUrl: string;
  pairingCode: string;
  expiresInSeconds: number;
}

interface PairingConfirmationModel {
  daemonUrl: string;
  confirmationCode: string;
  clientLabel: string;
  candidates: string[];
}

type Route =
  | { kind: "daemonInfo"; model: DaemonInfoModel }
  | { kind: "pairingCode"; model: PairingCodeModel }
  | { kind: "confirmPairing"; model: PairingConfirmationModel }
  | { kind: "idle"; model: DaemonInfoModel };

interface PendingConfirmation {
  resolve(accepted: boolean): void;
}

interface TrayController {
  destroy(): void;
  showBalloon?(title: string, body: string): void;
}

const args = parseArgs(Deno.args);
const configPath = await stablePath(args.configPath);
const profileId = await profileIdForConfigPath(configPath);
const logPath = desktopLogPath(configPath);
const info = await daemonInfo(configPath, profileId);
let route: Route = { kind: "idle", model: info };
let pendingConfirmation: PendingConfirmation | undefined;
let uiShouldBeVisible = false;
let closeGuardInstallGeneration = 0;
const activeNotifications = new Set<Notification>();
let notificationIconDataUrl: Promise<string> | undefined;

await desktopLog(`starting desktop process: profileId=${profileId}`);
if (Deno.build.os === "darwin") {
  Deno.dock?.setVisible?.(false);
}
if (
  Deno.build.os === "windows" &&
  await activateExistingGuiIfRunning(guiEndpoint(profileId))
) {
  await desktopLog("activated existing GUI; exiting duplicate process");
  Deno.exit(0);
}

const assetServer = Deno.serve(handleRequest);
const port = desktopServePort(assetServer);
const desktopApiUrl = `http://127.0.0.1:${port}`;
const appUrl = args.devUrl ??
  `http://127.0.0.1:${port}/daemon-main.html`;
let uiWin = createUiWindow();
let windowsCloseGuard: WindowsCloseGuard | undefined;
if (Deno.build.os === "windows") {
  try {
    windowsCloseGuard = createWindowsCloseGuard(
      windowsCloseGuardPath(),
      () => handleWindowClose(uiWin),
    );
  } catch (error) {
    await desktopLog(
      `failed to load native Windows close guard: ${errorMessage(error)}`,
    );
  }
}
const backgroundWin = new Deno.BrowserWindow({
  frameless: true,
  height: 1,
  noActivate: true,
  width: 1,
});
backgroundWin.hide();
setTimeout(() => backgroundWin.hide(), 0);
const ipcServer = await startGuiIpcServer(profileId);
const tray = await createTray();
const visibilityGuard = setInterval(() => {
  if (!uiShouldBeVisible && !uiWin.isClosed() && uiWin.isVisible()) {
    uiWin.hide();
  }
}, 100);
if (Deno.build.os === "darwin") {
  for (const signal of ["SIGINT", "SIGTERM"] as const) {
    Deno.addSignalListener(signal, () => {
      removeGuiSocket();
      Deno.exit(0);
    });
  }
}
globalThis.addEventListener("unload", () => {
  clearInterval(visibilityGuard);
  windowsCloseGuard?.destroy();
  ipcServer?.close();
  removeGuiSocket();
  tray?.destroy();
});

function removeGuiSocket() {
  if (Deno.build.os !== "darwin") return;
  try {
    Deno.removeSync(guiEndpoint(profileId));
  } catch {
    // The socket may already have been removed during shutdown.
  }
}

async function createTray(): Promise<TrayController | undefined> {
  try {
    if (Deno.build.os === "windows") {
      const tray: WindowsTray = createWindowsTray({
        icon: await Deno.readFile(assetPath("icon.ico")),
        onDaemonInfo: showDaemonInfo,
        onOpen: showWindow,
        onQuit: () => Deno.exit(0),
      });
      await desktopLog("native Windows tray created");
      return tray;
    }

    const tray = new Deno.Tray();
    tray.setIcon(await Deno.readFile(assetPath("tray.png")));
    tray.setTooltip("Rieul");
    tray.setMenu(trayMenuItems());
    tray.addEventListener("click", () => showWindow());
    tray.addEventListener("dblclick", () => showWindow());
    tray.addEventListener("menuclick", (event) => {
      switch (event.detail.id) {
        case "daemonInfo":
          showDaemonInfo();
          break;
        case "quit":
          Deno.exit(0);
      }
    });
    await desktopLog(
      `tray created: trayId=${tray.trayId} bounds=${
        JSON.stringify(tray.getBounds())
      }`,
    );
    return tray;
  } catch (error) {
    await desktopLog(`failed to create tray: ${errorMessage(error)}`);
    return undefined;
  }
}

function createUiWindow(): Deno.BrowserWindow {
  const window = createHiddenUiWindow(routeTitle(route));
  initializeUiWindow(window);
  return window;
}

function createHiddenUiWindow(title: string): Deno.BrowserWindow {
  const window = new Deno.BrowserWindow({
    height: 360,
    resizable: false,
    title,
    width: 640,
  });
  window.hide();
  return window;
}

function initializeUiWindow(window: Deno.BrowserWindow) {
  window.setTitle(routeTitle(route));
  bindWindow(window);
  window.navigate(appUrl);
  setTimeout(() => {
    try {
      const styledWindowCount = removeWindowsMinimizeMaximizeButtons();
      void desktopLog(
        `removed minimize/maximize buttons from ${styledWindowCount} window(s)`,
      );
      if (args.devUrl) {
        const appliedWindowCount = applyWindowsWindowIcon(
          path.resolve(Deno.cwd(), "desktop/icon.ico"),
        );
        void desktopLog(
          `applied dev window icon to ${appliedWindowCount} window(s)`,
        );
      }
    } catch (error) {
      void desktopLog(
        `failed to configure window chrome: ${errorMessage(error)}`,
      );
    }
  }, 0);
}

function bindWindow(window: Deno.BrowserWindow) {
  bindFallbackWindowClose(window);
  window.bind("getSnapshot", async () => ({ desktopApiUrl, route }));
  window.bind("openConfig", async () => {
    await openSystemPath(configPath);
    return null;
  });
  window.bind("showDaemonInfo", async () => {
    showDaemonInfo();
    return null;
  });
  window.bind("resolvePairingConfirmation", async (accepted) => {
    await resolvePairingConfirmation(Boolean(accepted));
    return null;
  });
}

function bindFallbackWindowClose(window: Deno.BrowserWindow) {
  window.addEventListener("close", (event) => {
    event.preventDefault();
    handleWindowClose(window);
  });
}

function handleWindowClose(window: Deno.BrowserWindow) {
  if (window !== uiWin) return;
  uiShouldBeVisible = false;
  void desktopLog("BrowserWindow close requested; hiding window");
  if (route.kind === "confirmPairing") {
    if (pendingConfirmation) void resolvePairingConfirmation(false);
    setRoute({ kind: "idle", model: info });
  }
  window.hide();
  setTimeout(() => {
    if (!window.isClosed()) return;
    for (
      const name of [
        "getSnapshot",
        "openConfig",
        "showDaemonInfo",
        "resolvePairingConfirmation",
      ]
    ) {
      window.unbind(name);
    }
  }, 100);
}

function trayMenuItems(): Deno.MenuItem[] {
  return [
    { item: { id: "daemonInfo", label: "Daemon info", enabled: true } },
    "separator",
    { item: { id: "quit", label: "Quit", enabled: true } },
  ];
}

async function handleRequest(request: Request): Promise<Response> {
  const url = new URL(request.url);
  try {
    if (url.pathname === "/api/gui/open-config") {
      if (!isAllowedUiOrigin(request)) {
        return new Response("Forbidden", { status: 403 });
      }
      if (request.method === "OPTIONS") {
        return withUiCors(new Response(null, { status: 204 }));
      }
      if (request.method !== "POST") {
        return withUiCors(new Response("Method not allowed", { status: 405 }));
      }
      await openSystemPath(configPath);
      return withUiCors(Response.json({ ok: true }));
    }
    if (url.pathname === "/api/gui/resolve-pairing-confirmation") {
      if (!isAllowedUiOrigin(request)) {
        return new Response("Forbidden", { status: 403 });
      }
      if (request.method === "OPTIONS") {
        return withUiCors(new Response(null, { status: 204 }));
      }
      if (request.method !== "POST") {
        return withUiCors(new Response("Method not allowed", { status: 405 }));
      }
      const body = await request.json();
      await resolvePairingConfirmation(Boolean(body?.accepted));
      return withUiCors(Response.json({ ok: true }));
    }
    if (url.pathname === "/") {
      if (args.devUrl) return Response.redirect(args.devUrl, 307);
    }
    return serveAsset(url.pathname);
  } catch (error) {
    return Response.json(
      { error: error instanceof Error ? error.message : String(error) },
      { status: 500 },
    );
  }
}

async function startGuiIpcServer(
  profileId: string,
): Promise<net.Server | undefined> {
  if (Deno.build.os !== "windows" && Deno.build.os !== "darwin") {
    return undefined;
  }
  const endpoint = guiEndpoint(profileId);
  await desktopLog(`starting GUI IPC server: ${endpoint}`);
  const server = net.createServer((socket) => handleIpcSocket(socket));
  try {
    await listenGuiIpc(server, endpoint);
  } catch (error) {
    if (nodeErrorCode(error) === "EADDRINUSE") {
      try {
        await desktopLog(`GUI IPC already listening; activating: ${endpoint}`);
        await activateExistingGui(endpoint);
        Deno.exit(0);
      } catch (activateError) {
        if (Deno.build.os !== "darwin") throw activateError;
        await desktopLog(`removing stale GUI IPC socket: ${endpoint}`);
        await Deno.remove(endpoint).catch((removeError) => {
          if (!(removeError instanceof Deno.errors.NotFound)) throw removeError;
        });
        await listenGuiIpc(server, endpoint);
      }
    } else {
      await desktopLog(
        `failed to start GUI IPC server: ${errorMessage(error)}`,
      );
      throw error;
    }
  }
  await desktopLog(`GUI IPC server listening: ${endpoint}`);
  return server;
}

async function listenGuiIpc(server: net.Server, endpoint: string) {
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(endpoint, () => {
      server.off("error", reject);
      resolve();
    });
  });
}

async function activateExistingGui(endpoint: string) {
  const payload = encodeActivateGuiReq("already-running");
  const request = encodeSocketUnaryRequest(
    1,
    IPC_PROC_ACTIVATE_GUI,
    payload,
  );
  await new Promise<void>((resolve, reject) => {
    const socket = net.createConnection(endpoint);
    let settled = false;
    let timeout: ReturnType<typeof setTimeout> | undefined;
    const finish = (error?: Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      if (!socket.destroyed) socket.destroy();
      if (error) reject(error);
      else resolve();
    };
    timeout = setTimeout(() => {
      finish(new Error(`timed out activating existing GUI: ${endpoint}`));
    }, 5_000);
    socket.once("data", () => {
      // Any response means the existing process handled the activation request.
      finish();
    });
    socket.once("error", finish);
    socket.once("connect", () => {
      socket.end(request);
    });
    socket.once("end", () => finish());
    socket.once("close", (hadError) => {
      if (!hadError) finish();
    });
  });
}

async function activateExistingGuiIfRunning(endpoint: string) {
  try {
    await activateExistingGui(endpoint);
    return true;
  } catch (error) {
    if (["ENOENT", "ECONNREFUSED"].includes(nodeErrorCode(error) ?? "")) {
      return false;
    }
    throw error;
  }
}

function handleIpcSocket(socket: net.Socket) {
  let handled = false;
  let buffer: Uint8Array<ArrayBufferLike> = new Uint8Array();

  socket.on("data", (chunk: Uint8Array<ArrayBufferLike>) => {
    if (handled) return;
    try {
      buffer = concatBytes([buffer, chunk]);
      const request = decodeSocketUnaryRequestPrefix(buffer);
      if (!request) return;
      handled = true;
      void respondToIpcRequest(socket, request);
    } catch (error) {
      socket.destroy(error instanceof Error ? error : new Error(String(error)));
    }
  });
}

async function respondToIpcRequest(
  socket: net.Socket,
  request: SocketUnaryRequest,
) {
  let response: Uint8Array;
  try {
    const payload = await handleIpcUnaryRequest(request);
    response = encodeSocketUnaryOkResponse(request.streamId, payload);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    response = encodeSocketUnaryErrorResponse(request.streamId, message);
  }
  socket.end(response);
}

async function handleIpcUnaryRequest(
  request: SocketUnaryRequest,
): Promise<Uint8Array | undefined> {
  await desktopLog(`received GUI IPC request: procId=${request.procId}`);
  const payload = request.payload ?? new Uint8Array();
  switch (request.procId) {
    case IPC_PROC_SHOW_PAIRING_CODE: {
      const model = decodeShowPairingCodeReq(payload);
      setRoute({ kind: "pairingCode", model });
      return undefined;
    }
    case IPC_PROC_CONFIRM_PAIRING: {
      const body = decodeConfirmPairingReq(payload);
      const accepted = await confirmPairing({
        ...body,
        candidates: confirmationCodeCandidates(body.confirmationCode),
      });
      return encodeConfirmPairingRes(accepted);
    }
    case IPC_PROC_PAIRING_COMPLETED: {
      if (route.kind === "pairingCode") {
        setRoute({ kind: "idle", model: info });
        hideWindow();
      }
      return undefined;
    }
    case IPC_PROC_SHOW_DAEMON_INFO: {
      const body = decodeShowDaemonInfoReq(payload);
      showDaemonInfo({
        ...info,
        configPath: body.configPath || info.configPath,
        daemonUrl: body.daemonUrl || info.daemonUrl,
      });
      return undefined;
    }
    case IPC_PROC_ACTIVATE_GUI: {
      decodeActivateGuiReq(payload);
      showWindow();
      return undefined;
    }
    default:
      throw new Error(`unsupported GUI IPC proc id ${request.procId}`);
  }
}

async function confirmPairing(
  model: PairingConfirmationModel,
): Promise<boolean> {
  if (pendingConfirmation) {
    pendingConfirmation.resolve(false);
    pendingConfirmation = undefined;
  }
  setRoute({ kind: "confirmPairing", model });
  void showPairingNotification(
    "Pairing requested",
    `${pairingClientLabel(model.clientLabel)} wants to connect.`,
  );

  return await new Promise<boolean>((resolve) => {
    pendingConfirmation = { resolve };
  });
}

function showDaemonInfo(model: DaemonInfoModel = info) {
  setRoute({ kind: "daemonInfo", model });
  showWindow();
}

function setRoute(next: Route) {
  route = next;
  if (!uiWin.isClosed()) uiWin.setTitle(routeTitle(next));
  void desktopLog(`route changed: ${next.kind}`);
  publishSnapshot();
}

function publishSnapshot() {
  if (uiWin.isClosed()) return;
  const snapshot = JSON.stringify({ desktopApiUrl, route });
  void uiWin.executeJs(
    `globalThis.dispatchEvent(new CustomEvent('rieul-daemon-snapshot', { detail: ${snapshot} }))`,
  ).catch(() => {});
}

async function resolvePairingConfirmation(accepted: boolean) {
  void desktopLog(`pairing confirmation resolved: accepted=${accepted}`);
  const confirmation = pendingConfirmation;
  if (!confirmation) throw new Error("no pairing confirmation is pending");
  pendingConfirmation = undefined;
  confirmation.resolve(accepted);
}

function routeTitle(currentRoute: Route): string {
  switch (currentRoute.kind) {
    case "confirmPairing":
      return "Confirm pairing";
    case "pairingCode":
      return "Pairing code";
    case "daemonInfo":
    case "idle":
      return "Daemon info";
  }
}

async function openSystemPath(target: string): Promise<void> {
  if (Deno.build.os === "windows") {
    const shell32 = Deno.dlopen(
      "shell32.dll",
      {
        ShellExecuteW: {
          parameters: [
            "pointer",
            "buffer",
            "buffer",
            "pointer",
            "pointer",
            "i32",
          ],
          result: "isize",
        },
      } as const,
    );
    try {
      const result = shell32.symbols.ShellExecuteW(
        null,
        toWideString("open"),
        toWideString(target),
        null,
        null,
        1,
      );
      if (result <= 32n) {
        throw new Error(
          `failed to open ${target}: ShellExecuteW returned ${result}`,
        );
      }
      return;
    } finally {
      shell32.close();
    }
  }

  const command = Deno.build.os === "darwin" ? "open" : "xdg-open";
  const output = await new Deno.Command(command, {
    args: [target],
    stderr: "piped",
    stdout: "null",
  }).output();
  if (!output.success) {
    throw new Error(new TextDecoder().decode(output.stderr).trim());
  }
}

function toWideString(value: string): Uint16Array {
  const result = new Uint16Array(value.length + 1);
  for (let index = 0; index < value.length; index++) {
    result[index] = value.charCodeAt(index);
  }
  return result;
}

function isAllowedUiOrigin(request: Request): boolean {
  const origin = request.headers.get("origin");
  return origin === null || origin === new URL(appUrl).origin;
}

function withUiCors(response: Response): Response {
  const headers = new Headers(response.headers);
  headers.set("access-control-allow-headers", "content-type");
  headers.set("access-control-allow-methods", "POST, OPTIONS");
  headers.set("access-control-allow-origin", new URL(appUrl).origin);
  return new Response(response.body, {
    headers,
    status: response.status,
    statusText: response.statusText,
  });
}

function showWindow() {
  uiShouldBeVisible = true;
  if (uiWin.isClosed()) {
    uiWin = createUiWindow();
  }
  void desktopLog(`showing UI BrowserWindow: windowId=${uiWin.windowId}`);
  uiWin.show();
  scheduleWindowsCloseGuardInstall();
  uiWin.focus();
  publishSnapshot();
  void Deno.dock?.bounce?.();
}

function hideWindow() {
  uiShouldBeVisible = false;
  if (!uiWin.isClosed()) uiWin.hide();
}

function scheduleWindowsCloseGuardInstall() {
  if (!windowsCloseGuard) return;
  const generation = ++closeGuardInstallGeneration;
  const tryInstall = (attempt: number) => {
    if (generation !== closeGuardInstallGeneration || !uiShouldBeVisible) {
      return;
    }
    const result = windowsCloseGuard.install();
    if (result > 0) return;
    if (result === 0 && attempt < 40) {
      setTimeout(() => tryInstall(attempt + 1), 25);
      return;
    }
    void desktopLog(`failed to install native Windows close guard: ${result}`);
  };
  tryInstall(0);
}

async function showPairingNotification(title: string, body: string) {
  if (Deno.build.os === "windows") {
    try {
      if (!tray?.showBalloon) throw new Error("Windows tray is unavailable");
      tray.showBalloon(title, body);
      await desktopLog(`pairing tray balloon shown: ${title}`);
    } catch (error) {
      await desktopLog(`pairing tray balloon failed: ${errorMessage(error)}`);
      showWindow();
    }
    return;
  }

  try {
    let permission = Notification.permission;
    if (permission !== "granted") {
      permission = await Notification.requestPermission();
    }
    await desktopLog(`notification permission: ${permission}`);
    if (permission !== "granted") {
      showWindow();
      return;
    }

    const icon = await getNotificationIconDataUrl();
    const notification = new Notification(title, {
      body,
      icon,
      tag: "rieul-pairing",
    });
    activeNotifications.add(notification);

    let shown = false;
    const fallback = setTimeout(() => {
      if (shown) return;
      void desktopLog(`pairing notification was not shown: ${title}`);
      activeNotifications.delete(notification);
      notification.close();
      showWindow();
    }, 2_000);

    notification.onshow = () => {
      shown = true;
      clearTimeout(fallback);
      void desktopLog(`pairing notification shown: ${title}`);
    };
    notification.onclick = () => {
      activeNotifications.delete(notification);
      notification.close();
      showWindow();
    };
    notification.onclose = () => activeNotifications.delete(notification);
    notification.onerror = () => {
      clearTimeout(fallback);
      activeNotifications.delete(notification);
      void desktopLog(`pairing notification failed: ${title}`);
      showWindow();
    };
  } catch (error) {
    await desktopLog(`pairing notification threw: ${errorMessage(error)}`);
    showWindow();
  }
}

function getNotificationIconDataUrl(): Promise<string> {
  return notificationIconDataUrl ??= Deno.readFile(assetPath("tray.png"))
    .then((bytes) => `data:image/png;base64,${encodeBase64(bytes)}`);
}

function encodeBase64(bytes: Uint8Array): string {
  let binary = "";
  for (let offset = 0; offset < bytes.length; offset += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + 0x8000));
  }
  return btoa(binary);
}

async function serveAsset(rawPathname: string): Promise<Response> {
  const pathname = rawPathname === "/" ? "/daemon-main.html" : rawPathname;
  const distRoot = path.resolve(
    path.dirname(fileURLToPath(import.meta.url)),
    "../dist",
  );
  const filePath = path.resolve(distRoot, `.${decodeURIComponent(pathname)}`);
  if (!filePath.startsWith(distRoot)) {
    return new Response("Not found", { status: 404 });
  }

  try {
    const file = await Deno.readFile(filePath);
    return new Response(file, {
      headers: { "content-type": contentType(filePath) },
    });
  } catch (error) {
    if (error instanceof Deno.errors.NotFound) {
      return new Response("Not found", { status: 404 });
    }
    throw error;
  }
}

async function daemonInfo(
  configPath: string,
  profileId: string,
): Promise<DaemonInfoModel> {
  const config = await readConfig(configPath);
  return {
    configPath,
    daemonUrl: defaultDaemonUrl(config),
    daemonVersion: Deno.env.get("RIEUL_DAEMON_VERSION") ?? "dev",
    profileId,
  };
}

async function readConfig(
  configPath: string,
): Promise<{ listenAddr: string; domain?: string }> {
  let text = "";
  try {
    text = await Deno.readTextFile(configPath);
  } catch (error) {
    if (!(error instanceof Deno.errors.NotFound)) throw error;
  }
  return {
    listenAddr: readYamlScalar(text, "listenAddr") ?? "0.0.0.0:9012",
    domain: readYamlScalar(text, "domain") ?? undefined,
  };
}

function defaultDaemonUrl(
  config: { listenAddr: string; domain?: string },
): string {
  const port = Number(config.listenAddr.split(":").at(-1)) || 9012;
  const domain = config.domain?.trim();
  if (domain) {
    return port === 443 ? `https://${domain}` : `https://${domain}:${port}`;
  }
  return `https://localhost:${port}`;
}

function readYamlScalar(text: string, key: string): string | undefined {
  const match = text.match(
    new RegExp(`^\\s*${key}:\\s*["']?([^"'\\s#]+)`, "m"),
  );
  return match?.[1]?.trim();
}

function confirmationCodeCandidates(code: string): string[] {
  const normalized = normalizeConfirmationCode(code);
  let seed = confirmationCandidateSeed(normalized);
  const candidates = [normalized];
  while (candidates.length < 4) {
    seed = lcgNext(seed);
    const candidate = (seed % 100n).toString().padStart(2, "0");
    if (!candidates.includes(candidate)) candidates.push(candidate);
  }
  for (let index = candidates.length - 1; index > 0; index--) {
    seed = lcgNext(seed);
    const swapIndex = Number(seed % BigInt(index + 1));
    [candidates[index], candidates[swapIndex]] = [
      candidates[swapIndex],
      candidates[index],
    ];
  }
  return candidates;
}

function normalizeConfirmationCode(code: string): string {
  const digits = [...code].filter((char) => /\d/.test(char)).join("").slice(
    0,
    2,
  );
  return digits.length === 2 ? digits : "00";
}

function confirmationCandidateSeed(code: string): bigint {
  let seed = BigInt(Date.now()) ^ 0x9e3779b97f4a7c15n;
  for (const byte of new TextEncoder().encode(code)) {
    seed = ((seed << 5n) | (seed >> 59n)) ^ BigInt(byte);
  }
  return seed & 0xffffffffffffffffn;
}

function lcgNext(seed: bigint): bigint {
  return (seed * 6364136223846793005n + 1n) & 0xffffffffffffffffn;
}

function pairingClientLabel(label: string): string {
  const trimmed = label.trim();
  return trimmed === "" ? "Unknown client" : trimmed;
}

async function profileIdForConfigPath(configPath: string): Promise<string> {
  const profilePath = normalizeProfilePath(configPath);
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(profilePath),
  );
  return [...new Uint8Array(digest).slice(0, 12)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

function normalizeProfilePath(configPath: string): string {
  if (Deno.build.os !== "windows") return configPath;
  if (configPath.startsWith("\\\\?\\UNC\\")) {
    return `\\\\${configPath.slice(8)}`;
  }
  return configPath.startsWith("\\\\?\\") ? configPath.slice(4) : configPath;
}

async function stablePath(rawPath: string): Promise<string> {
  const absolute = path.isAbsolute(rawPath)
    ? rawPath
    : path.resolve(Deno.cwd(), rawPath);
  try {
    return await Deno.realPath(absolute);
  } catch {
    return absolute;
  }
}

function desktopLogPath(configPath: string): string {
  return path.join(path.dirname(configPath), "gui-desktop.log");
}

function guiEndpoint(profileId: string): string {
  if (Deno.build.os === "windows") {
    return `\\\\.\\pipe\\rieul-gui-profile-${profileId}`;
  }
  if (Deno.build.os === "darwin") {
    return `/tmp/rieul-gui-profile-${profileId}-${Deno.uid()}.sock`;
  }
  throw new Error(`GUI IPC is unsupported on ${Deno.build.os}`);
}

function assetPath(relativePath: string): string {
  return path.join(path.dirname(fileURLToPath(import.meta.url)), relativePath);
}

function windowsCloseGuardPath(): string {
  if (args.devUrl) {
    return path.resolve(
      Deno.cwd(),
      "../target/debug/rieul_windows_close_guard.dll",
    );
  }
  return path.join(
    path.dirname(Deno.execPath()),
    "rieul_windows_close_guard.dll",
  );
}

async function desktopLog(message: string) {
  try {
    await Deno.mkdir(path.dirname(logPath), { recursive: true });
    await Deno.writeTextFile(
      logPath,
      `${new Date().toISOString()} ${message}\n`,
      { append: true },
    );
  } catch {
    // Logging must not break the GUI process.
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function nodeErrorCode(error: unknown): string | undefined {
  if (typeof error === "object" && error !== null && "code" in error) {
    return String(error.code);
  }
  return undefined;
}

function parseArgs(args: string[]): Args {
  let configPath = defaultConfigPath();
  let devUrl: string | undefined;
  for (let index = 0; index < args.length; index++) {
    const arg = args[index];
    if (arg === "--config") {
      configPath = args[++index] ?? configPath;
    } else if (arg === "--dev-url") {
      devUrl = args[++index];
    }
  }
  return { configPath, devUrl };
}

function defaultConfigPath(): string {
  if (Deno.build.os === "windows") {
    return path.join(
      Deno.env.get("ProgramData") ?? "C:\\ProgramData",
      "Rieul",
      "rieul.yaml",
    );
  }
  if (Deno.build.os === "darwin") {
    return "/Library/Application Support/rieul/rieul.yaml";
  }
  return path.join(
    Deno.env.get("HOME") ?? ".",
    ".config",
    "rieul",
    "rieul.yaml",
  );
}

function desktopServePort(server: Deno.HttpServer): number {
  const serveAddress = Deno.env.get("DENO_SERVE_ADDRESS");
  const port = Number(serveAddress?.split(":").at(-1));
  if (Number.isSafeInteger(port) && port > 0) return port;
  if (server.addr.transport === "tcp") return server.addr.port;
  throw new Error(
    `unsupported desktop serve transport: ${server.addr.transport}`,
  );
}

function contentType(filePath: string): string {
  const ext = path.extname(filePath).toLowerCase();
  if (ext === ".html") return "text/html; charset=utf-8";
  if (ext === ".js") return "text/javascript; charset=utf-8";
  if (ext === ".css") return "text/css; charset=utf-8";
  if (ext === ".svg") return "image/svg+xml";
  if (ext === ".ico") return "image/x-icon";
  if (ext === ".json") return "application/json; charset=utf-8";
  return "application/octet-stream";
}

function concatBytes(
  chunks: Array<Uint8Array<ArrayBufferLike>>,
): Uint8Array<ArrayBufferLike> {
  const total = chunks.reduce((sum, chunk) => sum + chunk.byteLength, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return out;
}
