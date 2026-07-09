export type TabSplitDropSide = "left" | "right" | "top" | "bottom";

export interface WorkbenchTabDragData {
  nodeId: string;
  paneId: string;
  tabId: string;
}

export interface WorkbenchTabDropTarget {
  tabId?: string;
  position: "before" | "after" | "end";
}

export type WorkbenchTabDndData = {
  dragData: WorkbenchTabDragData;
  label: string;
  type: "workbench-tab";
};

export type WorkbenchTabDndDropData =
  | {
    kind: "tab";
    paneId: string;
    tabId: string;
    type: "workbench-tab-drop";
  }
  | {
    kind: "tab-strip";
    paneId: string;
    type: "workbench-tab-drop";
  }
  | {
    kind: "pane-body";
    nodeId: string;
    paneId: string;
    type: "workbench-tab-drop";
  };

export function workbenchTabDragId(tabId: string): string {
  return `workbench-tab-drag:${tabId}`;
}

export function workbenchTabDropId(
  paneId: string,
  tabId: string,
): string {
  return `workbench-tab-drop:${paneId}:${tabId}`;
}

export function workbenchTabStripDropId(paneId: string): string {
  return `workbench-tab-strip-drop:${paneId}`;
}

export function workbenchPaneBodyDropId(paneId: string): string {
  return `workbench-pane-body-drop:${paneId}`;
}

export function readWorkbenchTabDndData(
  data: unknown,
): WorkbenchTabDragData | undefined {
  if (!isRecord(data) || data.type !== "workbench-tab") return undefined;
  const dragData = data.dragData;
  if (!isRecord(dragData)) return undefined;
  if (
    typeof dragData.nodeId !== "string" ||
    typeof dragData.paneId !== "string" ||
    typeof dragData.tabId !== "string"
  ) {
    return undefined;
  }
  return {
    nodeId: dragData.nodeId,
    paneId: dragData.paneId,
    tabId: dragData.tabId,
  };
}

export function readWorkbenchTabDndLabel(
  data: unknown,
): string | undefined {
  if (!isRecord(data) || data.type !== "workbench-tab") return undefined;
  return typeof data.label === "string" ? data.label : undefined;
}

export function readWorkbenchTabDndDropData(
  data: unknown,
): WorkbenchTabDndDropData | undefined {
  if (!isRecord(data) || data.type !== "workbench-tab-drop") {
    return undefined;
  }
  if (data.kind === "tab") {
    if (
      typeof data.paneId !== "string" ||
      typeof data.tabId !== "string"
    ) {
      return undefined;
    }
    return {
      kind: "tab",
      paneId: data.paneId,
      tabId: data.tabId,
      type: "workbench-tab-drop",
    };
  }
  if (data.kind === "tab-strip") {
    if (typeof data.paneId !== "string") return undefined;
    return {
      kind: "tab-strip",
      paneId: data.paneId,
      type: "workbench-tab-drop",
    };
  }
  if (data.kind === "pane-body") {
    if (
      typeof data.nodeId !== "string" ||
      typeof data.paneId !== "string"
    ) {
      return undefined;
    }
    return {
      kind: "pane-body",
      nodeId: data.nodeId,
      paneId: data.paneId,
      type: "workbench-tab-drop",
    };
  }
  return undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
