import React, { useEffect, useRef, useState } from "react";
import { useAtomValue } from "jotai";
import { useBunja } from "bunja/react";
import { Handle, useLayout } from "panecake";
import {
  ChevronDown,
  Columns2,
  Folder,
  GripVertical,
  Plus,
  Rows2,
  X,
} from "lucide-react";
import {
  type TabDropPosition,
  workbenchPaneBunja,
  WorkbenchTabIdContext,
} from "../../../state/workbench.ts";
import { WorkbenchToolContent } from "../tool/index.tsx";
import {
  hasWorkbenchTabDragData,
  readWorkbenchTabDragData,
  type TabSplitDropSide,
  type WorkbenchTabDragData,
  type WorkbenchTabDropTarget,
} from "./tab-drag.ts";
import { WorkbenchTabItem } from "./tab-item.tsx";
import { className } from "../../class-name.ts";

interface WorkbenchPaneViewProps {
  nodeId: string;
}

const workbenchPaneClassName = [
  "workbench-pane relative grid [grid-template-rows:auto_minmax(0,1fr)]",
  "w-full h-full min-w-0 min-h-0 overflow-hidden bg-white",
].join(" ");
const workbenchPaneHeadClassName = [
  "grid [grid-template-columns:24px_minmax(0,1fr)_auto]",
  "items-center min-h-[32px] border-b border-b-[#d8dde7] bg-[#f6f8fb]",
].join(" ");
const paneHandleClassName =
  "flex items-center justify-center self-stretch text-[#98a2b3] cursor-grab";
const workbenchTabsClassName = [
  "flex items-end min-w-0 h-full overflow-visible",
  "[&.drop-at-end]:[box-shadow:inset_-2px_0_0_#4f8cff]",
].join(" ");
const paneActionsClassName = "flex items-center gap-[3px] px-[5px]";
const newTabMenuWrapClassName = "relative flex";
const iconButtonClassName = [
  "w-[36px] min-w-[36px] p-0",
  "[&.compact]:w-[24px] [&.compact]:min-w-[24px]",
  "[&.compact]:h-[24px] [&.compact]:min-h-[24px]",
].join(" ");
const newTabTriggerClassName = [
  "w-[34px] min-w-[34px] h-[24px] min-h-[24px] gap-[1px] p-0",
].join(" ");
const compactIconButtonClassName = `${iconButtonClassName} compact`;
const newTabMenuClassName = [
  "absolute top-[calc(100%+5px)] right-0 z-[12] w-[148px]",
  "border border-[#d8dde7] rounded-[7px] bg-white",
  "[box-shadow:0_14px_36px_rgb(32_36_45_/_20%)] p-[5px]",
  "[&_button]:justify-start [&_button]:w-full [&_button]:min-h-[30px]",
  "[&_button]:border-0 [&_button]:rounded-[5px] [&_button]:bg-transparent",
  "[&_button]:px-[8px] [&_button]:text-[#20242d]",
  "[&_button]:text-[12px] [&_button]:font-650",
  "[&_button:hover]:bg-[#eef3fb]",
].join(" ");
const workbenchPaneBodyClassName = [
  "workbench-pane-body relative w-full h-full min-w-0 min-h-0 overflow-visible",
  "before:content-[''] before:absolute before:z-[4]",
  "before:border-2 before:border-[#4f8cff]",
  "before:bg-[rgb(79_140_255_/_16%)] before:opacity-0 before:pointer-events-none",
  "[&.tab-split-left::before]:top-0 [&.tab-split-left::before]:bottom-0",
  "[&.tab-split-left::before]:left-0 [&.tab-split-left::before]:w-1/2",
  "[&.tab-split-left::before]:opacity-100",
  "[&.tab-split-right::before]:top-0 [&.tab-split-right::before]:right-0",
  "[&.tab-split-right::before]:bottom-0 [&.tab-split-right::before]:w-1/2",
  "[&.tab-split-right::before]:opacity-100",
  "[&.tab-split-top::before]:top-0 [&.tab-split-top::before]:right-0",
  "[&.tab-split-top::before]:left-0 [&.tab-split-top::before]:h-1/2",
  "[&.tab-split-top::before]:opacity-100",
  "[&.tab-split-bottom::before]:right-0 [&.tab-split-bottom::before]:bottom-0",
  "[&.tab-split-bottom::before]:left-0 [&.tab-split-bottom::before]:h-1/2",
  "[&.tab-split-bottom::before]:opacity-100",
].join(" ");
const workbenchTabPageClassName = [
  "block w-full h-full min-w-0 min-h-0 overflow-hidden",
  "[container:workbench-tab-page_/_inline-size]",
  "[&[hidden]]:hidden",
].join(" ");
const activePaneOutlineClassName = [
  "pointer-events-none absolute top-[-2px] right-0 bottom-0 left-0 z-[6]",
  "[box-shadow:inset_0_0_0_2px_#7f9abf]",
].join(" ");

