import { style, theme } from "../../../zyzz.config.ts";
import { createMemo } from "solid-js";

import { useBunja } from "bunja/solid";
import { workbenchTabBunja } from "../../../state/workbench.ts";
import { DaemonTool } from "./daemon/index.tsx";
import { FilesTool } from "./files/index.tsx";
import { ProcessesTool } from "./processes/index.tsx";
import { TerminalTool } from "./terminal/index.tsx";
import { WindowsTool } from "./windows/index.tsx";
export function WorkbenchToolContent() {
  const tabState = useBunja(workbenchTabBunja);
  const tab = () => tabState().tab();
  const tool = createMemo(() => tab()?.tool);
  return (
    <>
      {(() => {
        if (!tool()) return null;
        if (tool() === "agent") {
          return (
            <div {...styles.div()} role="status">
              This saved tab is no longer available. Close it or open another
              tool.
            </div>
          );
        }
        if (tool() === "daemon") {
          return <DaemonTool />;
        }
        if (tool() === "files") {
          return <FilesTool />;
        }
        if (tool() === "processes") {
          return <ProcessesTool />;
        }
        if (tool() === "terminal") {
          return <TerminalTool />;
        }
        if (tool() === "windows") {
          return <WindowsTool />;
        }
        return null;
      })()}
    </>
  );
}

namespace styles {
  export const div = style({
    padding: "1rem",
    color: theme.textSecondary,
  });
}
