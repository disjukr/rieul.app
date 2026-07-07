import React from "react";
import { useAtomValue } from "jotai";
import { useBunja } from "bunja/react";
import {
  Activity,
  AppWindow,
  Folder,
  Info,
  Terminal,
  Trash2,
  X,
} from "lucide-react";
import {
  displayName,
  explorerNavigationBunja,
  ExplorerPaneScope,
  pathCrumbs,
} from "../../../state/explorer.ts";
import {
  type TabDropPosition,
  type WorkbenchTab,
  workbenchTabBunja,
} from "../../../state/workbench.ts";
import {
  hasWorkbenchTabDragData,
  readWorkbenchTabDragData,
  type WorkbenchTabDragData,
  workbenchTabDragType,
} from "./tab-drag.ts";
import { className } from "../../class-name.ts";

interface WorkbenchTabItemProps {
  dragging: boolean;
  dropPosition?: TabDropPosition;
  nodeId: string;
  paneActive: boolean;
  onClose: () => void;
  onContextMenu: (
    tab: WorkbenchTab,
    event: React.MouseEvent<HTMLDivElement>,
  ) => void;
  onDragStart: () => void;
  onDragEnd: () => void;
  onDragOverTab: (tabId: string, position: TabDropPosition) => void;
  onDropTab: (
    dragData: WorkbenchTabDragData,
    targetTabId: string,
    position: TabDropPosition,
  ) => void;
}

const workbenchTabClassName = [
  "workbench-tab relative flex items-center min-w-0 max-w-[168px] h-full box-border leading-[1.6]",
  "bg-[var(--wgo-bg-muted)]",
  "before:content-[''] before:absolute before:top-[4px] before:bottom-[4px]",
  "before:z-[2] before:w-[2px] before:rounded-full before:bg-transparent",
  "before:pointer-events-none before:left-0",
  "after:content-[''] after:absolute after:top-[4px] after:bottom-[4px]",
  "after:z-[2] after:w-[2px] after:rounded-full after:bg-transparent",
  "after:pointer-events-none after:right-0",
  "[&.drop-before::before]:bg-[var(--wgo-accent)]",
  "[&.drop-after::after]:bg-[var(--wgo-accent)]",
  "[&.dragging]:opacity-48",
  "[&:not(.active)]:[box-shadow:inset_-1px_0_0_var(--wgo-border-muted)]",
  "[&.active]:bg-[var(--wgo-bg-primary)]",
  "[&>button]:inline-flex [&>button]:appearance-none [&>button]:items-center",
  "[&>button]:justify-center [&>button]:[font-family:inherit] [&>button]:leading-[1.6]",
  "[&>button]:min-w-0 [&>button]:h-full [&>button]:min-h-0",
  "[&>button]:cursor-pointer [&>button]:border-0 [&>button]:rounded-0 [&>button]:bg-transparent",
  "[&>button]:px-[6px] [&>button]:text-[var(--wgo-text-control)]",
  "[&>button]:font-700",
  "[&>button:hover]:bg-transparent",
  "[&>button[role='tab']]:justify-start",
  "[&>button[role='tab']]:flex-[1_1_auto]",
  "[&>button[role='tab']]:gap-[6px]",
  "[&>button[role='tab']]:overflow-hidden",
  "[&>button[role='tab']]:text-ellipsis",
  "[&>button[role='tab']]:whitespace-nowrap",
  "[&>button[role='tab']]:cursor-grab",
  "[&>button[role='tab']:active]:cursor-grabbing",
  "[&.active>button]:text-[var(--wgo-text-primary)]",
  "[&_.tab-close]:flex-[0_0_auto] [&_.tab-close]:w-[2em]",
  "[&_.tab-close]:min-w-[2em] [&_.tab-close]:p-0 [&_.tab-close]:text-[var(--wgo-text-tertiary)]",
].join(" ");
const workbenchTabIconClassName =
  "mr-[5px] flex-[0_0_auto] text-[var(--wgo-text-tertiary)]";
const workbenchTabTitleClassName =
  "min-w-0 overflow-hidden text-ellipsis whitespace-nowrap";
const activePaneTabClassName = [
  "z-[8]",
  "[box-shadow:inset_2px_0_0_var(--wgo-accent-shadow),inset_-2px_0_0_var(--wgo-accent-shadow),inset_0_2px_0_var(--wgo-accent-shadow)]",
].join(" ");
const activeTabBottomCoverClassName = [
  "pointer-events-none absolute left-[2px] right-[2px] bottom-0",
  "z-[9] h-[1px] bg-[var(--wgo-bg-primary)]",
].join(" ");

