import { useEffect, useState } from "react";
import {
  type CollisionDetection,
  DndContext,
  type DragEndEvent,
  type DragMoveEvent,
  type DragOverEvent,
  DragOverlay,
  type DragStartEvent,
  MouseSensor,
  pointerWithin,
  rectIntersection,
  TouchSensor,
  useSensor,
  useSensors,
} from "@dnd-kit/core";
import { useAtomValue } from "jotai";
import { useBunja } from "bunja/react";
import {
  type LayoutNode,
  layoutReducer,
  type LayoutState,
  Pane,
  Root as PaneRoot,
} from "panecake";
import {
  type TabDropPosition,
  workbenchBunja,
  WorkbenchPaneIdContext,
} from "../../../state/workbench.ts";
import { PaneDivider } from "./pane-divider.tsx";
import { WorkbenchPaneView } from "./pane-view.tsx";
import {
  readWorkbenchTabDndData,
  readWorkbenchTabDndDropData,
  readWorkbenchTabDndLabel,
  type TabSplitDropSide,
  type WorkbenchTabDragData,
  type WorkbenchTabDropTarget,
} from "./tab-drag.ts";

const paneRootClassName = [
  "workbench-pane-root",
  "w-full h-full min-w-0 min-h-0 overflow-visible p-[12px]",
  "rounded-[15px]",
  "max-[680px]:p-0 max-[680px]:rounded-none",
].join(" ");
const emptyWorkspaceClassName = [
  "grid content-center justify-items-center w-full h-full gap-[10px]",
  "min-h-0 text-rieul-text-3",
  "[&_h2]:m-0 [&_h2]:text-rieul-text [&_h2]:text-[18px] [&_h2]:tracking-[0]",
].join(" ");
const tabDragOverlayClassName = [
  "inline-flex h-[28px] max-w-[206px] items-center rounded-[999px]",
  "border border-white/74 bg-[rgba(255,255,255,0.9)] px-[12px]",
  "text-rieul-text text-[13px] font-640 leading-none shadow-rieul-md",
].join(" ");

interface TabDropState {
  paneId: string;
  target: WorkbenchTabDropTarget;
}

interface TabSplitDropState {
  paneId: string;
  side: TabSplitDropSide;
}

interface ActiveTabDragState {
  dragData: WorkbenchTabDragData;
  label: string;
}

type ResolvedTabDndTarget =
  | { kind: "tab"; paneId: string; position: TabDropPosition; tabId: string }
  | { kind: "tab-strip"; paneId: string }
  | {
    kind: "pane-body";
    nodeId: string;
    paneId: string;
    side: TabSplitDropSide;
  };

