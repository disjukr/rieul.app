import type { DaemonMainSnapshot } from "../../web/src/desktop-bindings.d.ts";
export type UiAction =
  | "close"
  | "activate"
  | "showDaemonInfo"
  | "openConfig"
  | "resolvePairingConfirmation"
  | "quit";
export type UiToHost =
  | { type: "ready" }
  | { type: "result"; id: number; value?: unknown; error?: string }
  | {
      type: "action";
      id: number;
      method: UiAction;
      args: unknown[];
      generation: number;
    };
export type HostToUi =
  | {
      type: "initial";
      snapshot: DaemonMainSnapshot;
      generation: number;
      visible: boolean;
      title: string;
    }
  | { type: "snapshot"; snapshot: DaemonMainSnapshot; generation: number }
  | { type: "show" | "hide" | "quit" }
  | { type: "title"; value: string }
  | { type: "actionResult"; id: number; error?: string }
  | {
      type: "call";
      id: number;
      method: "notify" | "openConfig";
      args: string[];
    };
