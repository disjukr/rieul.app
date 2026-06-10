import { useContext } from "react";
import { useAtomValue } from "jotai";
import { formatSize } from "../../../../../state/explorer.ts";
import { FilesExplorerContext, requireFilesExplorer } from "../context.tsx";

export function FilesFooter() {
  const explorer = requireFilesExplorer(useContext(FilesExplorerContext));
  const openedFile = useAtomValue(explorer.openedFileAtom);
  const rows = useAtomValue(explorer.visibleRowsAtom);
  const label = openedFile
    ? formatSize(openedFile.size)
    : `${rows.length} items`;

  return (
    <div className="explorer-footer">
      <span>{label}</span>
    </div>
  );
}
