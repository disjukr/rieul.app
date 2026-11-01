import { style, theme } from "../../../zyzz.config.ts";
import type { Accessor } from "solid-js";
import type {
  TabDropPosition,
  WorkbenchTab,
} from "../../../state/workbench.ts";
import { createMemo } from "solid-js";

import { useBunja } from "bunja/solid";
import {
  Activity,
  AppWindow,
  Folder,
  Info,
  Terminal,
  Trash2,
  X,
} from "../../../solid/icons.tsx";
import {
  displayName,
  explorerNavigationBunja,
  pathCrumbs,
} from "../../../state/explorer.ts";
import { workbenchTabBunja } from "../../../state/workbench.ts";
import { className } from "../../class-name.ts";
interface WorkbenchTabItemProps {
  dragging: boolean;
  dropPosition?: TabDropPosition;
  nodeId: string;
  paneActive: boolean;
  onClose: () => void;
  onContextMenu: (tab: WorkbenchTab, event: MouseEvent) => void;
}

export function WorkbenchTabItem(props: WorkbenchTabItemProps) {
  const tabState = useBunja(workbenchTabBunja);
  const tab = () => tabState().tab();
  const active = () => tabState().active();
  const dirty = () => tabState().dirty();
  const showClose = () => tabState().showClose();
  const label = useWorkbenchTabLabel(tab);
  const navigation = useBunja(explorerNavigationBunja);
  const specialLocation = () => navigation().specialLocation();
  const tabClassName = createMemo(() =>
    className(
      styles.workbenchTab({ className: "workbench-tab group" }).class,
      active() && "active",
      active() && props.paneActive && styles.activePaneTab().class,
      props.dragging && "dragging",
      props.dropPosition === "before" && "drop-before",
      props.dropPosition === "after" && "drop-after",
    ),
  );
  const currentTabId = createMemo(() => tabState().tabId);
  return (
    <>
      {(() => {
        if (!tab()) return null;
        function handleContextMenu(event: MouseEvent) {
          if (!tab()) return;
          if (isCoarsePointer()) {
            event.preventDefault();
            event.stopPropagation();
            return;
          }
          props.onContextMenu(tab()!, event);
        }
        return (
          <div
            class={tabClassName()}
            data-pane-id={tabState().paneId}
            data-tab-id={currentTabId()}
            onContextMenu={handleContextMenu}
          >
            <button
              data-tab-drag
              type="button"
              role="tab"
              {...styles.workbenchTabButton()}
              aria-selected={active() ? "true" : "false"}
              onClick={tabState().selectTab}
              title={label()}
            >
              <WorkbenchTabIcon
                tab={tab()!}
                trashActive={specialLocation() === "trash"}
                className={styles.workbenchTabIcon().class}
              />
              <span {...styles.workbenchTabTitle()}>{label()}</span>
            </button>
            {showClose() ? (
              <button
                type="button"
                {...styles.workbenchTabClose({ className: "tab-close" })}
                draggable={false}
                onMouseDown={(event) => event.stopPropagation()}
                onClick={props.onClose}
                title={dirty() ? "Unsaved changes" : "Close tab"}
                aria-label={
                  dirty()
                    ? `Close ${label()} with unsaved changes`
                    : `Close ${label()}`
                }
              >
                {dirty() ? (
                  <span {...styles.span()} aria-hidden="true" />
                ) : (
                  <X size={11} />
                )}
              </button>
            ) : null}
          </div>
        );
      })()}
    </>
  );
}
interface WorkbenchTabIconProps {
  className: string;
  tab: WorkbenchTab;
  trashActive: boolean;
}
function WorkbenchTabIcon(props: WorkbenchTabIconProps) {
  return (
    <>
      {(() => {
        if (props.tab.tool === "daemon") {
          return <Info size={12} className={props.className} />;
        }
        if (props.tab.tool === "agent") {
          return <Info size={12} className={props.className} />;
        }
        if (props.tab.tool === "terminal") {
          return <Terminal size={12} className={props.className} />;
        }
        if (props.tab.tool === "processes") {
          return <Activity size={12} className={props.className} />;
        }
        if (props.tab.tool === "windows") {
          return <AppWindow size={12} className={props.className} />;
        }
        if (props.tab.tool === "files" && props.trashActive) {
          return <Trash2 size={12} className={props.className} />;
        }
        return <Folder size={12} className={props.className} />;
      })()}
    </>
  );
}
function useWorkbenchTabLabel(
  tab: Accessor<WorkbenchTab | undefined>,
): Accessor<string> {
  const navigation = useBunja(explorerNavigationBunja);
  const currentPath = () => navigation().currentPath();
  const openedFile = () => navigation().openedFile();
  const specialLocation = () => navigation().specialLocation();
  return createMemo(() => {
    if (!tab()) return "Files";
    if (tab()!.tool === "files") {
      if (specialLocation() === "trash") return "Trash";
      return openedFile()
        ? displayName(openedFile()!)
        : folderNameFromPath(currentPath());
    }
    if (tab()!.tool === "processes") {
      return tab()!.processDetailPid === undefined ? "Processes" : tab()!.title;
    }
    if (tab()!.tool === "windows") {
      return tab()!.windowDetailId === undefined ? "Windows" : tab()!.title;
    }
    return tab()!.title;
  });
}
function folderNameFromPath(path?: string): string {
  const crumbs = pathCrumbs(path);
  return crumbs[crumbs.length - 1]?.label ?? "Files";
}
function isCoarsePointer(): boolean {
  return (
    typeof globalThis.matchMedia === "function" &&
    globalThis.matchMedia("(pointer: coarse)").matches
  );
}