export function WorkbenchPaneLayout() {
  const workbench = useBunja(workbenchBunja);
  const layout = useAtomValue(workbench.layoutAtom);
  const panes = useAtomValue(workbench.panesAtom);
  const topRightNodeId = topRightLeafNodeId(layout);
  const [activeTabDrag, setActiveTabDrag] = useState<
    ActiveTabDragState | undefined
  >();
  const [tabDropState, setTabDropState] = useState<TabDropState>();
  const [tabSplitDropState, setTabSplitDropState] = useState<
    TabSplitDropState | undefined
  >();
  const sensors = useSensors(
    useSensor(MouseSensor, {
      activationConstraint: { distance: 4 },
    }),
    useSensor(TouchSensor, {
      activationConstraint: { delay: 250, tolerance: 5 },
    }),
  );

  useEffect(() => () => setMobileShellDragLocked(false), []);
  function clearTabDndState() {
    setMobileShellDragLocked(false);
    setActiveTabDrag(undefined);
    setTabDropState(undefined);
    setTabSplitDropState(undefined);
  }

  function handleDragStart(event: DragStartEvent) {
    const dragData = readWorkbenchTabDndData(event.active.data.current);
    if (!dragData) return;
    const label = readWorkbenchTabDndLabel(event.active.data.current) ??
      dragData.tabId;
    setMobileShellDragLocked(true);
    setActiveTabDrag({ dragData, label });
  }

  function handleDragOver(event: DragOverEvent) {
    updateTabDndTarget(event);
  }

  function handleDragMove(event: DragMoveEvent) {
    updateTabDndTarget(event);
  }

  function updateTabDndTarget(
    event: DragMoveEvent | DragOverEvent | DragEndEvent,
  ) {
    const target = tabDndTargetFromEvent(event);
    if (target?.kind === "tab") {
      setTabDropState({
        paneId: target.paneId,
        target: {
          position: target.position,
          tabId: target.tabId,
        },
      });
      setTabSplitDropState(undefined);
      return target;
    }
    if (target?.kind === "tab-strip") {
      setTabDropState({
        paneId: target.paneId,
        target: { position: "end" },
      });
      setTabSplitDropState(undefined);
      return target;
    }
    if (target?.kind === "pane-body") {
      setTabDropState(undefined);
      setTabSplitDropState({
        paneId: target.paneId,
        side: target.side,
      });
      return target;
    }
    setTabDropState(undefined);
    setTabSplitDropState(undefined);
    return undefined;
  }

  function handleDragEnd(event: DragEndEvent) {
    const dragData = readWorkbenchTabDndData(event.active.data.current);
    const target = updateTabDndTarget(event);
    if (!dragData || !target) {
      clearTabDndState();
      return;
    }

    if (target.kind === "tab") {
      workbench.moveTab(
        dragData.paneId,
        dragData.tabId,
        target.paneId,
        target.tabId,
        target.position,
      );
      clearTabDndState();
      return;
    }
    if (target.kind === "tab-strip") {
      workbench.moveTab(
        dragData.paneId,
        dragData.tabId,
        target.paneId,
        undefined,
        "end",
      );
      clearTabDndState();
      return;
    }

    const result = workbench.moveTabToNewPane(
      dragData.paneId,
      dragData.tabId,
      target.paneId,
    );
    if (result) {
      const direction = target.side === "left" || target.side === "right"
        ? "horizontal"
        : "vertical";
      const position = target.side === "left" || target.side === "top"
        ? "before"
        : "after";
      let nextLayout = layout;
      if (result.sourcePaneRemoved) {
        nextLayout = layoutReducer(nextLayout, {
          nodeId: dragData.nodeId,
          type: "REMOVE_PANE",
        });
      }
      if (nextLayout.nodes[target.nodeId]) {
        nextLayout = layoutReducer(nextLayout, {
          direction,
          nodeId: target.nodeId,
          paneId: result.newPaneId,
          position,
          type: "SPLIT",
        });
        workbench.setLayout(nextLayout);
      }
    }
    clearTabDndState();
  }

  return (
    <DndContext
      collisionDetection={workbenchTabCollisionDetection}
      sensors={sensors}
      onDragStart={handleDragStart}
      onDragMove={handleDragMove}
      onDragOver={handleDragOver}
      onDragCancel={clearTabDndState}
      onDragEnd={handleDragEnd}
    >
      <PaneRoot
        layout={layout}
        onLayoutChange={workbench.setLayout}
        className={paneRootClassName}
        renderDivider={PaneDivider}
        emptyContent={<div className={emptyWorkspaceClassName}>No panes</div>}
      >
        {panes.map((pane) => (
          <Pane key={pane.id} id={pane.id} minWidth={320} minHeight={220}>
            {(nodeId) => (
              <WorkbenchPaneIdContext value={pane.id}>
                <WorkbenchPaneView
                  canSplit
                  draggingTabId={activeTabDrag?.dragData.tabId}
                  nodeId={nodeId}
                  tabDropTarget={tabDropState?.paneId === pane.id
                    ? tabDropState.target
                    : undefined}
                  tabSplitDropSide={tabSplitDropState?.paneId === pane.id
                    ? tabSplitDropState.side
                    : undefined}
                  topRight={nodeId === topRightNodeId}
                />
              </WorkbenchPaneIdContext>
            )}
          </Pane>
        ))}
      </PaneRoot>
      <DragOverlay>
        {activeTabDrag
          ? (
            <div className={tabDragOverlayClassName}>
              {activeTabDrag.label}
            </div>
          )
          : null}
      </DragOverlay>
    </DndContext>
  );
}

