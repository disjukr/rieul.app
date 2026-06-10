import type { FsEntry } from "../../../../protocol/rpc.ts";

export interface EntryMenuState {
  entry: FsEntry;
  x: number;
  y: number;
}

export type FilePreview =
  | { kind: "text"; text: string }
  | { kind: "binary"; text: string };

export type FileLoadState =
  | { phase: "loading" }
  | { phase: "ready"; byteLength: number; preview: FilePreview }
  | { phase: "error"; message: string };