namespace styles {
  export const workbenchTab = style({
    selectors: {
      "&.active": {
        boxShadow:
          "0 7px 16px rgba(18,25,38,0.082),inset 0 1px 0 rgba(255,255,255,0.86),inset 0 -1px 0 rgba(18,25,38,0.028)",
        borderColor: "rgb(255 255 255 / 0.74)",
        backgroundColor: "rgba(255, 255, 255, 0.78)",
        WebkitBackdropFilter: "blur(40px)",
        backdropFilter: "blur(40px)",
      },
      "&::before": {
        pointerEvents: "none",
        position: "absolute",
        bottom: "4px",
        left: "0",
        top: "4px",
        zIndex: 2,
        width: "2px",
        borderRadius: "9999px",
        backgroundColor: "transparent",
        content: "''",
      },
      "&::after": {
        pointerEvents: "none",
        position: "absolute",
        bottom: "4px",
        right: "0",
        top: "4px",
        zIndex: 2,
        width: "2px",
        borderRadius: "9999px",
        backgroundColor: "transparent",
        content: "''",
      },
      "&:not(.active):hover": {
        borderColor: "rgb(255 255 255 / 0.42)",
        backgroundColor: "rgb(255 255 255 / 0.24)",
      },
      "&.drop-after::after": {
        backgroundColor: theme.accent,
      },
      "&.drop-before::before": {
        backgroundColor: theme.accent,
      },
      "&:not(.active)": {
        color: theme.textTertiary,
      },
      "&.active>button svg": {
        color: theme.accent,
      },
      "&.active>button": {
        color: theme.textPrimary,
      },
      "&.dragging": {
        opacity: 0.48,
      },
    },
    position: "relative",
    boxSizing: "border-box",
    height: "28px",
    maxWidth: "206px",
    minWidth: "136px",
    display: "flex",
    flex: "0 0 auto",
    alignItems: "center",
    borderWidth: "1px",
    borderColor: "transparent",
    borderRadius: "999px",
    backgroundColor: "transparent",
    lineHeight: 1,
    "@media (max-width: 680px)": {
      maxWidth: "104px",
      minWidth: "72px",
    },
  });
  export const workbenchTabButton = style({
    WebkitTouchCallout: "none",
    WebkitUserSelect: "none",
    fontFamily: "inherit",
    touchAction: "manipulation",
    height: "100%",
    minHeight: "0",
    minWidth: "0",
    display: "inline-flex",
    flex: "1 1 auto",
    cursor: "grab",
    selectors: {
      "&:active": {
        cursor: "grabbing",
      },
      "&:hover": {
        backgroundColor: "transparent",
      },
    },
    userSelect: "none",
    WebkitAppearance: "none",
    appearance: "none",
    alignItems: "center",
    justifyContent: "flex-start",
    gap: "8px",
    overflow: "hidden",
    textOverflow: "ellipsis",
    whiteSpace: "nowrap",
    borderWidth: "0px",
    borderRadius: "0",
    backgroundColor: "transparent",
    paddingLeft: "11px",
    paddingRight: "8px",
    color: theme.textSecondary,
    fontWeight: 640,
    lineHeight: 1,
  });
  export const workbenchTabClose = style({
    marginLeft: "auto",
    marginRight: "6px",
    height: "18px",
    minHeight: "18px",
    minWidth: "18px",
    width: "18px",
    display: "inline-flex",
    flex: "0 0 auto",
    WebkitAppearance: "none",
    appearance: "none",
    alignItems: "center",
    justifyContent: "center",
    borderWidth: "0px",
    borderRadius: "9999px",
    backgroundColor: "transparent",
    selectors: {
      "&:hover": {
        backgroundColor: "rgba(58, 74, 96, 0.12)",
        color: theme.textPrimary,
      },
      ".group.active &": {
        opacity: 0.78,
      },
      ".group:hover &": {
        opacity: 1,
      },
    },
    padding: "0",
    color: theme.textSecondary,
    opacity: 0.48,
  });
  export const workbenchTabIcon = style({
    flex: "0 0 auto",
    color: theme.textTertiary,
  });
  export const workbenchTabTitle = style({
    minWidth: "0",
    overflow: "hidden",
    textOverflow: "ellipsis",
    whiteSpace: "nowrap",
  });
  export const activePaneTab = style({
    zIndex: 8,
  });
  export const span = style({
    display: "block",
    width: "6px",
    height: "6px",
    borderRadius: "9999px",
    backgroundColor: theme.textTertiary,
  });
}
