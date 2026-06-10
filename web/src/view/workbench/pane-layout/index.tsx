import { useAtomValue } from "jotai";
import { useBunja } from "bunja/react";
import { Pane, Root as PaneRoot } from "panecake";
import {
  workbenchBunja,
  WorkbenchPaneIdContext,
} from "../../../state/workbench.ts";
import { PaneDivider } from "./pane-divider.tsx";
import { WorkbenchPaneView } from "./pane-view.tsx";

export function WorkbenchPaneLayout() {
  const workbench = useBunja(workbenchBunja);
  const layout = useAtomValue(workbench.layoutAtom);
  const panes = useAtomValue(workbench.panesAtom);

  return (
    <PaneRoot
      layout={layout}
      onLayoutChange={workbench.setLayout}
      className="pane-root"
      renderDivider={PaneDivider}
      emptyContent={<div className="empty-workspace">No panes</div>}
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
