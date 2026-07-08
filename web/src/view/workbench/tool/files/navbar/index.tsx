import { useContext } from "react";
import { ArrowLeft, ArrowUp } from "lucide-react";
import { useAtomValue } from "jotai";
import {
  FilesActionsContext,
  FilesExplorerContext,
  requireFilesActions,
  requireFilesExplorer,
} from "../context.tsx";
import { Button } from "../../../../ui/button.tsx";
import { PathCrumbs } from "./path-crumbs.tsx";

const pathToolbarClassName = [
  "grid [grid-template-columns:auto_minmax(0,1fr)] gap-[6px]",
  "relative items-center h-[29px] min-h-[29px] box-border overflow-visible",
  "rounded-[8px] border border-transparent",
  "bg-[rgba(248,248,249,0.32)]",
  "px-[5px] py-0 leading-[1.38] backdrop-blur-2xl",
].join(" ");
const pathToolbarButtonGroupClassName =
  "inline-flex h-[23px] items-center gap-[3px] box-border";
const pathToolbarButtonClassName = [
  "!w-[23px] !min-w-[23px] !h-[23px] !min-h-0 !box-border !rounded-[6px] !p-0",
  "!border-transparent !bg-white/28 hover:!bg-white/5",
].join(" ");

export function FilesNavbar() {
  const explorer = requireFilesExplorer(useContext(FilesExplorerContext));
  const actions = requireFilesActions(useContext(FilesActionsContext));
  const currentPath = useAtomValue(explorer.currentPathAtom);
  const displayPath = useAtomValue(explorer.displayPathAtom);
  const history = useAtomValue(explorer.historyAtom);
  const specialLocation = useAtomValue(explorer.specialLocationAtom);
  const canGoBack = history.length > 0;
  const canGoUp = currentPath !== undefined && !specialLocation;

  return (
    <div className={pathToolbarClassName}>
      <div className={pathToolbarButtonGroupClassName}>
        <Button
          onClick={actions.goBack}
          disabled={!canGoBack}
          title="Back"
          aria-label="Back"
          className={pathToolbarButtonClassName}
        >
          <ArrowLeft size={12} />
        </Button>
        <Button
          onClick={actions.goUp}
          disabled={!canGoUp}
          title="Up"
          aria-label="Up"
          className={pathToolbarButtonClassName}
        >
          <ArrowUp size={12} />
        </Button>
      </div>
      <PathCrumbs path={displayPath} onNavigate={actions.navigate} />
    </div>
  );
}
