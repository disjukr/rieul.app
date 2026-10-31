import { type Component, lazy } from "solid-js";
export interface FileViewerImpl {
  label: string;
  viewerName: string;
  Component: Component;
}
export type FileViewerImplId = "markdown" | "pdf" | "text" | "hex" | "image";
export const fileViewerImpls: Record<FileViewerImplId, FileViewerImpl> = {
  markdown: {
    label: "Markdown",
    viewerName: "markdown viewer",
    Component: lazy(() => import("./markdown/index.tsx")),
  },
  pdf: {
    label: "PDF",
    viewerName: "pdf viewer",
    Component: lazy(() => import("./pdf/index.tsx")),
  },
  text: {
    label: "Text",
    viewerName: "text viewer",
    Component: lazy(() => import("./text/index.tsx")),
  },
  hex: {
    label: "Hex",
    viewerName: "hex viewer",
    Component: lazy(() => import("./hex/index.tsx")),
  },
  image: {
    label: "Image",
    viewerName: "image viewer",
    Component: lazy(() => import("./image/index.tsx")),
  },
} as const satisfies Record<string, FileViewerImpl>;

export function getFileViewerImpl(impl: FileViewerImplId): FileViewerImpl {
  return fileViewerImpls[impl];
}
export function isFileViewerImpl(value: string): value is FileViewerImplId {
  return Object.hasOwn(fileViewerImpls, value);
}