export function WorkbenchTabItem(
  {
    dragging,
    dropPosition,
    nodeId,
    paneActive,
    onClose,
    onContextMenu,
    onDragStart,
    onDragEnd,
    onDragOverTab,
    onDropTab,
  }: WorkbenchTabItemProps,
) {
  const tabState = useBunja(workbenchTabBunja);
  const tab = useAtomValue(tabState.tabAtom);
  const active = useAtomValue(tabState.activeAtom);
  const dirty = useAtomValue(tabState.dirtyAtom);
  const showClose = useAtomValue(tabState.showCloseAtom);
  const label = useWorkbenchTabLabel(tabState.tabId, tab);
  const navigation = useBunja(explorerNavigationBunja, [
    ExplorerPaneScope.bind(tabState.tabId),
  ]);
  const specialLocation = useAtomValue(navigation.specialLocationAtom);
  const tabClassName = className(
    workbenchTabClassName,
    active && "active",
    active && paneActive && activePaneTabClassName,
    dragging && "dragging",
    dropPosition === "before" && "drop-before",
    dropPosition === "after" && "drop-after",
  );

  if (!tab) return null;
  const currentTabId = tab.id;

  function handleDragOver(event: React.DragEvent<HTMLDivElement>) {
    if (!hasWorkbenchTabDragData(event)) return;
    event.preventDefault();
    event.stopPropagation();
    event.dataTransfer.dropEffect = "move";
    const rect = event.currentTarget.getBoundingClientRect();
    const position = event.clientX < rect.left + rect.width / 2
      ? "before"
      : "after";
    onDragOverTab(currentTabId, position);
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
    onDropTab(dragData, currentTabId, position);
  }

  return (
    <div
      className={tabClassName}
      onContextMenu={(event) => onContextMenu(tab, event)}
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
            JSON.stringify({
              nodeId,
              paneId: tabState.paneId,
              tabId: currentTabId,
            }),
          );
          onDragStart();
        }}
        onDragEnd={onDragEnd}
        onClick={tabState.selectTab}
        title={label}
      >
        <WorkbenchTabIcon
          tab={tab}
          trashActive={specialLocation === "trash"}
          className={workbenchTabIconClassName}
        />
        <span className={workbenchTabTitleClassName}>{label}</span>
      </button>
      {showClose
        ? (
          <button
            type="button"
            className="tab-close"
            draggable={false}
            onMouseDown={(event) => event.stopPropagation()}
            onClick={onClose}
            title={dirty ? "Unsaved changes" : "Close tab"}
            aria-label={dirty
              ? `Close ${label} with unsaved changes`
              : `Close ${label}`}
          >
            {dirty
              ? (
                <span
                  className="block size-[6px] rounded-full bg-[var(--wgo-text-tertiary)]"
                  aria-hidden="true"
                />
              )
              : <X size={11} />}
          </button>
        )
        : null}
      {active && paneActive
        ? <span className={activeTabBottomCoverClassName} aria-hidden="true" />
        : null}
    </div>
  );
}

interface WorkbenchTabIconProps {
  className: string;
  tab: WorkbenchTab;
  trashActive: boolean;
}

function WorkbenchTabIcon(
  { className, tab, trashActive }: WorkbenchTabIconProps,
) {
  if (tab.tool === "daemon") {
    return <Info size={12} className={className} />;
  }
  if (tab.tool === "terminal") {
    return <Terminal size={12} className={className} />;
  }
  if (tab.tool === "processes") {
    return <Activity size={12} className={className} />;
  }
  if (tab.tool === "windows") {
    return <AppWindow size={12} className={className} />;
  }
  if (tab.tool === "files" && trashActive) {
    return <Trash2 size={12} className={className} />;
  }
  return <Folder size={12} className={className} />;
}

function useWorkbenchTabLabel(
  tabId: string,
  tab: WorkbenchTab | undefined,
): string {
  const navigation = useBunja(explorerNavigationBunja, [
    ExplorerPaneScope.bind(tabId),
  ]);
  const currentPath = useAtomValue(navigation.currentPathAtom);
  const openedFile = useAtomValue(navigation.openedFileAtom);
  const specialLocation = useAtomValue(navigation.specialLocationAtom);

  if (!tab) return "Files";
  if (tab.tool === "files") {
    if (specialLocation === "trash") return "Trash";
    return openedFile
      ? displayName(openedFile)
      : folderNameFromPath(currentPath);
  }
  if (tab.tool === "processes") {
    return tab.processDetailPid === undefined ? "Processes" : tab.title;
  }
  if (tab.tool === "windows") {
    return tab.windowDetailId === undefined ? "Windows" : tab.title;
  }
  return tab.title;
}

function folderNameFromPath(path?: string): string {
  const crumbs = pathCrumbs(path);
  return crumbs[crumbs.length - 1]?.label ?? "Files";
}
