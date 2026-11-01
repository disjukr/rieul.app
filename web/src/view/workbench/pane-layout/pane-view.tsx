import { style, theme } from "../../../zyzz.config.ts";
import type { WorkbenchTab } from "../../../state/workbench.ts";
import type { TabSplitDropSide, WorkbenchTabDropTarget } from "./tab-drag.ts";
import { ModalDialog } from "../../ui/dialog.tsx";
import { createSignal, createMemo, createEffect, For } from "solid-js";
import { WorkbenchTabIdContext } from "../../../state/workbench-context.ts";

import { useBunja } from "bunja/solid";
import { layoutReducer } from "../../../state/layout.ts";
import {
  Activity,
  AppWindow,
  Columns2,
  Copy,
  Folder,
  GripVertical,
  Info,
  MoreHorizontal,
  Plus,
  Rows2,
  Terminal,
  Unlink,
  X,
} from "../../../solid/icons.tsx";
import { closeTerminalSession } from "../../../protocol/generated/client.ts";
import { machineStoreBunja } from "../../../state/machine-store.ts";
import { rpcSessionBunja } from "../../../state/rpc-session.ts";
import { terminalShellsBunja } from "../../../state/terminal-shells.ts";
import {
  workbenchBunja,
  workbenchPaneBunja,
} from "../../../state/workbench.ts";
import { WorkbenchToolContent } from "../tool/index.tsx";
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
  draggingTabId?: string;
  nodeId: string;
  tabDropTarget?: WorkbenchTabDropTarget;
  tabSplitDropSide?: TabSplitDropSide;
  topRight: boolean;
}
type PendingCloseRequest =
  | {
      dirtyCount: number;
      kind: "pane";
    }
  | {
      dirtyCount: number;
      kind: "tab";
      tabId: string;
    };
type SplitDirection = "horizontal" | "vertical";
interface TabContextMenuState {
  tab: WorkbenchTab;
  x: number;
  y: number;
}

const tabContextMenuWidth = 168;

