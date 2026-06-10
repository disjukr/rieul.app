export type FileViewerKind = "text" | "hex";

export type FileSniffState =
  | { phase: "sniffing" }
  | { phase: "ready"; initialBytes: Uint8Array; kind: FileViewerKind }
  | { phase: "error"; message: string };

export type FileReadState =
  | { phase: "loading" }
  | { phase: "ready"; text: string }
  | { phase: "error"; message: string };
