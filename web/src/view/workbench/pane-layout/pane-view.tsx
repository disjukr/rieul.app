import React, { useEffect, useRef, useState } from "react";
import { useAtomValue } from "jotai";
import { useBunja } from "bunja/react";
import { Handle, useLayout } from "panecake";
import {
  Activity,
  AppWindow,
  Columns2,
  Copy,
  Folder,
  GripVertical,
  Info,
  MoreHorizontal,
  Rows2,
  Terminal,
  Unlink,
  X,
} from "lucide-react";
import { closeTerminalSession } from "../../../protocol/generated/client.ts";
import { machineStoreBunja } from "../../../state/machine-store.ts";
import { rpcSessionBunja } from "../../../state/rpc-session.ts";
import { terminalShellsBunja } from "../../../state/terminal-shells.ts";
import {
  type TabDropPosition,
  workbenchBunja,
  workbenchPaneBunja,
  type WorkbenchTab,
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
import { Button } from "../../ui/button.tsx";
import {
  clampFloatingMenuPosition,
  FloatingMenu,
  FloatingMenuItem,
  useFloatingMenuDismiss,
} from "../../ui/floating-menu.tsx";

interface WorkbenchPaneViewProps {
  canSplit: boolean;
  nodeId: string;
  topRight: boolean;
}

type PendingCloseRequest =
  | { dirtyCount: number; kind: "pane" }
  | { dirtyCount: number; kind: "tab"; tabId: string };

interface TabContextMenuState {
  tab: WorkbenchTab;
  x: number;
  y: number;
}

const workbenchPaneOuterClassName = [
  "workbench-pane relative",
  "m-[4px] h-[calc(100%-8px)] w-[calc(100%-8px)] min-w-0 min-h-0",
  "overflow-visible rounded-[14px]",
  "shadow-[0_4px_10px_rgba(18,25,38,0.12),0_2px_5px_rgba(18,25,38,0.07),inset_0_1px_0_rgba(255,255,255,0.74)]",
  "transition-[box-shadow,border-color,filter,opacity,transform] duration-150 ease-out",
  "[&:not(.active)]:opacity-86",
  "[&:not(.active)]:shadow-[0_3px_8px_rgba(18,25,38,0.09),0_1px_4px_rgba(18,25,38,0.05),inset_0_1px_0_rgba(255,255,255,0.74)]",
  "[&:not(.active)_.workbench-pane-surface]:border-white/36",
  "[&:not(.active)_.workbench-pane-head]:opacity-80",
  "[&:not(.active)_.workbench-tab.active]:opacity-72",
  "[&:not(.active)_.workbench-pane-actions]:opacity-54",
  "[&:not(.active)_.file-row.selected]:bg-[rgba(62,84,116,0.09)]",
  "[&:not(.active)_.file-row.selected]:shadow-none",
  "[&:not(.active)_.file-row.selected_.file-cell]:text-wgo-text-2",
  "[&.active]:shadow-[0_0_0_1px_var(--wgo-focus),0_0_0_3px_rgba(47,109,246,0.09),0_5px_11px_rgba(18,25,38,0.18),0_2px_5px_rgba(18,25,38,0.105),inset_0_1px_0_rgba(255,255,255,0.9)]",
  "max-[680px]:m-0 max-[680px]:h-full max-[680px]:w-full",
  "max-[680px]:rounded-none max-[680px]:shadow-none",
  "max-[680px]:[&.active]:shadow-none max-[680px]:[&:not(.active)]:shadow-none",
].join(" ");
const workbenchPaneSurfaceClassName = [
  "workbench-pane-surface grid h-full w-full min-w-0 min-h-0",
  "[grid-template-rows:auto_minmax(0,1fr)] overflow-visible rounded-[14px]",
  "border border-white/48 bg-[rgba(248,248,249,0.72)] backdrop-blur-xl",
  "transition-[border-color] duration-150 ease-out",
  "[.active_&]:border-white/64",
  "max-[680px]:rounded-none max-[680px]:border-x-0 max-[680px]:border-t-0",
].join(" ");
const workbenchPaneHeadClassName = [
  "workbench-pane-head",
  "grid [grid-template-columns:1em_minmax(0,1fr)_auto]",
  "items-center h-[36px] min-h-[36px] box-border overflow-visible leading-none",
  "rounded-t-[14px] bg-transparent",
  "px-[6px] pt-0 backdrop-blur-2xl",
  "max-[680px]:[grid-template-columns:minmax(0,1fr)_auto]",
  "max-[680px]:h-[34px] max-[680px]:min-h-[34px] max-[680px]:rounded-none",
  "max-[680px]:px-[4px]",
].join(" ");
const paneHandleClassName =
  "flex items-center justify-center self-stretch text-wgo-muted cursor-grab max-[680px]:hidden";
const workbenchTabsClassName = [
  "flex items-center gap-[4px] min-w-0 h-full overflow-visible",
  "[scrollbar-width:none] [&::-webkit-scrollbar]:hidden",
].join(" ");
const paneActionsClassName = "workbench-pane-actions flex items-center";
const paneActionButtonGroupClassName =
  "inline-flex h-[28px] items-center gap-[4px] box-border p-0";
const paneOverflowMenuWrapClassName = "relative flex h-full";
const compactIconButtonClassName =
  "!w-[28px] !min-w-[28px] !h-full !min-h-0 !box-border !rounded-wgo-sm !p-0";
const buttonGroupFirstClassName = "";
const buttonGroupLastClassName = "";
const standaloneButtonClassName = "!rounded-[4px]";
const paneOverflowMenuClassName = "top-full right-0 z-[12] w-[172px]";
const tabContextMenuWidth = 168;
const paneOverflowMenuSectionClassName = "border-t border-t-wgo-border";
const paneOverflowMenuItemClassName = "";
const workbenchPaneBodyClassName = [
  "workbench-pane-body relative w-full h-full min-w-0 min-h-0 overflow-visible",
  "rounded-[12px] border border-white/58 bg-[rgba(253,253,253,0.94)]",
  "shadow-[inset_0_1px_0_rgba(255,255,255,0.82)]",
  "max-[680px]:rounded-none max-[680px]:border-x-0 max-[680px]:border-b-0 max-[680px]:shadow-none",
  "before:content-[''] before:absolute before:z-[4]",
  "before:border-2 before:border-wgo-accent",
  "before:bg-wgo-accent-muted before:opacity-0 before:pointer-events-none",
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
  "pointer-events-none absolute inset-0 z-[6] rounded-b-[12px]",
  "shadow-[inset_0_0_0_1px_rgba(47,109,246,0.13),inset_0_1px_0_rgba(255,255,255,0.56)]",
  "max-[680px]:hidden",
].join(" ");
const closeConfirmBackdropClassName =
  "fixed inset-0 z-[20] grid place-items-center bg-wgo-overlay p-[24px]";
const closeConfirmModalClassName = [
  "w-[min(420px,100%)] overflow-hidden border border-wgo-border",
  "rounded-wgo-xl bg-wgo-surface shadow-wgo-lg",
].join(" ");
const closeConfirmHeadClassName = [
  "flex items-center justify-between gap-[12px] border-b border-b-wgo-border",
  "px-[16px] py-[14px]",
  "[&_div]:grid [&_div]:gap-[2px] [&_div]:min-w-0",
  "[&_span]:text-wgo-text-3 [&_span]:text-[13px] [&_span]:font-600",
  "[&_h2]:m-0 [&_h2]:text-wgo-text [&_h2]:text-[18px] [&_h2]:tracking-[0]",
].join(" ");
const closeConfirmIconButtonClassName = "!w-[36px] !min-w-[36px] !p-0";
const closeConfirmBodyClassName = [
  "grid gap-[14px] p-[16px]",
  "[&_p]:m-0 [&_p]:text-wgo-text-2 [&_p]:text-[14px]",
].join(" ");
const closeConfirmActionsClassName = "flex justify-end gap-[8px]";
const closeConfirmDangerButtonClassName = [
  "border-wgo-danger bg-wgo-danger-soft text-wgo-danger",
  "hover:border-wgo-danger hover:bg-wgo-danger-soft hover:text-wgo-danger",
].join(" ");

export function WorkbenchPaneView(
  {
    canSplit,
    nodeId,
    topRight,
  }: WorkbenchPaneViewProps,
) {
  const machineStore = useBunja(machineStoreBunja);
  const rpcSession = useBunja(rpcSessionBunja);
  const terminalShellsState = useBunja(terminalShellsBunja);
  const workbench = useBunja(workbenchBunja);
  const paneState = useBunja(workbenchPaneBunja);
  const machine = useAtomValue(machineStore.selectedAtom);
  const defaultShell = useAtomValue(terminalShellsState.defaultShellAtom);
  const terminalShells = useAtomValue(terminalShellsState.terminalShellsAtom);
  const panes = useAtomValue(workbench.panesAtom);
  const pane = useAtomValue(paneState.paneAtom);
  const paneCount = useAtomValue(paneState.paneCountAtom);
  const active = useAtomValue(paneState.activeAtom);
  const { removePane: removeLayoutPane, split } = useLayout();
  const [paneOverflowMenuOpen, setPaneOverflowMenuOpen] = useState(false);
  const [draggingTabId, setDraggingTabId] = useState<string>();
  const [pendingCloseRequest, setPendingCloseRequest] = useState<
    PendingCloseRequest | undefined
  >();
  const [tabContextMenu, setTabContextMenu] = useState<TabContextMenuState>();
  const [tabDropTarget, setTabDropTarget] = useState<WorkbenchTabDropTarget>();
  const [tabSplitDropSide, setTabSplitDropSide] = useState<
    TabSplitDropSide | undefined
  >();
  const paneOverflowMenuRef = useRef<HTMLDivElement>(null);
  const tabContextMenuRef = useRef<HTMLDivElement>(null);
  const canClosePane = paneCount > 1;
  const hasTabDragState = draggingTabId !== undefined ||
    tabDropTarget !== undefined ||
    tabSplitDropSide !== undefined;

  useFloatingMenuDismiss(
    paneOverflowMenuOpen,
    paneOverflowMenuRef,
    () => setPaneOverflowMenuOpen(false),
  );
  useFloatingMenuDismiss(
    tabContextMenu !== undefined,
    tabContextMenuRef,
    () => setTabContextMenu(undefined),
  );

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
    if (!canSplit) return;
    setPaneOverflowMenuOpen(false);
    const newPaneId = paneState.addPane();
    split(nodeId, direction, newPaneId, "after");
  }

  useEffect(() => {
    if (!pendingCloseRequest) return;

    function closeOnEscape(event: KeyboardEvent) {
      if (event.key === "Escape") setPendingCloseRequest(undefined);
    }

    globalThis.addEventListener("keydown", closeOnEscape);
    return () => globalThis.removeEventListener("keydown", closeOnEscape);
  }, [pendingCloseRequest]);

  function requestClosePane() {
    if (!canClosePane) return;
    const dirtyCount = pane ? dirtyTabCount(pane.tabs) : 0;
    if (dirtyCount > 0) {
      setPendingCloseRequest({ dirtyCount, kind: "pane" });
      return;
    }
    performClosePane();
  }

  function performClosePane() {
    if (!canClosePane) return;
    setPaneOverflowMenuOpen(false);
    if (pane) closeTerminalSessions(pane.tabs);
    removeLayoutPane(nodeId);
    paneState.removePane();
  }

  function requestCloseWorkbenchTab(tabId: string) {
    setTabContextMenu(undefined);
    if (!pane) return;
    const closingTab = pane.tabs.find((tab) => tab.id === tabId);
    const dirtyCount = closingTab?.dirty ? 1 : 0;
    if (dirtyCount > 0) {
      setPendingCloseRequest({ dirtyCount, kind: "tab", tabId });
      return;
    }
    performCloseWorkbenchTab(tabId);
  }

  function performCloseWorkbenchTab(tabId: string) {
    if (!pane) return;
    const closingTab = pane.tabs.find((tab) => tab.id === tabId);
    if (pane.tabs.length > 1) {
      if (closingTab) closeTerminalSessions([closingTab]);
      paneState.closeTab(tabId);
      return;
    }
    performClosePane();
  }

  function detachTerminalTab(tabId: string) {
    setTabContextMenu(undefined);
    if (!pane) return;
    if (pane.tabs.length > 1) {
      paneState.closeTab(tabId);
      return;
    }
    if (canClosePane) {
      removeLayoutPane(nodeId);
      paneState.removePane();
      return;
    }
    paneState.addFilesTab();
    paneState.closeTab(tabId);
  }

  function duplicateWorkbenchTab(tabId: string) {
    setTabContextMenu(undefined);
    paneState.duplicateTab(tabId);
  }

  function openTabContextMenu(
    tab: WorkbenchTab,
    event: React.MouseEvent<HTMLDivElement>,
  ) {
    event.preventDefault();
    event.stopPropagation();
    paneState.selectTab(tab.id);
    const position = tabContextMenuPosition(
      event.clientX,
      event.clientY,
      tab.tool === "terminal",
    );
    setPaneOverflowMenuOpen(false);
    setTabContextMenu({ tab, ...position });
  }

  function confirmPendingCloseRequest() {
    const request = pendingCloseRequest;
    if (!request) return;
    setPendingCloseRequest(undefined);
    if (request.kind === "tab") {
      performCloseWorkbenchTab(request.tabId);
      return;
    }
    performClosePane();
  }

  function closeTerminalSessions(tabs: WorkbenchTab[]) {
    if (!machine) return;
    const closingTabIds = new Set(tabs.map((tab) => tab.id));
    const remainingTerminalSessionIds = new Set(
      panes.flatMap((pane) => pane.tabs)
        .filter((tab) => !closingTabIds.has(tab.id))
        .flatMap((tab) =>
          tab.tool === "terminal" && tab.terminalSessionId
            ? [tab.terminalSessionId]
            : []
        ),
    );
    const closingTerminalSessionIds = new Set<string>();

    for (const tab of tabs) {
      if (tab.tool !== "terminal" || !tab.terminalSessionId) continue;
      if (remainingTerminalSessionIds.has(tab.terminalSessionId)) continue;
      closingTerminalSessionIds.add(tab.terminalSessionId);
    }

    for (const terminalSessionId of closingTerminalSessionIds) {
      void (async () => {
        const transport = await rpcSession.webTransport();
        await closeTerminalSession(transport, { terminalSessionId });
      })().catch(() => {
        // Closing a tab should not be blocked by a stale connection or session.
      });
    }
  }

  function openFilesTab() {
    paneState.addFilesTab();
    setPaneOverflowMenuOpen(false);
  }

  function openDaemonTab() {
    paneState.addDaemonTab();
    setPaneOverflowMenuOpen(false);
  }

  function openProcessesTab() {
    paneState.addProcessesTab();
    setPaneOverflowMenuOpen(false);
  }

  function openWindowsTab() {
    paneState.addWindowsTab();
    setPaneOverflowMenuOpen(false);
  }

  function openTerminalTab() {
    const shell = defaultShell;
    paneState.addTerminalTab(
      shell
        ? {
          launch: {
            command: shell.command,
            args: shell.args,
          },
          title: shell.name,
        }
        : {},
    );
    setPaneOverflowMenuOpen(false);
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
    if (!canSplit) return;
    if (!hasWorkbenchTabDragData(event)) return;
    event.preventDefault();
    event.stopPropagation();
    event.dataTransfer.dropEffect = "move";
    setTabSplitDropSide(tabSplitSideFromEvent(event));
  }

  function handlePaneBodyDrop(event: React.DragEvent<HTMLDivElement>) {
    if (!canSplit) return;
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
      className={className(workbenchPaneOuterClassName, active && "active")}
      onPointerDownCapture={paneState.focusPane}
      onFocusCapture={paneState.focusPane}
    >
      <div className={workbenchPaneSurfaceClassName}>
        <header className={workbenchPaneHeadClassName}>
          <Handle className={paneHandleClassName}>
            <GripVertical size={13} strokeWidth={1.8} />
          </Handle>
          <div
            className={workbenchTabsClassName}
            role="tablist"
            onDragOver={handleTabStripDragOver}
            onDrop={handleTabStripDrop}
            onDragLeave={handleTabStripDragLeave}
          >
            {pane.tabs.map((tab, index) => (
              <WorkbenchTabIdContext key={tab.id} value={tab.id}>
                <WorkbenchTabItem
                  dragging={draggingTabId === tab.id}
                  dropPosition={tabDropPositionForTab(
                    tabDropTarget,
                    tab,
                    index === pane.tabs.length - 1,
                  )}
                  nodeId={nodeId}
                  paneActive={active}
                  onClose={() =>
                    requestCloseWorkbenchTab(tab.id)}
                  onContextMenu={openTabContextMenu}
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
            <div className={paneActionButtonGroupClassName}>
              {topRight &&
                  canSplit
                ? (
                  <Button
                    className={className(
                      compactIconButtonClassName,
                      buttonGroupFirstClassName,
                    )}
                    onClick={() => splitPane("horizontal")}
                    title="Split right"
                    aria-label="Split right"
                  >
                    <Columns2 size={12} />
                  </Button>
                )
                : null}
              <div
                className={paneOverflowMenuWrapClassName}
                ref={paneOverflowMenuRef}
              >
                <Button
                  className={className(
                    compactIconButtonClassName,
                    topRight
                      ? buttonGroupLastClassName
                      : standaloneButtonClassName,
                  )}
                  onClick={() => setPaneOverflowMenuOpen((open) => !open)}
                  title="Pane actions"
                  aria-label="Pane actions"
                  aria-haspopup="menu"
                  aria-expanded={paneOverflowMenuOpen}
                >
                  <MoreHorizontal size={13} />
                </Button>
                {paneOverflowMenuOpen
                  ? (
                    <FloatingMenu
                      align="end"
                      anchorRef={paneOverflowMenuRef}
                      className={paneOverflowMenuClassName}
                      strategy="absolute"
                    >
                      <FloatingMenuItem
                        className={paneOverflowMenuItemClassName}
                        onClick={openDaemonTab}
                      >
                        <Info size={14} />
                        New Daemon Tab
                      </FloatingMenuItem>
                      <FloatingMenuItem
                        className={paneOverflowMenuItemClassName}
                        onClick={openFilesTab}
                      >
                        <Folder size={14} />
                        New Files Tab
                      </FloatingMenuItem>
                      <FloatingMenuItem
                        className={paneOverflowMenuItemClassName}
                        onClick={openTerminalTab}
                      >
                        <Terminal size={14} />
                        New Terminal Tab
                      </FloatingMenuItem>
                      <FloatingMenuItem
                        className={paneOverflowMenuItemClassName}
                        onClick={openProcessesTab}
                      >
                        <Activity size={14} />
                        New Processes Tab
                      </FloatingMenuItem>
                      <FloatingMenuItem
                        className={paneOverflowMenuItemClassName}
                        onClick={openWindowsTab}
                      >
                        <AppWindow size={14} />
                        New Windows Tab
                      </FloatingMenuItem>
                      {canSplit
                        ? (
                          <>
                            <FloatingMenuItem
                              className={className(
                                paneOverflowMenuItemClassName,
                                paneOverflowMenuSectionClassName,
                              )}
                              onClick={() => splitPane("horizontal")}
                            >
                              <Columns2 size={14} />
                              Split right
                            </FloatingMenuItem>
                            <FloatingMenuItem
                              className={paneOverflowMenuItemClassName}
                              onClick={() => splitPane("vertical")}
                            >
                              <Rows2 size={14} />
                              Split down
                            </FloatingMenuItem>
                          </>
                        )
                        : null}
                      <FloatingMenuItem
                        className={paneOverflowMenuItemClassName}
                        onClick={requestClosePane}
                        disabled={!canClosePane}
                      >
                        <X size={14} />
                        Close pane
                      </FloatingMenuItem>
                    </FloatingMenu>
                  )
                  : null}
              </div>
            </div>
          </div>
        </header>
        <div
          className={paneBodyClassName}
          onDragOver={canSplit ? handlePaneBodyDragOver : undefined}
          onDrop={canSplit ? handlePaneBodyDrop : undefined}
          onDragLeave={canSplit ? handlePaneBodyDragLeave : undefined}
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
      </div>
      {tabContextMenu
        ? (
          <FloatingMenu
            className="z-[30] w-[168px]"
            menuRef={tabContextMenuRef}
            position={{ left: tabContextMenu.x, top: tabContextMenu.y }}
          >
            <FloatingMenuItem
              onClick={() => duplicateWorkbenchTab(tabContextMenu.tab.id)}
            >
              <Copy size={14} />
              Duplicate
            </FloatingMenuItem>
            {tabContextMenu.tab.tool === "terminal"
              ? (
                <FloatingMenuItem
                  onClick={() => detachTerminalTab(tabContextMenu.tab.id)}
                >
                  <Unlink size={14} />
                  Detach
                </FloatingMenuItem>
              )
              : null}
            <FloatingMenuItem
              tone={tabContextMenu.tab.dirty ? "danger" : "neutral"}
              onClick={() => requestCloseWorkbenchTab(tabContextMenu.tab.id)}
            >
              <X size={14} />
              Close
            </FloatingMenuItem>
          </FloatingMenu>
        )
        : null}
      {pendingCloseRequest
        ? (
          <UnsavedCloseConfirmModal
            dirtyCount={pendingCloseRequest.dirtyCount}
            kind={pendingCloseRequest.kind}
            onCancel={() => setPendingCloseRequest(undefined)}
            onConfirm={confirmPendingCloseRequest}
          />
        )
        : null}
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

function tabDropPositionForTab(
  target: WorkbenchTabDropTarget | undefined,
  tab: WorkbenchTab,
  last: boolean,
): TabDropPosition | undefined {
  if (!target) return undefined;
  if (target.tabId === tab.id) return target.position;
  if (target.position === "end" && last) return "after";
  return undefined;
}

function tabContextMenuPosition(
  x: number,
  y: number,
  terminal: boolean,
): { x: number; y: number } {
  const position = clampFloatingMenuPosition(x, y, {
    itemCount: terminal ? 3 : 2,
    width: tabContextMenuWidth,
  });
  return { x: position.left, y: position.top };
}

function dirtyTabCount(tabs: WorkbenchTab[]): number {
  return tabs.filter((tab) => tab.dirty).length;
}

interface UnsavedCloseConfirmModalProps {
  dirtyCount: number;
  kind: PendingCloseRequest["kind"];
  onCancel: () => void;
  onConfirm: () => void;
}

function UnsavedCloseConfirmModal(
  { dirtyCount, kind, onCancel, onConfirm }: UnsavedCloseConfirmModalProps,
) {
  const closingPane = kind === "pane";
  return (
    <div
      className={closeConfirmBackdropClassName}
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onCancel();
      }}
    >
      <section
        className={closeConfirmModalClassName}
        role="dialog"
        aria-modal="true"
        aria-labelledby="unsaved-close-title"
      >
        <header className={closeConfirmHeadClassName}>
          <div>
            <span>{closingPane ? "Pane" : "Tab"}</span>
            <h2 id="unsaved-close-title">Unsaved changes</h2>
          </div>
          <Button
            onClick={onCancel}
            title="Close"
            aria-label="Close unsaved changes dialog"
            className={closeConfirmIconButtonClassName}
          >
            <X size={16} />
          </Button>
        </header>
        <div className={closeConfirmBodyClassName}>
          <p>
            {closingPane
              ? dirtyCount === 1
                ? "This pane contains a tab with unsaved changes."
                : `This pane contains ${dirtyCount} tabs with unsaved changes.`
              : "This tab has unsaved changes."}
          </p>
          <p>Close it anyway?</p>
          <div className={closeConfirmActionsClassName}>
            <Button onClick={onCancel}>Cancel</Button>
            <Button
              className={closeConfirmDangerButtonClassName}
              onClick={onConfirm}
            >
              Close without saving
            </Button>
          </div>
        </div>
      </section>
    </div>
  );
}
