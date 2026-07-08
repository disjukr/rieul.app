import { useContext } from "react";
import { useAtomValue } from "jotai";
import type { FsEntry } from "../../../../../../protocol/generated/rpc.ts";
import { displayName } from "../../../../../../state/explorer.ts";
import {
  FilesActionsContext,
  FilesCreateFileContext,
  FilesExplorerContext,
  FilesRenameContext,
  requireFilesActions,
  requireFilesCreateFileState,
  requireFilesExplorer,
  requireFilesRenameState,
} from "../../context.tsx";
import { FileTable } from "./file-table.tsx";
import { Inspector } from "./entry-details.tsx";

const directoryContentClassName = [
  "grid [grid-template-rows:minmax(0,1fr)_auto]",
  "w-full h-full min-w-0 min-h-0 overflow-hidden",
  "rounded-[12px]",
  "bg-[rgba(247,247,248,0.58)]",
  "p-[4px] backdrop-blur-2xl",
].join(" ");
const browserLayoutClassName = [
  "browser-layout grid [grid-template-columns:minmax(0,1fr)_minmax(220px,28%)]",
  "[@container_workbench-tab-page_(max-width:980px)]:[grid-template-columns:minmax(0,1fr)]",
  "h-full min-h-0 gap-[7px] overflow-visible",
].join(" ");
const explorerFooterClassName = [
  "flex items-center justify-between h-[22px] min-h-[22px] box-border",
  "px-[7px] pt-[5px] text-[12px] font-560 leading-none text-rieul-text-3",
  "[&_span]:min-w-0 [&_span]:overflow-hidden [&_span]:text-ellipsis [&_span]:whitespace-nowrap",
].join(" ");
const footerSelectionClassName = "text-rieul-text-3";

export function DirectoryContent() {
  const actions = requireFilesActions(useContext(FilesActionsContext));
  const createFile = requireFilesCreateFileState(
    useContext(FilesCreateFileContext),
  );
  const explorer = requireFilesExplorer(useContext(FilesExplorerContext));
  const rename = requireFilesRenameState(useContext(FilesRenameContext));
  const currentPath = useAtomValue(explorer.currentPathAtom);
  const rows = useAtomValue(explorer.visibleRowsAtom);
  const selectedEntry = useAtomValue(explorer.selectedEntryAtom);
  const selectedPath = useAtomValue(explorer.selectedPathAtom);

  return (
    <div className={directoryContentClassName}>
      <div className={browserLayoutClassName}>
        <FileTable
          rows={rows}
          selectedPath={selectedPath}
          onSelect={actions.selectEntry}
          onOpen={actions.openEntry}
          onContextMenu={actions.openEntryMenu}
          onFolderContextMenu={actions.openFolderMenu}
          createDraftName={createFile.draftName}
          createError={createFile.error}
          createIsCreating={createFile.isCreating}
          createIsEditing={createFile.isEditing}
          onCreateCancel={createFile.cancelCreate}
          onCreateCommit={createFile.commitCreate}
          onCreateDraftChange={createFile.updateDraftName}
          renameDraftName={rename.draftName}
          renamingPath={rename.entryPath}
          renameError={rename.error}
          renameIsSaving={rename.isRenaming}
          onRenameCancel={rename.cancelRename}
          onRenameCommit={rename.commitRename}
          onRenameDraftChange={rename.updateDraftName}
        />
        <Inspector
          entry={selectedEntry}
          currentPath={currentPath}
          onOpenEntry={actions.openEntry}
        />
      </div>
      <DirectoryFooter rowCount={rows.length} selectedEntry={selectedEntry} />
    </div>
  );
}

export { EntryPropertiesModal } from "./entry-details.tsx";

interface DirectoryFooterProps {
  rowCount: number;
  selectedEntry?: FsEntry;
}

function DirectoryFooter({ rowCount, selectedEntry }: DirectoryFooterProps) {
  return (
    <div className={explorerFooterClassName}>
      <span className={footerSelectionClassName}>
        {selectedEntry ? displayName(selectedEntry) : "No selection"}
      </span>
      <span>{rowCount} items</span>
    </div>
  );
}
