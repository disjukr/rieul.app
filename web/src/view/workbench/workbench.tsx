import React, { useEffect, useRef, useState } from "react";
import { useAtomValue } from "jotai";
import { useBunja } from "bunja/react";
import {
  type DividerRenderProps,
  Handle,
  type LayoutState,
  Pane,
  Root as PaneRoot,
  useLayout,
} from "panecake";
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
  ExplorerMachineScope,
  explorerNavigationBunja,
  ExplorerPaneScope,
  pathCrumbs,
} from "../../state/explorer.ts";
import type { Machine } from "../../state/machines.ts";
import {
  type TabDropPosition,
  type WorkbenchPane,
  type WorkbenchTab,
} from "../../state/workbench.ts";
import { Explorer } from "./explorer.tsx";

const workbenchTabDragType = "application/x-wgo-workbench-tab";

interface WorkbenchTabDragData {
  paneId: string;
  tabId: string;
}

interface WorkbenchTabDropTarget {
  tabId?: string;
  position: TabDropPosition;
}

interface WorkbenchProps {
  layout: LayoutState;
  panes: WorkbenchPane[];
  setLayout: (layout: LayoutState) => void;
  addPane: () => string;
  removePane: (paneId: string) => void;
  addFilesTab: (paneId: string) => void;
  selectTab: (paneId: string, tabId: string) => void;
  closeTab: (paneId: string, tabId: string) => void;
  moveTab: (
    sourcePaneId: string,
    tabId: string,
    targetPaneId: string,
    targetTabId: string | undefined,
    position: TabDropPosition,
  ) => void;
  machine?: Machine;
  isPaired: boolean;
  connectionEpoch: number;
  onPair: () => void;
}

interface WorkbenchPaneViewProps {
  pane: WorkbenchPane;
  paneCount: number;
  nodeId: string;
  addPane: () => string;
  removePane: (paneId: string) => void;
  addFilesTab: (paneId: string) => void;
  selectTab: (paneId: string, tabId: string) => void;
  closeTab: (paneId: string, tabId: string) => void;
  moveTab: (
    sourcePaneId: string,
    tabId: string,
    targetPaneId: string,
    targetTabId: string | undefined,
    position: TabDropPosition,
  ) => void;
  machine?: Machine;
  isPaired: boolean;
  connectionEpoch: number;
  onPair: () => void;
}

interface WorkbenchTabItemProps {
  paneId: string;
  tab: WorkbenchTab;
  machine?: Machine;
  active: boolean;
  dragging: boolean;
  dropPosition?: TabDropPosition;
  showClose: boolean;
  onSelect: () => void;
  onClose: () => void;
  onDragStart: () => void;
  onDragEnd: () => void;
  onDragOverTab: (tabId: string, position: TabDropPosition) => void;
  onDropTab: (
    dragData: WorkbenchTabDragData,
    targetTabId: string,
    position: TabDropPosition,
  ) => void;
}

interface WorkbenchTabContentProps {
  tab: WorkbenchTab;
  machine?: Machine;
  isPaired: boolean;
  connectionEpoch: number;
  onPair: () => void;
}

export function Workbench(
  {
    layout,
    panes,
    setLayout,
    addPane,
    removePane,
    addFilesTab,
    selectTab,
    closeTab,
    moveTab,
    machine,
    isPaired,
    connectionEpoch,
    onPair,
  }: WorkbenchProps,
) {
  return (
    <PaneRoot
      layout={layout}
      onLayoutChange={setLayout}
      className="pane-root"
      renderDivider={PaneDivider}
      emptyContent={<div className="empty-workspace">No panes</div>}
    >
      {panes.map((pane) => (
        <Pane key={pane.id} id={pane.id} minWidth={320} minHeight={220}>
          {(nodeId) => (
            <WorkbenchPaneView
              pane={pane}
              paneCount={panes.length}
              nodeId={nodeId}
              addPane={addPane}
              removePane={removePane}
              addFilesTab={addFilesTab}
              selectTab={selectTab}
              closeTab={closeTab}
              moveTab={moveTab}
              machine={machine}
              isPaired={isPaired}
              connectionEpoch={connectionEpoch}
              onPair={onPair}
            />
          )}
        </Pane>
      ))}
    </PaneRoot>
  );
}

