import { useEffect, useMemo, useState } from "react";
import { useAtomValue } from "jotai";
import { useBunja } from "bunja/react";
import {
  createLayout,
  type LayoutNode,
  type LayoutState,
  Pane,
  Root as PaneRoot,
} from "panecake";
import {
  workbenchBunja,
  WorkbenchPaneIdContext,
} from "../../../state/workbench.ts";
import { PaneDivider } from "./pane-divider.tsx";
import { WorkbenchPaneView } from "./pane-view.tsx";

const paneRootClassName = [
  "workbench-pane-root",
  "w-full h-full min-w-0 min-h-0 overflow-visible p-[12px]",
  "rounded-[15px]",
  "max-[680px]:p-0 max-[680px]:rounded-none",
].join(" ");
const emptyWorkspaceClassName = [
  "grid content-center justify-items-center w-full h-full gap-[10px]",
  "min-h-0 text-wgo-text-3",
  "[&_h2]:m-0 [&_h2]:text-wgo-text [&_h2]:text-[18px] [&_h2]:tracking-[0]",
].join(" ");

export function WorkbenchPaneLayout() {
  const workbench = useBunja(workbenchBunja);
  const layout = useAtomValue(workbench.layoutAtom);
  const activePaneId = useAtomValue(workbench.activePaneIdAtom);
  const panes = useAtomValue(workbench.panesAtom);
  const isMobile = useMobileLayout();
  const visiblePane = isMobile
    ? panes.find((pane) => pane.id === activePaneId) ?? panes[0]
    : undefined;
  const renderPanes = visiblePane ? [visiblePane] : panes;
  const renderLayout = useMemo(
    () =>
      visiblePane
        ? createLayout((builder) => builder.leaf(visiblePane.id))
        : layout,
    [layout, visiblePane],
  );
  const topRightNodeId = topRightLeafNodeId(renderLayout);

  return (
    <PaneRoot
      layout={renderLayout}
      onLayoutChange={isMobile ? undefined : workbench.setLayout}
      className={paneRootClassName}
      renderDivider={isMobile ? undefined : PaneDivider}
      emptyContent={<div className={emptyWorkspaceClassName}>No panes</div>}
    >
      {renderPanes.map((pane) => (
        <Pane key={pane.id} id={pane.id} minWidth={320} minHeight={220}>
          {(nodeId) => (
            <WorkbenchPaneIdContext value={pane.id}>
              <WorkbenchPaneView
                canSplit={!isMobile}
                nodeId={nodeId}
                topRight={nodeId === topRightNodeId}
              />
            </WorkbenchPaneIdContext>
          )}
        </Pane>
      ))}
    </PaneRoot>
  );
}

function useMobileLayout() {
  const [matches, setMatches] = useState(() =>
    typeof globalThis.matchMedia === "function" &&
    globalThis.matchMedia("(max-width: 680px)").matches
  );

  useEffect(() => {
    if (typeof globalThis.matchMedia !== "function") return;
    const query = globalThis.matchMedia("(max-width: 680px)");
    setMatches(query.matches);
    const update = () => setMatches(query.matches);
    query.addEventListener("change", update);
    return () => query.removeEventListener("change", update);
  }, []);

  return matches;
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