export function WorkbenchPaneView(
  {
    nodeId,
  }: WorkbenchPaneViewProps,
) {
  const paneState = useBunja(workbenchPaneBunja);
  const pane = useAtomValue(paneState.paneAtom);
  const paneCount = useAtomValue(paneState.paneCountAtom);
  const active = useAtomValue(paneState.activeAtom);
  const { removePane: removeLayoutPane, split } = useLayout();
  const [newTabMenuOpen, setNewTabMenuOpen] = useState(false);
  const [draggingTabId, setDraggingTabId] = useState<string>();
  const [tabDropTarget, setTabDropTarget] = useState<WorkbenchTabDropTarget>();
  const [tabSplitDropSide, setTabSplitDropSide] = useState<
    TabSplitDropSide | undefined
  >();
  const newTabMenuRef = useRef<HTMLDivElement>(null);
  const canClosePane = paneCount > 1;
  const hasTabDragState = draggingTabId !== undefined ||
    tabDropTarget !== undefined ||
    tabSplitDropSide !== undefined;

  useEffect(() => {
    if (!newTabMenuOpen) return;

    function closeNewTabMenu(event: MouseEvent) {
      const target = event.target;
      if (target instanceof Node && newTabMenuRef.current?.contains(target)) {
        return;
      }
      setNewTabMenuOpen(false);
    }

    function closeNewTabMenuOnEscape(event: KeyboardEvent) {
      if (event.key === "Escape") setNewTabMenuOpen(false);
    }

    globalThis.addEventListener("mousedown", closeNewTabMenu);
    globalThis.addEventListener("keydown", closeNewTabMenuOnEscape);
    return () => {
      globalThis.removeEventListener("mousedown", closeNewTabMenu);
      globalThis.removeEventListener("keydown", closeNewTabMenuOnEscape);
    };
  }, [newTabMenuOpen]);

  useEffect(() => {
    if (!hasTabDragState) return;

    function clearTabDragState() {
      setDraggingTabId(undefined);
      setTabDropTarget(undefined);
      setTabSplitDropSide(undefined);
    }

    globalThis.addEventListener("dragend", clearTabDragState, true);
    globalThis.addEventListener("drop", clearTabDragState, true);
    return () => {
      globalThis.removeEventListener("dragend", clearTabDragState, true);
      globalThis.removeEventListener("drop", clearTabDragState, true);
    };
  }, [hasTabDragState]);

  function splitPane(direction: "horizontal" | "vertical") {
    const newPaneId = paneState.addPane();
    split(nodeId, direction, newPaneId, "after");
  }

  function closePane() {
    if (!canClosePane) return;
    removeLayoutPane(nodeId);
    paneState.removePane();
  }

  function closeWorkbenchTab(tabId: string) {
    if (!pane) return;
    if (pane.tabs.length > 1) {
      paneState.closeTab(tabId);
      return;
    }
    closePane();
  }

  function openFilesTab() {
    paneState.addFilesTab();
    setNewTabMenuOpen(false);
  }

  function moveDroppedTab(
    dragData: WorkbenchTabDragData,
    targetTabId: string | undefined,
    position: TabDropPosition,
  ) {
    const sourcePaneRemoved = paneState.moveTab(
      dragData.paneId,
      dragData.tabId,
      targetTabId,
      position,
    );
    if (sourcePaneRemoved) {
      removeLayoutPane(dragData.nodeId);
    }
    setDraggingTabId(undefined);
    setTabDropTarget(undefined);
    setTabSplitDropSide(undefined);
  }

  function splitDroppedTab(
    dragData: WorkbenchTabDragData,
    side: TabSplitDropSide,
  ) {
    const result = paneState.moveTabToNewPane(
      dragData.paneId,
      dragData.tabId,
    );
    if (!result) {
      setDraggingTabId(undefined);
      setTabDropTarget(undefined);
      setTabSplitDropSide(undefined);
      return;
    }

    const direction = side === "left" || side === "right"
      ? "horizontal"
      : "vertical";
    const position = side === "left" || side === "top" ? "before" : "after";
    split(nodeId, direction, result.newPaneId, position);
    if (result.sourcePaneRemoved) {
      removeLayoutPane(dragData.nodeId);
    }
    setDraggingTabId(undefined);
    setTabDropTarget(undefined);
    setTabSplitDropSide(undefined);
  }

  if (!pane) return null;

  function handleTabStripDragOver(event: React.DragEvent<HTMLDivElement>) {
    if (!hasWorkbenchTabDragData(event)) return;
    if (
      event.target instanceof Element &&
      event.target.closest(".workbench-tab")
    ) {
      return;
    }
    event.preventDefault();
    event.stopPropagation();
    event.dataTransfer.dropEffect = "move";
    setTabDropTarget({ position: "end" });
  }

  function handleTabStripDrop(event: React.DragEvent<HTMLDivElement>) {
    if (
      event.target instanceof Element &&
      event.target.closest(".workbench-tab")
    ) {
      return;
    }
    const dragData = readWorkbenchTabDragData(event);
    if (!dragData) return;
    event.preventDefault();
    event.stopPropagation();
    moveDroppedTab(dragData, undefined, "end");
  }

  function handleTabStripDragLeave(event: React.DragEvent<HTMLDivElement>) {
    const relatedTarget = event.relatedTarget;
    if (
      relatedTarget instanceof Node &&
      event.currentTarget.contains(relatedTarget)
    ) {
      return;
    }
    setTabDropTarget(undefined);
  }

  function handlePaneBodyDragOver(event: React.DragEvent<HTMLDivElement>) {
    if (!hasWorkbenchTabDragData(event)) return;
    event.preventDefault();
    event.stopPropagation();
    event.dataTransfer.dropEffect = "move";
    setTabSplitDropSide(tabSplitSideFromEvent(event));
  }

  function handlePaneBodyDrop(event: React.DragEvent<HTMLDivElement>) {
    const dragData = readWorkbenchTabDragData(event);
    if (!dragData) return;
    event.preventDefault();
    event.stopPropagation();
    splitDroppedTab(dragData, tabSplitSideFromEvent(event));
  }

  function handlePaneBodyDragLeave(event: React.DragEvent<HTMLDivElement>) {
    const relatedTarget = event.relatedTarget;
    if (
      relatedTarget instanceof Node &&
      event.currentTarget.contains(relatedTarget)
    ) {
      return;
    }
    setTabSplitDropSide(undefined);
  }

  const paneBodyClassName = className(
    workbenchPaneBodyClassName,
    tabSplitDropSide === "left" && "tab-split-left",
    tabSplitDropSide === "right" && "tab-split-right",
    tabSplitDropSide === "top" && "tab-split-top",
    tabSplitDropSide === "bottom" && "tab-split-bottom",
  );

  return (
    <section
      className={className(workbenchPaneClassName, active && "active")}
      onPointerDownCapture={paneState.focusPane}
      onFocusCapture={paneState.focusPane}
    >
      <header className={workbenchPaneHeadClassName}>
        <Handle className={paneHandleClassName}>
          <GripVertical size={14} />
        </Handle>
        <div
          className={className(
            workbenchTabsClassName,
            tabDropTarget?.position === "end" && "drop-at-end",
          )}
          role="tablist"
          onDragOver={handleTabStripDragOver}
          onDrop={handleTabStripDrop}
          onDragLeave={handleTabStripDragLeave}
        >
          {pane.tabs.map((tab) => (
            <WorkbenchTabIdContext key={tab.id} value={tab.id}>
              <WorkbenchTabItem
                dragging={draggingTabId === tab.id}
                dropPosition={tabDropTarget?.tabId === tab.id
                  ? tabDropTarget.position
                  : undefined}
                nodeId={nodeId}
                paneActive={active}
                onClose={() =>
                  closeWorkbenchTab(tab.id)}
                onDragStart={() =>
                  setDraggingTabId(tab.id)}
                onDragEnd={() => {
                  setDraggingTabId(undefined);
                  setTabDropTarget(undefined);
                }}
                onDragOverTab={(tabId, position) =>
                  setTabDropTarget({ tabId, position })}
                onDropTab={moveDroppedTab}
              />
            </WorkbenchTabIdContext>
          ))}
        </div>
        <div className={paneActionsClassName}>
          <div className={newTabMenuWrapClassName} ref={newTabMenuRef}>
            <button
              type="button"
              className={newTabTriggerClassName}
              onClick={() => setNewTabMenuOpen((open) => !open)}
              title="Open tab"
              aria-label="Open tab"
              aria-haspopup="menu"
              aria-expanded={newTabMenuOpen}
            >
              <Plus size={13} />
              <ChevronDown size={11} />
            </button>
            {newTabMenuOpen
              ? (
                <div className={newTabMenuClassName} role="menu">
                  <button
                    type="button"
                    role="menuitem"
                    onClick={openFilesTab}
                  >
                    <Folder size={14} />
                    Files
                  </button>
                </div>
              )
              : null}
          </div>
          <button
            type="button"
            className={compactIconButtonClassName}
            onClick={() => splitPane("horizontal")}
            title="Split right"
            aria-label="Split right"
          >
            <Columns2 size={14} />
          </button>
          <button
            type="button"
            className={compactIconButtonClassName}
            onClick={() => splitPane("vertical")}
            title="Split down"
            aria-label="Split down"
          >
            <Rows2 size={14} />
          </button>
          <button
            type="button"
            className={compactIconButtonClassName}
            onClick={closePane}
            disabled={!canClosePane}
            title="Close pane"
            aria-label="Close pane"
          >
            <X size={14} />
          </button>
        </div>
      </header>
      <div
        className={paneBodyClassName}
        onDragOver={handlePaneBodyDragOver}
        onDrop={handlePaneBodyDrop}
        onDragLeave={handlePaneBodyDragLeave}
      >
        {pane.tabs.map((tab) => (
          <WorkbenchTabIdContext key={tab.id} value={tab.id}>
            <section
              className={workbenchTabPageClassName}
              hidden={tab.id !== pane.activeTabId}
            >
              <WorkbenchToolContent />
            </section>
          </WorkbenchTabIdContext>
        ))}
        {active ? <div className={activePaneOutlineClassName} /> : null}
      </div>
    </section>
  );
}

function tabSplitSideFromEvent(
  event: React.DragEvent<HTMLElement>,
): TabSplitDropSide {
  const rect = event.currentTarget.getBoundingClientRect();
  const left = event.clientX - rect.left;
  const right = rect.right - event.clientX;
  const top = event.clientY - rect.top;
  const bottom = rect.bottom - event.clientY;
  const nearest = Math.min(left, right, top, bottom);

  if (nearest === left) return "left";
  if (nearest === right) return "right";
  if (nearest === top) return "top";
  return "bottom";
}
