import { style, theme } from "../../../../../../zyzz.config.ts";
import { useContext } from "solid-js";

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

export function DirectoryContent() {
  const actions = requireFilesActions(useContext(FilesActionsContext));
  const createFile = requireFilesCreateFileState(
    useContext(FilesCreateFileContext),
  );
  const explorer = requireFilesExplorer(useContext(FilesExplorerContext));
  const rename = requireFilesRenameState(useContext(FilesRenameContext));
  const currentPath = () => explorer().currentPath();
  const rows = () => explorer().visibleRows();
  const selectedEntry = () => explorer().selectedEntry();
  const selectedPath = () => explorer().selectedPath();
  return (
    <div {...styles.directoryContent()}>
      <div {...styles.browserLayout({ className: "browser-layout" })}>
        <FileTable
          rows={rows()}
          selectedPath={selectedPath()}
          onSelect={actions().selectEntry}
          onOpen={actions().openEntry}
          onContextMenu={actions().openEntryMenu}
          onFolderContextMenu={actions().openFolderMenu}
          createDraftName={createFile().draftName}
          createError={createFile().error}
          createIsCreating={createFile().isCreating}
          createIsEditing={createFile().isEditing}
          onCreateCancel={createFile().cancelCreate}
          onCreateCommit={createFile().commitCreate}
          onCreateDraftChange={createFile().updateDraftName}
          renameDraftName={rename().draftName}
          renamingPath={rename().entryPath}
          renameError={rename().error}
          renameIsSaving={rename().isRenaming}
          onRenameCancel={rename().cancelRename}
          onRenameCommit={rename().commitRename}
          onRenameDraftChange={rename().updateDraftName}
        />
        <Inspector
          entry={selectedEntry()}
          currentPath={currentPath()}
          onOpenEntry={actions().openEntry}
        />
      </div>
      <DirectoryFooter
        rowCount={rows().length}
        selectedEntry={selectedEntry()}
      />
    </div>
  );
}
export { EntryPropertiesModal } from "./entry-details.tsx";
interface DirectoryFooterProps {
  rowCount: number;
  selectedEntry?: FsEntry;
}
function DirectoryFooter(props: DirectoryFooterProps) {
  return (
    <div {...styles.explorerFooter()}>
      <span {...styles.footerSelection()}>
        {props.selectedEntry
          ? displayName(props.selectedEntry)
          : "No selection"}
      </span>
      <span>{props.rowCount} items</span>
    </div>
  );
}

namespace styles {
  export const directoryContent = style({
    gridTemplateRows: "minmax(0,1fr) auto",
    display: "grid",
    height: "100%",
    minHeight: "0",
    minWidth: "0",
    width: "100%",
    overflow: "hidden",
    borderRadius: "12px",
    backgroundColor: "rgba(247, 247, 248, 0.58)",
    padding: "4px",
    WebkitBackdropFilter: "blur(40px)",
    backdropFilter: "blur(40px)",
  });
  export const browserLayout = style({
    gridTemplateColumns: "minmax(0,1fr) minmax(220px,28%)",
    display: "grid",
    height: "100%",
    minHeight: "0",
    gap: "7px",
    overflow: "visible",
    "@container workbench-tab-page (max-width:980px)": {
      gridTemplateColumns: "minmax(0,1fr)",
    },
  });
  export const explorerFooter = style({
    boxSizing: "border-box",
    selectors: {
      "& span": {
        minWidth: "0",
        overflow: "hidden",
        textOverflow: "ellipsis",
        whiteSpace: "nowrap",
      },
    },
    height: "22px",
    minHeight: "22px",
    display: "flex",
    alignItems: "center",
    justifyContent: "space-between",
    paddingLeft: "7px",
    paddingRight: "7px",
    paddingTop: "5px",
    fontSize: "12px",
    color: theme.textTertiary,
    fontWeight: 560,
    lineHeight: 1,
  });
  export const footerSelection = style({
    color: theme.textTertiary,
  });
}
