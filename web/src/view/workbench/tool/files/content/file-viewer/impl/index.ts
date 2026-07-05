import { type ComponentType, lazy, type LazyExoticComponent } from "react";

export interface FileViewerImpl {
  label: string;
  viewerName: string;
  Component: LazyExoticComponent<ComponentType>;
}

export const fileViewerImpls = {
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

export type FileViewerImplId = keyof typeof fileViewerImpls;

export function getFileViewerImpl(
  impl: FileViewerImplId,
): FileViewerImpl {
  return fileViewerImpls[impl];
}

export function isFileViewerImpl(value: string): value is FileViewerImplId {
  return Object.hasOwn(fileViewerImpls, value);
}