function WorkbenchPaneView(
  {
    pane,
    paneCount,
    nodeId,
    addPane,
    removePane,
    addFilesTab,
    selectTab,
    closeTab,
    moveTab,
    machine,
    isPaired,
    connectionEpoch,
    onPair,
  }: WorkbenchPaneViewProps,
) {
  const { removePane: removeLayoutPane, split } = useLayout();
  const [newTabMenuOpen, setNewTabMenuOpen] = useState(false);
  const [draggingTabId, setDraggingTabId] = useState<string>();
  const [tabDropTarget, setTabDropTarget] = useState<WorkbenchTabDropTarget>();
  const newTabMenuRef = useRef<HTMLDivElement>(null);
  const canClosePane = paneCount > 1;

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
    if (!draggingTabId) return;

    function clearTabDragState() {
      setDraggingTabId(undefined);
      setTabDropTarget(undefined);
    }

    globalThis.addEventListener("dragend", clearTabDragState, true);
    globalThis.addEventListener("drop", clearTabDragState, true);
    return () => {
      globalThis.removeEventListener("dragend", clearTabDragState, true);
      globalThis.removeEventListener("drop", clearTabDragState, true);
    };
  }, [draggingTabId]);

  function splitPane(direction: "horizontal" | "vertical") {
    const newPaneId = addPane();
    split(nodeId, direction, newPaneId, "after");
  }

  function closePane() {
    if (!canClosePane) return;
    removeLayoutPane(nodeId);
    removePane(pane.id);
  }

  function closeWorkbenchTab(tabId: string) {
    if (pane.tabs.length > 1) {
      closeTab(pane.id, tabId);
      return;
    }
    closePane();
  }

  function openFilesTab() {
    addFilesTab(pane.id);
    setNewTabMenuOpen(false);
  }

  function moveDroppedTab(
    dragData: WorkbenchTabDragData,
    targetTabId: string | undefined,
    position: TabDropPosition,
  ) {
    moveTab(
      dragData.paneId,
      dragData.tabId,
      pane.id,
      targetTabId,
      position,
    );
    setDraggingTabId(undefined);
    setTabDropTarget(undefined);
  }

  function handleTabStripDragOver(event: React.DragEvent<HTMLDivElement>) {
    if (!hasWorkbenchTabDragData(event)) return;
    if (
      event.target instanceof Element &&
      event.target.closest(".workbench-tab")
    ) {
      return;
    }
    event.preventDefault();
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

  return (
    <section className="workbench-pane">
      <header className="workbench-pane-head">
        <Handle className="pane-handle">
          <GripVertical size={14} />
        </Handle>
        <div
          className={tabDropTarget?.position === "end"
            ? "workbench-tabs drop-at-end"
            : "workbench-tabs"}
          role="tablist"
          onDragOver={handleTabStripDragOver}
          onDrop={handleTabStripDrop}
          onDragLeave={handleTabStripDragLeave}
        >
          {pane.tabs.map((tab) => (
            <WorkbenchTabItem
              key={tab.id}
              paneId={pane.id}
              tab={tab}
              machine={machine}
              active={tab.id === pane.activeTabId}
              dragging={draggingTabId === tab.id}
              dropPosition={tabDropTarget?.tabId === tab.id
                ? tabDropTarget.position
                : undefined}
              showClose={pane.tabs.length > 1 || canClosePane}
              onSelect={() => selectTab(pane.id, tab.id)}
              onClose={() => closeWorkbenchTab(tab.id)}
              onDragStart={() => setDraggingTabId(tab.id)}
              onDragEnd={() => {
                setDraggingTabId(undefined);
                setTabDropTarget(undefined);
              }}
              onDragOverTab={(tabId, position) =>
                setTabDropTarget({ tabId, position })}
              onDropTab={moveDroppedTab}
            />
          ))}
        </div>
        <div className="pane-actions">
          <div className="new-tab-menu-wrap" ref={newTabMenuRef}>
            <button
              type="button"
              className="icon-button compact new-tab-trigger"
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
                <div className="new-tab-menu" role="menu">
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
            className="icon-button compact"
            onClick={() => splitPane("horizontal")}
            title="Split right"
            aria-label="Split right"
          >
            <Columns2 size={14} />
          </button>
          <button
            type="button"
            className="icon-button compact"
            onClick={() => splitPane("vertical")}
            title="Split down"
            aria-label="Split down"
          >
            <Rows2 size={14} />
          </button>
          <button
            type="button"
            className="icon-button compact"
            onClick={closePane}
            disabled={!canClosePane}
            title="Close pane"
            aria-label="Close pane"
          >
            <X size={14} />
          </button>
        </div>
      </header>
      <div className="workbench-pane-body">
        {pane.tabs.map((tab) => (
          <section
            key={tab.id}
            className="workbench-tab-page"
            hidden={tab.id !== pane.activeTabId}
          >
            <WorkbenchTabContent
              tab={tab}
              machine={machine}
              isPaired={isPaired}
              connectionEpoch={connectionEpoch}
              onPair={onPair}
            />
          </section>
        ))}
      </div>
    </section>
  );
}

