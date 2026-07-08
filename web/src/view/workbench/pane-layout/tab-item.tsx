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
  "workbench-tab group relative flex flex-[0_0_auto] items-center min-w-[136px] max-w-[206px] h-[28px] box-border leading-none",
  "max-[680px]:min-w-[72px] max-[680px]:max-w-[104px]",
  "rounded-[999px] border border-transparent bg-transparent",
  "before:content-[''] before:absolute before:top-[4px] before:bottom-[4px]",
  "before:z-[2] before:w-[2px] before:rounded-full before:bg-transparent",
  "before:pointer-events-none before:left-0",
  "after:content-[''] after:absolute after:top-[4px] after:bottom-[4px]",
  "after:z-[2] after:w-[2px] after:rounded-full after:bg-transparent",
  "after:pointer-events-none after:right-0",
  "[&.drop-before::before]:bg-wgo-accent",
  "[&.drop-after::after]:bg-wgo-accent",
  "[&.dragging]:opacity-48",
  "[&:not(.active)]:text-wgo-text-3/76",
  "[&:not(.active):hover]:border-white/42 [&:not(.active):hover]:bg-white/24",
  "[&.active]:border-white/74 [&.active]:bg-[rgba(255,255,255,0.78)] [&.active]:backdrop-blur-2xl",
  "[&.active]:[box-shadow:0_7px_16px_rgba(18,25,38,0.082),inset_0_1px_0_rgba(255,255,255,0.86),inset_0_-1px_0_rgba(18,25,38,0.028)]",
  "[&.active>button]:text-wgo-text [&.active>button_svg]:text-wgo-accent",
].join(" ");
const workbenchTabButtonClassName = [
  "inline-flex h-full min-h-0 min-w-0 flex-[1_1_auto] appearance-none",
  "items-center justify-start gap-[8px] overflow-hidden rounded-none border-0",
  "bg-transparent pl-[11px] pr-[8px] [font-family:inherit]",
  "text-ellipsis whitespace-nowrap text-wgo-text-2 font-640 leading-none",
  "cursor-grab hover:bg-transparent active:cursor-grabbing",
].join(" ");
const workbenchTabCloseClassName = [
  "tab-close ml-auto mr-[6px] inline-flex h-[18px] min-h-[18px]",
  "w-[18px] min-w-[18px] flex-[0_0_auto] appearance-none items-center",
  "justify-center rounded-full border-0 bg-transparent p-0 text-wgo-text-3",
  "opacity-0 hover:bg-[rgba(58,74,96,0.09)] hover:text-wgo-text-2",
  "group-[.active]:opacity-54 group-hover:opacity-100",
].join(" ");
const workbenchTabIconClassName = "flex-[0_0_auto] text-wgo-text-3";
const workbenchTabTitleClassName =
  "min-w-0 overflow-hidden text-ellipsis whitespace-nowrap";
const activePaneTabClassName = "z-[8]";

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
        className={workbenchTabButtonClassName}
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
            className={workbenchTabCloseClassName}
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
                  className="block size-[6px] rounded-full bg-wgo-text-3"
                  aria-hidden="true"
                />
              )
              : <X size={11} />}
          </button>
        )
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
