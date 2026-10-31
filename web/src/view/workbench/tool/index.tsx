import { createMemo } from "solid-js";
import { useAtomValue } from "../../../solid/jotai.tsx";
import { useBunja } from "../../../solid/bunja.tsx";
import { workbenchTabBunja } from "../../../state/workbench.ts";
import { AgentTool } from "./agent/index.tsx";
import { DaemonTool } from "./daemon/index.tsx";
import { FilesTool } from "./files/index.tsx";
import { ProcessesTool } from "./processes/index.tsx";
import { TerminalTool } from "./terminal/index.tsx";
import { WindowsTool } from "./windows/index.tsx";
export function WorkbenchToolContent() {
  const tabState = useBunja(workbenchTabBunja);
  const tab = useAtomValue(() => tabState().tabAtom);
  const tool = createMemo(() => tab()?.tool);
  return (
    <>
      {(() => {
        if (!tool()) return null;
        if (tool() === "agent") {
          return <AgentTool />;
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