function WorkbenchTabItem(
  {
    paneId,
    tab,
    machine,
    active,
    dragging,
    dropPosition,
    showClose,
    onSelect,
    onClose,
    onDragStart,
    onDragEnd,
    onDragOverTab,
    onDropTab,
  }: WorkbenchTabItemProps,
) {
  const label = useWorkbenchTabLabel(tab, machine);
  const className = [
    "workbench-tab",
    active ? "active" : "",
    dragging ? "dragging" : "",
    dropPosition === "before" ? "drop-before" : "",
    dropPosition === "after" ? "drop-after" : "",
  ].filter(Boolean).join(" ");

  function handleDragOver(event: React.DragEvent<HTMLDivElement>) {
    if (!hasWorkbenchTabDragData(event)) return;
    event.preventDefault();
    event.stopPropagation();
    event.dataTransfer.dropEffect = "move";
    const rect = event.currentTarget.getBoundingClientRect();
    const position = event.clientX < rect.left + rect.width / 2
      ? "before"
      : "after";
    onDragOverTab(tab.id, position);
  }

  function handleDrop(event: React.DragEvent<HTMLDivElement>) {
    const dragData = readWorkbenchTabDragData(event);
    if (!dragData) return;
    event.preventDefault();
    event.stopPropagation();
    const rect = event.currentTarget.getBoundingClientRect();
    const position = event.clientX < rect.left + rect.width / 2
      ? "before"
      : "after";
    onDropTab(dragData, tab.id, position);
  }

  return (
    <div
      className={className}
      onDragOver={handleDragOver}
      onDrop={handleDrop}
    >
      <button
        type="button"
        role="tab"
        aria-selected={active}
        draggable
        onDragStart={(event) => {
          event.stopPropagation();
          event.dataTransfer.effectAllowed = "move";
          event.dataTransfer.setData(
            workbenchTabDragType,
            JSON.stringify({ paneId, tabId: tab.id }),
          );
          event.dataTransfer.setData("text/plain", label);
          onDragStart();
        }}
        onDragEnd={onDragEnd}
        onClick={onSelect}
        title={label}
      >
        <Folder size={14} className="workbench-tab-icon" />
        <span className="workbench-tab-title">{label}</span>
      </button>
      {showClose
        ? (
          <button
            type="button"
            className="tab-close"
            draggable={false}
            onMouseDown={(event) => event.stopPropagation()}
            onClick={onClose}
            title="Close tab"
            aria-label={`Close ${label}`}
          >
            <X size={13} />
          </button>
        )
        : null}
    </div>
  );
}

function useWorkbenchTabLabel(tab: WorkbenchTab, machine?: Machine): string {
  const navigation = useBunja(explorerNavigationBunja, [
    ExplorerMachineScope.bind(machine?.id),
    ExplorerPaneScope.bind(tab.id),
  ]);
  const currentPath = useAtomValue(navigation.currentPathAtom);

  if (tab.tool === "files") return folderNameFromPath(currentPath);
  return tab.title;
}

function folderNameFromPath(path?: string): string {
  const crumbs = pathCrumbs(path);
  return crumbs[crumbs.length - 1]?.label ?? "Files";
}

function WorkbenchTabContent(
  { tab, machine, isPaired, connectionEpoch, onPair }: WorkbenchTabContentProps,
) {
  if (tab.tool === "files") {
    return (
      <Explorer
        paneScopeId={tab.id}
        machine={machine}
        isPaired={isPaired}
        connectionEpoch={connectionEpoch}
        onPair={onPair}
      />
    );
  }
}

function PaneDivider(
  { direction, onMouseDown, onKeyDown, ref }: DividerRenderProps,
) {
  return (
    <div
      ref={ref}
      className={`pane-divider ${direction}`}
      role="separator"
      tabIndex={0}
      onMouseDown={onMouseDown}
      onKeyDown={onKeyDown}
    />
  );
}

function hasWorkbenchTabDragData(event: React.DragEvent): boolean {
  return Array.from(event.dataTransfer.types).includes(workbenchTabDragType);
}

function readWorkbenchTabDragData(
  event: React.DragEvent,
): WorkbenchTabDragData | undefined {
  if (!hasWorkbenchTabDragData(event)) return undefined;
  try {
    const data = JSON.parse(event.dataTransfer.getData(workbenchTabDragType));
    if (
      typeof data?.paneId !== "string" ||
      typeof data?.tabId !== "string"
    ) {
      return undefined;
    }
    return { paneId: data.paneId, tabId: data.tabId };
  } catch {
    return undefined;
  }
}