const workbenchTabCollisionDetection: CollisionDetection = (args) => {
  const pointerCollisions = pointerWithin(args);
  const collisions = args.pointerCoordinates
    ? pointerCollisions
    : rectIntersection(args);
  const tabCollision = collisions.find((collision) => {
    const container = args.droppableContainers.find((droppable) =>
      droppable.id === collision.id
    );
    const data = readWorkbenchTabDndDropData(container?.data.current);
    return data?.kind === "tab";
  });
  return tabCollision ? [tabCollision] : collisions;
};

function tabDndTargetFromEvent(
  event: DragMoveEvent | DragOverEvent | DragEndEvent,
): ResolvedTabDndTarget | undefined {
  const over = event.over;
  if (!over) return undefined;
  const dragData = readWorkbenchTabDndData(event.active.data.current);
  const dropData = readWorkbenchTabDndDropData(over.data.current);
  if (!dropData) return undefined;
  if (dropData.kind === "tab") {
    if (
      dragData?.paneId === dropData.paneId &&
      dragData.tabId === dropData.tabId
    ) {
      return undefined;
    }
    return {
      kind: "tab",
      paneId: dropData.paneId,
      position: tabDropPositionFromRect(event, over.rect),
      tabId: dropData.tabId,
    };
  }
  if (dropData.kind === "tab-strip") {
    return { kind: "tab-strip", paneId: dropData.paneId };
  }
  return {
    kind: "pane-body",
    nodeId: dropData.nodeId,
    paneId: dropData.paneId,
    side: tabSplitSideFromRect(event, over.rect),
  };
}

function tabDropPositionFromRect(
  event: DragMoveEvent | DragOverEvent | DragEndEvent,
  rect: { left: number; width: number },
): TabDropPosition {
  return dragCenterX(event) < rect.left + rect.width / 2 ? "before" : "after";
}

function tabSplitSideFromRect(
  event: DragMoveEvent | DragOverEvent | DragEndEvent,
  rect: { bottom: number; left: number; right: number; top: number },
): TabSplitDropSide {
  const centerX = dragCenterX(event);
  const centerY = dragCenterY(event);
  const left = centerX - rect.left;
  const right = rect.right - centerX;
  const top = centerY - rect.top;
  const bottom = rect.bottom - centerY;
  const nearest = Math.min(left, right, top, bottom);

  if (nearest === left) return "left";
  if (nearest === right) return "right";
  if (nearest === top) return "top";
  return "bottom";
}

function dragCenterX(
  event: DragMoveEvent | DragOverEvent | DragEndEvent,
): number {
  const rect = event.active.rect.current.translated ??
    event.active.rect.current.initial;
  return rect ? rect.left + rect.width / 2 : 0;
}

function dragCenterY(
  event: DragMoveEvent | DragOverEvent | DragEndEvent,
): number {
  const rect = event.active.rect.current.translated ??
    event.active.rect.current.initial;
  return rect ? rect.top + rect.height / 2 : 0;
}

function setMobileShellDragLocked(locked: boolean) {
  const shell = document.querySelector<HTMLElement>(".app-shell");
  shell?.classList.toggle("workbench-tab-dnd-active", locked);
  document.body.classList.toggle("workbench-tab-dnd-active", locked);
}

function topRightLeafNodeId(layout: LayoutState): string | undefined {
  if (!layout.rootId) return undefined;
  return topRightLeafNodeIdFromNode(layout.nodes[layout.rootId], layout);
}

function topRightLeafNodeIdFromNode(
  node: LayoutNode | undefined,
  layout: LayoutState,
): string | undefined {
  if (!node) return undefined;
  if (node.type === "leaf") return node.id;

  const childId = node.direction === "horizontal"
    ? node.children[node.children.length - 1]
    : node.children[0];
  return topRightLeafNodeIdFromNode(layout.nodes[childId], layout);
}
