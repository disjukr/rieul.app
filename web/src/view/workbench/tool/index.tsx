import { lazy, Suspense } from "react";
import { useAtomValue } from "jotai";
import { useBunja } from "bunja/react";
import { workbenchTabBunja } from "../../../state/workbench.ts";
import { DaemonTool } from "./daemon/index.tsx";
import { FilesTool } from "./files/index.tsx";

const TerminalTool = lazy(async () => {
  const module = await import("./terminal/index.tsx");
  return { default: module.TerminalTool };
});

export function WorkbenchToolContent() {
  const tabState = useBunja(workbenchTabBunja);
  const tab = useAtomValue(tabState.tabAtom);

  if (!tab) return null;
  if (tab.tool === "daemon") {
    return <DaemonTool />;
  }
  if (tab.tool === "files") {
    return <FilesTool />;
  }
  if (tab.tool === "terminal") {
    return (
      <Suspense fallback={null}>
        <TerminalTool />
      </Suspense>
    );
  }
  return null;
}
