import { useContext } from "react";
import { ArrowLeft, ArrowUp } from "lucide-react";
import { useAtomValue } from "jotai";
import {
  FilesActionsContext,
  FilesExplorerContext,
  requireFilesActions,
  requireFilesExplorer,
} from "../context.tsx";
import { PathCrumbs } from "./path-crumbs.tsx";

const pathToolbarClassName = [
  "grid [grid-template-columns:28px_28px_minmax(0,1fr)] gap-[6px]",
  "items-center border-b border-b-[#d8dde7] bg-white px-[10px] py-[5px]",
].join(" ");
const pathToolbarButtonClassName = [
  "w-[28px] min-w-[28px] h-[26px] min-h-[26px] p-0",
].join(" ");

export function FilesNavbar() {
  const explorer = requireFilesExplorer(useContext(FilesExplorerContext));
  const actions = requireFilesActions(useContext(FilesActionsContext));
  const currentPath = useAtomValue(explorer.currentPathAtom);
  const displayPath = useAtomValue(explorer.displayPathAtom);
  const history = useAtomValue(explorer.historyAtom);
  const canGoBack = history.length > 0;
  const canGoUp = currentPath !== undefined;

  return (
    <div className={pathToolbarClassName}>
      <button
        type="button"
        onClick={actions.goBack}
        disabled={!canGoBack}
        title="Back"
        aria-label="Back"
        className={pathToolbarButtonClassName}
      >
        <ArrowLeft size={16} />
      </button>
      <button
        type="button"
        onClick={actions.goUp}
        disabled={!canGoUp}
        title="Up"
        aria-label="Up"
        className={pathToolbarButtonClassName}
      >
        <ArrowUp size={16} />
      </button>
      <PathCrumbs path={displayPath} onNavigate={actions.navigate} />
    </div>
  );
}
