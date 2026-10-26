import { randomInt } from "node:crypto";
import type {
  DaemonInfoModel,
  DaemonMainRoute,
  DaemonMainSnapshot,
} from "../../web/src/desktop-bindings.d.ts";
import * as ipc from "../../web/src/protocol/socket-ipc.ts";
import { validateGuiPayload } from "./validation.ts";

export interface Shell {
  show(): void;
  hide(): void;
  title(value: string): void;
  notify(title: string, body: string): Promise<boolean>;
  openConfig(): Promise<void>;
}

/** No transport or toolkit state: each request owns its cancellation and resolver. */
export class PairingController {
  private route: DaemonMainRoute;
  private pending?: {
    resolve(value: boolean): void;
    signal?: AbortSignal;
    abort(): void;
  };
  private listeners = new Set<(snapshot: DaemonMainSnapshot) => void>();
  private disposed = false;
  private revision = 0;
  readonly info: DaemonInfoModel;
  private shell: Shell;
  constructor(info: DaemonInfoModel, shell: Shell) {
    this.info = info;
    this.shell = shell;
    this.route = { kind: "idle", model: info };
  }
  getSnapshot = async (): Promise<DaemonMainSnapshot> => ({
    desktopApiUrl: "",
    route: this.route,
  });
  get generation() {
    return this.revision;
  }
  subscribe(listener: (snapshot: DaemonMainSnapshot) => void) {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }
  private setRoute(route: DaemonMainRoute) {
    this.route = route;
    ++this.revision;
    this.shell.title(
      route.kind === "pairingCode"
        ? "Pairing code"
        : route.kind === "confirmPairing"
          ? "Confirm pairing"
          : "Daemon info",
    );
    const snapshot = { desktopApiUrl: "", route };
    for (const listener of this.listeners) listener(snapshot);
  }
  private settle(accepted: boolean) {
    const pending = this.pending;
    this.pending = undefined;
    if (!pending) return;
    pending.signal?.removeEventListener("abort", pending.abort);
    pending.resolve(accepted);
  }
  openConfig = async () => {
    this.ensureAlive();
    await this.shell.openConfig();
  };
  showDaemonInfo = async (model = this.info) => {
    this.ensureAlive();
    this.settle(false);
    this.setRoute({ kind: "daemonInfo", model });
    this.shell.show();
  };
  activate() {
    this.ensureAlive();
    this.shell.show();
  }
  close() {
    if (this.disposed) return;
    if (this.route.kind === "confirmPairing") {
      this.settle(false);
      this.setRoute({ kind: "idle", model: this.info });
    }
    this.shell.hide();
  }
  resolvePairingConfirmation = async (
    accepted: boolean,
    generation = this.revision,
  ) => {
    this.ensureAlive();
    if (!this.pending || generation !== this.revision)
      throw new Error("no matching pairing confirmation is pending");
    this.settle(accepted === true);
  };
  async request(
    request: ipc.SocketUnaryRequest,
    signal?: AbortSignal,
  ): Promise<Uint8Array | undefined> {
    this.ensureAlive();
    const payload = request.payload ?? new Uint8Array();
    validateGuiPayload(request.procId, payload);
    switch (request.procId) {
      case ipc.IPC_PROC_SHOW_PAIRING_CODE: {
        const model = ipc.decodeShowPairingCodeReq(payload);
        this.settle(false);
        this.setRoute({ kind: "pairingCode", model });
        return;
      }
      case ipc.IPC_PROC_CONFIRM_PAIRING: {
        const body = ipc.decodeConfirmPairingReq(payload);
        this.settle(false);
        if (signal?.aborted) return ipc.encodeConfirmPairingRes(false);
        const accepted = new Promise<boolean>((resolve) => {
          const abort = () => {
            if (this.pending?.resolve !== resolve) return;
            this.settle(false);
            this.setRoute({ kind: "idle", model: this.info });
            this.shell.hide();
          };
          this.pending = { resolve, signal, abort };
          signal?.addEventListener("abort", abort, { once: true });
        });
        this.setRoute({
          kind: "confirmPairing",
          model: { ...body, candidates: candidates(body.confirmationCode) },
        });
        const generation = this.revision;
        void this.shell
          .notify(
            "Pairing requested",
            `${body.clientLabel.trim() || "Unknown client"} wants to connect.`,
          )
          .catch(() => false)
          .then((shown) => {
            if (
              !shown &&
              !this.disposed &&
              this.pending &&
              this.revision === generation
            )
              this.shell.show();
          });
        return ipc.encodeConfirmPairingRes(await accepted);
      }
      case ipc.IPC_PROC_PAIRING_COMPLETED:
        if (this.route.kind === "pairingCode") {
          this.setRoute({ kind: "idle", model: this.info });
          this.shell.hide();
        }
        return;
      case ipc.IPC_PROC_SHOW_DAEMON_INFO: {
        const body = ipc.decodeShowDaemonInfoReq(payload);
        await this.showDaemonInfo({
          ...this.info,
          configPath: body.configPath || this.info.configPath,
          daemonUrl: body.daemonUrl || this.info.daemonUrl,
        });
        return;
      }
      case ipc.IPC_PROC_ACTIVATE_GUI:
        ipc.decodeActivateGuiReq(payload);
        this.activate();
        return;
      default:
        throw new Error(`unsupported GUI IPC proc id ${request.procId}`);
    }
  }
  dispose() {
    if (this.disposed) return;
    this.disposed = true;
    this.settle(false);
    this.listeners.clear();
  }
  private ensureAlive() {
    if (this.disposed) throw new Error("pairing utility disposed");
  }
}

function candidates(code: string): string[] {
  const digits = [...code]
    .filter((c) => /\d/.test(c))
    .join("")
    .slice(0, 2);
  const result = [digits.length === 2 ? digits : "00"];
  while (result.length < 4) {
    const candidate = randomInt(100).toString().padStart(2, "0");
    if (!result.includes(candidate)) result.push(candidate);
  }
  for (let i = result.length - 1; i > 0; --i) {
    const j = randomInt(i + 1);
    [result[i], result[j]] = [result[j]!, result[i]!];
  }
  return result;
}