export function WorkbenchPaneView(props: WorkbenchPaneViewProps) {
  const machineStore = useBunja(machineStoreBunja);
  const rpcSession = useBunja(rpcSessionBunja);
  const terminalShellsState = useBunja(terminalShellsBunja);
  const workbench = useBunja(workbenchBunja);
  const paneState = useBunja(workbenchPaneBunja);
  const machine = () => machineStore().selected();
  const defaultShell = () => terminalShellsState().defaultShell();
  const panes = () => workbench().panes();
  const pane = () => paneState().pane();
  const paneCount = () => paneState().paneCount();
  const active = () => paneState().active();
  const layout = () => workbench().layout();
  function removeLayoutPane(nodeId: string) {
    workbench().setLayout(
      layoutReducer(layout(), {
        type: "REMOVE_PANE",
        nodeId,
      }),
    );
  }
  function split(
    nodeId: string,
    direction: SplitDirection,
    paneId: string,
    position: "before" | "after",
  ) {
    workbench().setLayout(
      layoutReducer(layout(), {
        type: "SPLIT",
        nodeId,
        direction,
        paneId,
        position,
      }),
    );
  }
  const [paneCreateMenuOpen, setPaneCreateMenuOpen] = createSignal(false);
  const [paneOverflowMenuOpen, setPaneOverflowMenuOpen] = createSignal(false);
  const [pendingCloseRequest, setPendingCloseRequest] = createSignal<
    PendingCloseRequest | undefined
  >();
  const [tabContextMenu, setTabContextMenu] =
    createSignal<TabContextMenuState>();
  const [preferredSplitDirection, setPreferredSplitDirection] =
    createSignal<SplitDirection>("horizontal");
  const paneRef = {
    current: null as HTMLElement | null,
  };
  const paneOverflowMenuRef = {
    current: null as HTMLDivElement | null,
  };
  const paneCreateMenuRef = {
    current: null as HTMLDivElement | null,
  };
  const tabsRef = {
    current: null as HTMLDivElement | null,
  };
  const tabContextMenuRef = {
    current: null as HTMLDivElement | null,
  };
  const canClosePane = createMemo(() => paneCount() > 1);
  useFloatingMenuDismiss(paneCreateMenuOpen, paneCreateMenuRef, () =>
    setPaneCreateMenuOpen(false),
  );
  useFloatingMenuDismiss(paneOverflowMenuOpen, paneOverflowMenuRef, () =>
    setPaneOverflowMenuOpen(false),
  );
  useFloatingMenuDismiss(
    () => tabContextMenu() !== undefined,
    tabContextMenuRef,
    () => setTabContextMenu(undefined),
  );
  createEffect(
    createMemo(() => [pane()?.activeTabId, pane()?.tabs.length] as const, {
      equals: (a, b) =>
        a.length === b.length &&
        a.every((value, index) => Object.is(value, b[index])),
    }),
    ([snapshotPaneActiveTabId, ,]) => {
      const tabScroller = tabsRef.current;
      if (!snapshotPaneActiveTabId || !tabScroller) return;
      const activeTab = tabScroller.querySelector<HTMLElement>(
        ".workbench-tab.active",
      );
      if (!activeTab) return;
      const stickyAddButtonWidth = paneCreateMenuRef.current?.offsetWidth ?? 0;
      const gap = 4;
      const visibleLeft = tabScroller.scrollLeft;
      const visibleRight =
        tabScroller.scrollLeft +
        tabScroller.clientWidth -
        stickyAddButtonWidth -
        gap;
      const tabLeft = activeTab.offsetLeft;
      const tabRight = activeTab.offsetLeft + activeTab.offsetWidth;
      if (tabLeft < visibleLeft) {
        tabScroller.scrollTo({
          left: tabLeft,
          behavior: "smooth",
        });
        return;
      }
      if (tabRight > visibleRight) {
        tabScroller.scrollTo({
          left: tabRight - tabScroller.clientWidth + stickyAddButtonWidth + gap,
          behavior: "smooth",
        });
      }
    },
  );
  createEffect(
    createMemo(() => [] as const, {
      equals: (a, b) =>
        a.length === b.length &&
        a.every((value, index) => Object.is(value, b[index])),
    }),
    () => {
      const element = paneRef.current;
      if (!element) return;
      function updateSplitDirection(width: number, height: number) {
        if (width <= 0 || height <= 0) return;
        const next = width >= height ? "horizontal" : "vertical";
        setPreferredSplitDirection((current) =>
          current === next ? current : next,
        );
      }
      const rect = element.getBoundingClientRect();
      updateSplitDirection(rect.width, rect.height);
      const resizeObserver = new ResizeObserver((entries) => {
        const entry = entries[0];
        if (!entry) return;
        updateSplitDirection(entry.contentRect.width, entry.contentRect.height);
      });
      resizeObserver.observe(element);
      return () => resizeObserver.disconnect();
    },
  );
  function splitPane(direction: SplitDirection) {
    if (!props.canSplit) return;
    setPaneCreateMenuOpen(false);
    setPaneOverflowMenuOpen(false);
    const newPaneId = paneState().addPane();
    split(props.nodeId, direction, newPaneId, "after");
  }
  createEffect(
    createMemo(() => [pendingCloseRequest()] as const, {
      equals: (a, b) =>
        a.length === b.length &&
        a.every((value, index) => Object.is(value, b[index])),
    }),
    ([snapshotPendingCloseRequest]) => {
      if (!snapshotPendingCloseRequest) return;
      function closeOnEscape(event: KeyboardEvent) {
        if (event.key === "Escape") setPendingCloseRequest(undefined);
      }
      globalThis.addEventListener("keydown", closeOnEscape);
      return () => globalThis.removeEventListener("keydown", closeOnEscape);
    },
  );
  function requestClosePane() {
    if (!canClosePane()) return;
    const dirtyCount = pane() ? dirtyTabCount(pane()!.tabs) : 0;
    if (dirtyCount > 0) {
      setPendingCloseRequest({
        dirtyCount,
        kind: "pane",
      });
      return;
    }
    performClosePane();
  }
  function performClosePane() {
    if (!canClosePane()) return;
    setPaneOverflowMenuOpen(false);
    if (pane()) closeTerminalSessions(pane()!.tabs);
    removeLayoutPane(props.nodeId);
    paneState().removePane();
  }
  function requestCloseWorkbenchTab(tabId: string) {
    setTabContextMenu(undefined);
    setPaneOverflowMenuOpen(false);
    if (!pane()) return;
    const closingTab = pane()!.tabs.find((tab) => tab.id === tabId);
    const dirtyCount = closingTab?.dirty ? 1 : 0;
    if (dirtyCount > 0) {
      setPendingCloseRequest({
        dirtyCount,
        kind: "tab",
        tabId,
      });
      return;
    }
    performCloseWorkbenchTab(tabId);
  }
  function performCloseWorkbenchTab(tabId: string) {
    if (!pane()) return;
    const closingTab = pane()!.tabs.find((tab) => tab.id === tabId);
    if (pane()!.tabs.length > 1) {
      if (closingTab) closeTerminalSessions([closingTab]);
      paneState().closeTab(tabId);
      return;
    }
    performClosePane();
  }
  function detachTerminalTab(tabId: string) {
    setTabContextMenu(undefined);
    setPaneOverflowMenuOpen(false);
    if (!pane()) return;
    if (pane()!.tabs.length > 1) {
      paneState().closeTab(tabId);
      return;
    }
    if (canClosePane()) {
      removeLayoutPane(props.nodeId);
      paneState().removePane();
      return;
    }
    paneState().addFilesTab();
    paneState().closeTab(tabId);
  }
  function duplicateWorkbenchTab(tabId: string) {
    setTabContextMenu(undefined);
    setPaneOverflowMenuOpen(false);
    paneState().duplicateTab(tabId);
  }
  function openTabContextMenu(tab: WorkbenchTab, event: MouseEvent) {
    event.preventDefault();
    event.stopPropagation();
    paneState().selectTab(tab.id);
    const position = tabContextMenuPosition(
      event.clientX,
      event.clientY,
      tab.tool === "terminal",
    );
    setPaneCreateMenuOpen(false);
    setPaneOverflowMenuOpen(false);
    setTabContextMenu({
      tab,
      ...position,
    });
  }
  function confirmPendingCloseRequest() {
    const request = pendingCloseRequest();
    if (!request) return;
    setPendingCloseRequest(undefined);
    if (request.kind === "tab") {
      performCloseWorkbenchTab(request.tabId);
      return;
    }
    performClosePane();
  }
  function closeTerminalSessions(tabs: WorkbenchTab[]) {
    if (!machine()) return;
    const closingTabIds = new Set(tabs.map((tab) => tab.id));
    const remainingTerminalSessionIds = new Set(
      panes()
        .flatMap((pane) => pane.tabs)
        .filter((tab) => !closingTabIds.has(tab.id))
        .flatMap((tab) =>
          tab.tool === "terminal" && tab.terminalSessionId
            ? [tab.terminalSessionId]
            : [],
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
        const transport = await rpcSession().webTransport();
        await closeTerminalSession(transport, {
          terminalSessionId,
        });
      })().catch(() => {
        // Closing a tab should not be blocked by a stale connection or session.
      });
    }
  }
  function openFilesTab() {
    paneState().addFilesTab();
    setPaneCreateMenuOpen(false);
    setPaneOverflowMenuOpen(false);
  }
  function openDaemonTab() {
    paneState().addDaemonTab();
    setPaneCreateMenuOpen(false);
    setPaneOverflowMenuOpen(false);
  }
  function openProcessesTab() {
    paneState().addProcessesTab();
    setPaneCreateMenuOpen(false);
    setPaneOverflowMenuOpen(false);
  }
  function openWindowsTab() {
    paneState().addWindowsTab();
    setPaneCreateMenuOpen(false);
    setPaneOverflowMenuOpen(false);
  }
  function openTerminalTab() {
    const shell = defaultShell();
    paneState().addTerminalTab(
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
    setPaneCreateMenuOpen(false);
    setPaneOverflowMenuOpen(false);
  }
  const hasPane = createMemo(() => !!pane());
  return (
    <>
      {(() => {
        if (!hasPane()) return null;
        const paneBodyClassName = createMemo(() =>
          className(
            styles.workbenchPaneBody({ className: "workbench-pane-body" })
              .class,
            props.tabSplitDropSide === "left" && "tab-split-left",
            props.tabSplitDropSide === "right" && "tab-split-right",
            props.tabSplitDropSide === "top" && "tab-split-top",
            props.tabSplitDropSide === "bottom" && "tab-split-bottom",
          ),
        );
        const activeTab = createMemo(() =>
          pane()?.tabs.find((tab) => tab.id === pane()!.activeTabId),
        );
        const splitButtonLabel = createMemo(() =>
          splitDirectionLabel(preferredSplitDirection()),
        );
        return (
          <section
            ref={(element) => (paneRef.current = element)}
            class={className(
              styles.workbenchPaneOuter({ className: "workbench-pane" }).class,
              active() && "active",
            )}
            data-node-id={props.nodeId}
            data-pane-id={paneState().paneId}
            onPointerDown={paneState().focusPane}
            onFocusIn={paneState().focusPane}
          >
            <div
              {...styles.workbenchPaneSurface({
                className: "workbench-pane-surface",
              })}
            >
              <header
                {...styles.workbenchPaneHead({
                  className: "workbench-pane-head",
                })}
              >
                <button
                  type="button"
                  data-pane-drag
                  aria-label="Move pane"
                  {...styles.paneHandle()}
                >
                  <GripVertical size={13} strokeWidth={1.8} />
                </button>
                <div
                  {...styles.workbenchTabs({ className: "workbench-tabs" })}
                  ref={(element) => {
                    tabsRef.current = element;
                  }}
                  data-tab-strip
                  data-pane-id={paneState().paneId}
                  role="tablist"
                >
                  <For each={pane()?.tabs.map((tab) => tab.id)}>
                    {(tabId, index) => (
                      <WorkbenchTabIdContext value={() => tabId}>
                        <WorkbenchTabItem
                          dragging={props.draggingTabId === tabId}
                          dropPosition={
                            props.tabDropTarget?.tabId === tabId
                              ? props.tabDropTarget.position
                              : props.tabDropTarget?.position === "end" &&
                                  index() === pane()!.tabs.length - 1
                                ? "after"
                                : undefined
                          }
                          nodeId={props.nodeId}
                          paneActive={active()}
                          onClose={() => requestCloseWorkbenchTab(tabId)}
                          onContextMenu={openTabContextMenu}
                        />
                      </WorkbenchTabIdContext>
                    )}
                  </For>
                  <div
                    {...styles.paneAddTabButtonWrap()}
                    ref={(element) => (paneCreateMenuRef.current = element)}
                    role="presentation"
                  >
                    <Button
                      size="icon"
                      variant="ghost"
                      className={className(
                        styles.compactIconButton().class,
                        styles.standaloneButton().class,
                      )}
                      onClick={() => {
                        setPaneOverflowMenuOpen(false);
                        setPaneCreateMenuOpen((open) => !open);
                      }}
                      title="New tab"
                      aria-label="New tab"
                      aria-haspopup="menu"
                      aria-expanded={paneCreateMenuOpen() ? "true" : "false"}
                    >
                      <Plus size={13} />
                    </Button>
                    {paneCreateMenuOpen() ? (
                      <FloatingMenu
                        align="end"
                        anchorRef={paneCreateMenuRef}
                        className={styles.paneCreateMenu().class}
                        strategy="absolute"
                      >
                        <FloatingMenuItem
                          className={""}
                          onClick={openDaemonTab}
                        >
                          <Info size={14} />
                          New Daemon Tab
                        </FloatingMenuItem>
                        <FloatingMenuItem className={""} onClick={openFilesTab}>
                          <Folder size={14} />
                          New Files Tab
                        </FloatingMenuItem>
                        <FloatingMenuItem
                          className={""}
                          onClick={openTerminalTab}
                        >
                          <Terminal size={14} />
                          New Terminal Tab
                        </FloatingMenuItem>
                        <FloatingMenuItem
                          className={""}
                          onClick={openProcessesTab}
                        >
                          <Activity size={14} />
                          New Processes Tab
                        </FloatingMenuItem>
                        <FloatingMenuItem
                          className={""}
                          onClick={openWindowsTab}
                        >
                          <AppWindow size={14} />
                          New Windows Tab
                        </FloatingMenuItem>
                      </FloatingMenu>
                    ) : null}
                  </div>
                </div>
                <div
                  {...styles.paneActions({
                    className: "workbench-pane-actions",
                  })}
                >
                  <div {...styles.paneActionButtonGroup()}>
                    {props.topRight && props.canSplit ? (
                      <Button
                        size="icon"
                        variant="ghost"
                        className={className(
                          styles.compactIconButton().class,
                          "",
                        )}
                        onClick={() => splitPane(preferredSplitDirection())}
                        title={splitButtonLabel()}
                        aria-label={splitButtonLabel()}
                      >
                        {preferredSplitDirection() === "horizontal" ? (
                          <Columns2 size={12} />
                        ) : (
                          <Rows2 size={12} />
                        )}
                      </Button>
                    ) : null}
                    <div
                      {...styles.paneOverflowMenuWrap()}
                      ref={(element) => (paneOverflowMenuRef.current = element)}
                    >
                      <Button
                        size="icon"
                        variant="ghost"
                        className={className(
                          styles.compactIconButton().class,
                          props.topRight ? "" : styles.standaloneButton().class,
                        )}
                        onClick={() => {
                          setPaneCreateMenuOpen(false);
                          setPaneOverflowMenuOpen((open) => !open);
                        }}
                        title="Pane actions"
                        aria-label="Pane actions"
                        aria-haspopup="menu"
                        aria-expanded={
                          paneOverflowMenuOpen() ? "true" : "false"
                        }
                      >
                        <MoreHorizontal size={13} />
                      </Button>
                      {paneOverflowMenuOpen() ? (
                        <FloatingMenu
                          align="end"
                          anchorRef={paneOverflowMenuRef}
                          className={styles.paneOverflowMenu().class}
                          strategy="absolute"
                        >
                          {activeTab() ? (
                            <>
                              <div
                                {...styles.paneMobileTabMenuDivider()}
                                aria-hidden="true"
                              />
                              <FloatingMenuItem
                                className={styles.paneMobileTabMenuItem().class}
                                onClick={() =>
                                  duplicateWorkbenchTab(activeTab()!.id)
                                }
                              >
                                <Copy size={14} />
                                Duplicate
                              </FloatingMenuItem>
                              {activeTab()!.tool === "terminal" ? (
                                <FloatingMenuItem
                                  className={
                                    styles.paneMobileTabMenuItem().class
                                  }
                                  onClick={() =>
                                    detachTerminalTab(activeTab()!.id)
                                  }
                                >
                                  <Unlink size={14} />
                                  Detach
                                </FloatingMenuItem>
                              ) : null}
                              <FloatingMenuItem
                                className={styles.paneMobileTabMenuItem().class}
                                tone={activeTab()!.dirty ? "danger" : "neutral"}
                                onClick={() =>
                                  requestCloseWorkbenchTab(activeTab()!.id)
                                }
                              >
                                <X size={14} />
                                Close tab
                              </FloatingMenuItem>
                              <div
                                {...styles.paneMobileTabMenuDivider()}
                                aria-hidden="true"
                              />
                            </>
                          ) : null}
                          {props.canSplit ? (
                            <>
                              <FloatingMenuItem
                                className={""}
                                onClick={() => splitPane("horizontal")}
                              >
                                <Columns2 size={14} />
                                Split right
                              </FloatingMenuItem>
                              <FloatingMenuItem
                                className={""}
                                onClick={() => splitPane("vertical")}
                              >
                                <Rows2 size={14} />
                                Split down
                              </FloatingMenuItem>
                            </>
                          ) : null}
                          <FloatingMenuItem
                            className={""}
                            onClick={requestClosePane}
                            disabled={!canClosePane()}
                          >
                            <X size={14} />
                            Close pane
                          </FloatingMenuItem>
                        </FloatingMenu>
                      ) : null}
                    </div>
                  </div>
                </div>
              </header>
              <div class={paneBodyClassName()}>
                <For each={pane()?.tabs.map((tab) => tab.id)}>
                  {(tabId) => (
                    <WorkbenchTabIdContext value={() => tabId}>
                      <section
                        {...styles.workbenchTabPage()}
                        hidden={tabId !== pane()?.activeTabId}
                      >
                        <WorkbenchToolContent />
                      </section>
                    </WorkbenchTabIdContext>
                  )}
                </For>
              </div>
            </div>
            {tabContextMenu() ? (
              <FloatingMenu
                className={styles.floatingMenu().class}
                menuRef={tabContextMenuRef}
                position={{
                  left: tabContextMenu()!.x,
                  top: tabContextMenu()!.y,
                }}
              >
                <FloatingMenuItem
                  onClick={() =>
                    duplicateWorkbenchTab(tabContextMenu()!.tab.id)
                  }
                >
                  <Copy size={14} />
                  Duplicate
                </FloatingMenuItem>
                {tabContextMenu()!.tab.tool === "terminal" ? (
                  <FloatingMenuItem
                    onClick={() => detachTerminalTab(tabContextMenu()!.tab.id)}
                  >
                    <Unlink size={14} />
                    Detach
                  </FloatingMenuItem>
                ) : null}
                <FloatingMenuItem
                  tone={tabContextMenu()!.tab.dirty ? "danger" : "neutral"}
                  onClick={() =>
                    requestCloseWorkbenchTab(tabContextMenu()!.tab.id)
                  }
                >
                  <X size={14} />
                  Close
                </FloatingMenuItem>
              </FloatingMenu>
            ) : null}
            {pendingCloseRequest() ? (
              <UnsavedCloseConfirmModal
                dirtyCount={pendingCloseRequest()!.dirtyCount}
                kind={pendingCloseRequest()!.kind}
                onCancel={() => setPendingCloseRequest(undefined)}
                onConfirm={confirmPendingCloseRequest}
              />
            ) : null}
          </section>
        );
      })()}
    </>
  );
}
function tabContextMenuPosition(
  x: number,
  y: number,
  terminal: boolean,
): {
  x: number;
  y: number;
} {
  const position = clampFloatingMenuPosition(x, y, {
    itemCount: terminal ? 3 : 2,
    width: tabContextMenuWidth,
  });
  return {
    x: position.left,
    y: position.top,
  };
}
function splitDirectionLabel(direction: SplitDirection): string {
  return direction === "horizontal" ? "Split right" : "Split down";
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
function UnsavedCloseConfirmModal(props: UnsavedCloseConfirmModalProps) {
  return (
    <ModalDialog
      title={props.kind === "pane" ? "Close pane?" : "Close tab?"}
      titleId="unsaved-close-title"
      eyebrow="Unsaved changes"
      onClose={props.onCancel}
      size="sm"
      bodyClassName={styles.dialogBody().class}
    >
      <p>
        {props.dirtyCount === 1
          ? "One tab has unsaved changes."
          : `${props.dirtyCount} tabs have unsaved changes.`}{" "}
        Closing will discard them.
      </p>
      <div {...styles.div()}>
        <Button onClick={props.onCancel}>Cancel</Button>
        <Button tone="danger" variant="solid" onClick={props.onConfirm}>
          Discard and close
        </Button>
      </div>
    </ModalDialog>
  );
}

namespace styles {
  export const dialogBody = style({
    padding: "1rem",
  });

  export const workbenchPaneOuter = style({
    position: "relative",
    margin: "4px",
    height: "calc(100% - 8px)",
    minHeight: "0",
    minWidth: "0",
    width: "calc(100% - 8px)",
    overflow: "visible",
    selectors: {
      "&.active .workbench-pane-surface::after": {
        borderWidth: "3px",
        borderColor: theme.focus,
      },
      "&:not(.active) .file-row.selected": {
        backgroundColor: "rgba(62, 84, 116, 0.09)",
        boxShadow: "0 0 rgb(0 0 0 / 0), 0 0 rgb(0 0 0 / 0), 0 0 rgb(0 0 0 / 0)",
      },
      "&:not(.active) .file-row.selected .file-cell": {
        color: theme.textSecondary,
      },
      "&:not(.active) .workbench-pane-actions": {
        opacity: 0.54,
      },
      "&:not(.active) .workbench-pane-head": {
        opacity: 0.8,
      },
      "&:not(.active) .workbench-tab.active": {
        opacity: 0.72,
      },
      "&:not(.active)": {
        opacity: 0.86,
      },
    },
    borderRadius: "14px",
    transitionProperty: "filter,opacity,transform",
    transitionTimingFunction: "cubic-bezier(0, 0, 0.2, 1)",
    transitionDuration: "150ms",
    "@media (max-width: 680px)": {
      margin: "0",
      selectors: {
        "& .workbench-pane-surface::after": {
          display: "none",
        },
      },
      height: "100%",
      width: "100%",
      borderRadius: "0",
    },
  });
  export const workbenchPaneSurface = style({
    gridTemplateRows: "auto minmax(0,1fr)",
    selectors: {
      "&::after": {
        pointerEvents: "none",
        position: "absolute",
        inset: "0",
        zIndex: 8,
        boxSizing: "border-box",
        borderWidth: "1.5px",
        borderColor: "rgba(108, 126, 151, 0.38)",
        borderRadius: "14px",
        transitionProperty: "border-color,border-width",
        transitionTimingFunction: "cubic-bezier(0, 0, 0.2, 1)",
        transitionDuration: "150ms",
        content: "''",
      },
    },
    position: "relative",
    display: "grid",
    height: "100%",
    minHeight: "0",
    minWidth: "0",
    width: "100%",
    overflow: "hidden",
    borderWidth: "1px",
    borderColor: "transparent",
    borderRadius: "14px",
    backgroundColor: "rgba(248, 248, 249, 0.72)",
    WebkitBackdropFilter: "blur(24px)",
    backdropFilter: "blur(24px)",
    "@media (max-width: 680px)": {
      borderLeftWidth: "0px",
      borderRightWidth: "0px",
      borderTopWidth: "0px",
      borderRadius: "0",
    },
  });
  export const workbenchPaneHead = style({
    gridTemplateColumns: "1em minmax(0,1fr) auto",
    display: "grid",
    boxSizing: "border-box",
    height: "36px",
    minHeight: "36px",
    alignItems: "center",
    overflow: "visible",
    borderTopLeftRadius: "14px",
    borderTopRightRadius: "14px",
    backgroundColor: "transparent",
    paddingLeft: "6px",
    paddingRight: "6px",
    paddingTop: "0",
    lineHeight: 1,
    WebkitBackdropFilter: "blur(40px)",
    backdropFilter: "blur(40px)",
    "@media (max-width: 680px)": {
      gridTemplateColumns: "minmax(0,1fr) auto",
      height: "34px",
      minHeight: "34px",
      borderRadius: "0",
      paddingLeft: "4px",
      paddingRight: "4px",
    },
  });
  export const paneHandle = style({
    display: "flex",
    cursor: "grab",
    alignItems: "center",
    alignSelf: "stretch",
    justifyContent: "center",
    color: theme.textDisabled,
    "@media (max-width: 680px)": {
      display: "none",
    },
  });
  export const workbenchTabs = style({
    scrollbarWidth: "none",
    selectors: {
      "&::-webkit-scrollbar": {
        display: "none",
      },
    },
    height: "100%",
    minWidth: "0",
    display: "flex",
    flex: "1 1 0%",
    alignItems: "center",
    gap: "4px",
    overflowX: "auto",
    overflowY: "visible",
  });
  export const paneAddTabButtonWrap = style({
    position: "sticky",
    right: "0",
    zIndex: 12,
    height: "28px",
    display: "flex",
    flex: "0 0 auto",
    backgroundColor: "rgba(248, 248, 249, 0.86)",
    paddingLeft: "4px",
    boxShadow:
      "0 0 rgb(0 0 0 / 0), 0 0 rgb(0 0 0 / 0), -10px 0 14px rgba(248, 248, 249, 0.86)",
    WebkitBackdropFilter: "blur(24px)",
    backdropFilter: "blur(24px)",
  });
  export const paneActions = style({
    display: "flex",
    alignItems: "center",
  });
  export const paneActionButtonGroup = style({
    boxSizing: "border-box",
    height: "28px",
    display: "inline-flex",
    alignItems: "center",
    gap: "4px",
    padding: "0",
  });
  export const paneOverflowMenuWrap = style({
    position: "relative",
    height: "100%",
    display: "flex",
  });
  export const compactIconButton = style({
    boxSizing: "border-box !important",
    height: "100% !important",
    minHeight: "0 !important",
    minWidth: "28px !important",
    width: "28px !important",
    borderColor: "transparent !important",
    selectors: {
      "&:hover": {
        borderColor: "transparent !important",
        backgroundColor: "rgb(255 255 255 / 0.24) !important",
        color: "var(--rieul-text-primary) !important",
      },
    },
    borderRadius: "var(--rieul-radius-sm) !important",
    backgroundColor: "transparent !important",
    padding: "0 !important",
    color: "var(--rieul-text-tertiary) !important",
  });
  export const standaloneButton = style({
    borderRadius: "4px !important",
  });
  export const paneCreateMenu = style({
    right: "0",
    top: "100%",
    zIndex: 12,
    width: "188px",
  });
  export const paneOverflowMenu = style({
    right: "0",
    top: "100%",
    zIndex: 12,
    width: "172px",
  });
  export const paneMobileTabMenuDivider = style({
    display: "none",
    borderTopWidth: "1px",
    borderTopColor: theme.borderLight,
    "@media (max-width: 680px)": {
      display: "block",
    },
  });
  export const paneMobileTabMenuItem = style({
    display: "none",
    "@media (max-width: 680px)": {
      display: "inline-flex",
    },
  });
  export const workbenchPaneBody = style({
    selectors: {
      "&::before": {
        pointerEvents: "none",
        position: "absolute",
        zIndex: 4,
        borderWidth: "2px",
        borderColor: theme.accent,
        backgroundColor: theme.accentOverlay,
        opacity: 0,
        content: "''",
      },
      "&.tab-split-bottom::before": {
        bottom: "0",
        left: "0",
        right: "0",
        height: "50%",
        opacity: 1,
      },
      "&.tab-split-left::before": {
        bottom: "0",
        left: "0",
        top: "0",
        width: "50%",
        opacity: 1,
      },
      "&.tab-split-right::before": {
        bottom: "0",
        right: "0",
        top: "0",
        width: "50%",
        opacity: 1,
      },
      "&.tab-split-top::before": {
        left: "0",
        right: "0",
        top: "0",
        height: "50%",
        opacity: 1,
      },
    },
    position: "relative",
    height: "100%",
    minHeight: "0",
    minWidth: "0",
    width: "100%",
    overflow: "hidden",
    borderWidth: "1px",
    borderColor: "rgb(255 255 255 / 0.58)",
    borderRadius: "12px",
    backgroundColor: "rgba(253, 253, 253, 0.94)",
    "@media (max-width: 680px)": {
      borderLeftWidth: "0px",
      borderRightWidth: "0px",
      borderBottomWidth: "0px",
      borderRadius: "0",
    },
  });
  export const workbenchTabPage = style({
    container: "workbench-tab-page / inline-size",
    display: "block",
    selectors: {
      "&[hidden]": {
        display: "none",
      },
    },
    height: "100%",
    minHeight: "0",
    minWidth: "0",
    width: "100%",
    overflow: "hidden",
  });
  export const floatingMenu = style({
    zIndex: 30,
    width: "168px",
  });
  export const div = style({
    display: "flex",
    justifyContent: "flex-end",
    gap: "0.5rem",
  });
}
