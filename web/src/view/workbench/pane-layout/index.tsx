import { useAtomValue } from "jotai";
import { useBunja } from "bunja/react";
import { Pane, Root as PaneRoot } from "panecake";
import {
  workbenchBunja,
  WorkbenchPaneIdContext,
} from "../../../state/workbench.ts";
import { PaneDivider } from "./pane-divider.tsx";
import { WorkbenchPaneView } from "./pane-view.tsx";

const paneRootClassName = "w-full h-full min-w-0 min-h-0 overflow-hidden";
const emptyWorkspaceClassName = [
  "grid content-center justify-items-center w-full h-full gap-[10px]",
  "min-h-0 text-[#667085]",
  "[&_h2]:m-0 [&_h2]:text-[#303642] [&_h2]:text-[18px] [&_h2]:tracking-[0]",
].join(" ");

export function WorkbenchPaneLayout() {
  const workbench = useBunja(workbenchBunja);
  const layout = useAtomValue(workbench.layoutAtom);
  const panes = useAtomValue(workbench.panesAtom);

  return (
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
              <WorkbenchPaneView nodeId={nodeId} />
            </WorkbenchPaneIdContext>
          )}
        </Pane>
      ))}
    </PaneRoot>
  );
}
