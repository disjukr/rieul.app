import React from "react";
import {
  type FsEntry,
  FsEntryKind,
} from "../../../../../../protocol/generated/rpc.ts";
import {
  displayName,
  formatDate,
  formatSize,
  kindLabel,
} from "../../../../../../state/explorer.ts";
import { EntryIcon } from "./entry-icon.tsx";
import { className } from "../../../../../class-name.ts";
import { Badge } from "../../../../../ui/badge.tsx";
import {
  DataGrid,
  DataGridCell,
  DataGridHeaderCell,
  DataGridRow,
} from "../../../../../ui/data-grid.tsx";

interface FileTableProps {
  rows: FsEntry[];
  selectedPath?: string;
  onSelect: (entry: FsEntry) => void;
  onOpen: (entry: FsEntry) => void;
  onContextMenu: (
    entry: FsEntry,
    event: React.MouseEvent<HTMLDivElement>,
  ) => void;
  onFolderContextMenu: (event: React.MouseEvent<HTMLDivElement>) => void;
  createDraftName: string;
  createError?: string;
  createIsCreating: boolean;
  createIsEditing: boolean;
  onCreateCancel: () => void;
  onCreateCommit: () => void;
  onCreateDraftChange: (value: string) => void;
  renameDraftName: string;
  renameError?: string;
  renameIsSaving: boolean;
  renamingPath?: string;
  onRenameCancel: () => void;
  onRenameCommit: (entry: FsEntry) => void;
  onRenameDraftChange: (value: string) => void;
}

const fileTableClassName = [
  "file-table",
  "[grid-template-columns:minmax(220px,1fr)_minmax(96px,130px)_minmax(88px,120px)_minmax(140px,190px)]",
  "[@container_workbench-tab-page_(max-width:680px)]:[grid-template-columns:minmax(200px,1fr)_96px_88px]",
].join(" ");
const hideInNarrowContainerClassName =
  "[@container_workbench-tab-page_(max-width:680px)]:hidden";
const fileCellBaseClassName = [
  "file-cell",
  "px-[8px] text-ellipsis whitespace-nowrap",
].join(" ");
const fileFirstColumnClassName = "pl-[1rem]";
const fileNameCellClassName =
  `${fileCellBaseClassName} ${fileFirstColumnClassName} name gap-[6px]`;
const fileMetaCellClassName = fileCellBaseClassName;
const fileNameClassName =
  "min-w-0 overflow-hidden text-ellipsis whitespace-nowrap leading-[1.6]";
const fileNameInputClassName = [
  "block min-w-0 min-h-0 w-full h-[1.8rem] box-border appearance-none rounded-[3px]",
  "border border-transparent bg-[var(--wgo-bg-primary)] px-[3px] py-0",
  "text-[var(--wgo-text-primary)] [font:inherit] leading-[1.6rem]",
  "outline-none [outline-offset:0] focus:outline-none focus:[outline:none] focus:[outline-offset:0]",
  "focus:border-[var(--wgo-border-focus-strong)]",
  "disabled:opacity-64",
].join(" ");
const fileRenameErrorClassName = [
  "min-w-0 overflow-hidden text-ellipsis whitespace-nowrap",
  "text-[var(--wgo-danger)]",
].join(" ");
const tableEmptyClassName =
  "[grid-column:1/-1] flex items-center text-[var(--wgo-text-tertiary)] px-[12px]";
const tableBottomPaddingClassName = "[grid-column:1/-1] h-[10rem]";
const newFileEntry: FsEntry = {
  kind: FsEntryKind.File,
  name: "",
  path: "",
  readonly: false,
};

export function FileTable(
  {
    rows,
    selectedPath,
    onSelect,
    onOpen,
    onContextMenu,
    onFolderContextMenu,
    createDraftName,
    createError,
    createIsCreating,
    createIsEditing,
    onCreateCancel,
    onCreateCommit,
    onCreateDraftChange,
    renameDraftName,
    renameError,
    renameIsSaving,
    renamingPath,
    onRenameCancel,
    onRenameCommit,
    onRenameDraftChange,
  }: FileTableProps,
) {
  function openFolderContextMenu(event: React.MouseEvent<HTMLDivElement>) {
    const target = event.target;
    if (!(target instanceof Element)) return;
    if (target.closest("[data-file-table-row], [data-file-table-head]")) {
      return;
    }
    onFolderContextMenu(event);
  }

  return (
    <DataGrid
      density="compact"
      className={fileTableClassName}
      role="grid"
      aria-label="Files"
      onContextMenu={openFolderContextMenu}
    >
      <DataGridHeaderCell
        className={`${fileFirstColumnClassName} name`}
        data-file-table-head
      >
        Name
      </DataGridHeaderCell>
      <DataGridHeaderCell className="kind" data-file-table-head>
        Kind
      </DataGridHeaderCell>
      <DataGridHeaderCell className="size" data-file-table-head>
        Size
      </DataGridHeaderCell>
      <DataGridHeaderCell
        className={className(
          "modified",
          hideInNarrowContainerClassName,
        )}
        data-file-table-head
      >
        Modified
      </DataGridHeaderCell>
      {rows.length === 0 && !createIsEditing
        ? <div className={tableEmptyClassName}>No rows</div>
        : (
          rows.map((entry) => {
            const renaming = entry.path === renamingPath;
            return (
              <DataGridRow
                key={entry.path}
                interactive
                selected={entry.path === selectedPath}
                role="row"
                tabIndex={0}
                onClick={() => onSelect(entry)}
                onDoubleClick={() => onOpen(entry)}
                onContextMenu={(event) => onContextMenu(entry, event)}
                onKeyDown={(event) => {
                  if (event.key !== "Enter") return;
                  event.preventDefault();
                  onOpen(entry);
                }}
                data-file-table-row
              >
                <DataGridCell className={fileNameCellClassName}>
                  <EntryIcon entry={entry} />
                  {renaming
                    ? (
                      <NameInput
                        disabled={renameIsSaving}
                        error={renameError}
                        value={renameDraftName}
                        onCancel={onRenameCancel}
                        onChange={onRenameDraftChange}
                        onCommit={() => onRenameCommit(entry)}
                      />
                    )
                    : (
                      <span className={fileNameClassName}>
                        {displayName(entry)}
                      </span>
                    )}
                  {entry.readonly
                    ? (
                      <Badge size="sm" tone="warning">
                        readonly
                      </Badge>
                    )
                    : null}
                </DataGridCell>
                <DataGridCell
                  tone="secondary"
                  className={`${fileMetaCellClassName} kind`}
                >
                  {kindLabel(entry.kind)}
                </DataGridCell>
                <DataGridCell
                  tone="secondary"
                  className={`${fileMetaCellClassName} size`}
                >
                  {formatSize(entry.size)}
                </DataGridCell>
                <DataGridCell
                  tone="secondary"
                  className={className(
                    fileMetaCellClassName,
                    "modified",
                    hideInNarrowContainerClassName,
                  )}
                >
                  {formatDate(entry.modifiedAtMs)}
                </DataGridCell>
              </DataGridRow>
            );
          })
        )}
      {createIsEditing
        ? (
          <DataGridRow
            selected
            role="row"
            data-file-table-row
          >
            <DataGridCell className={fileNameCellClassName}>
              <EntryIcon entry={newFileEntry} />
              <NameInput
                disabled={createIsCreating}
                error={createError}
                value={createDraftName}
                onCancel={onCreateCancel}
                onChange={onCreateDraftChange}
                onCommit={onCreateCommit}
              />
            </DataGridCell>
            <DataGridCell
              tone="secondary"
              className={`${fileMetaCellClassName} kind`}
            >
              {kindLabel(FsEntryKind.File)}
            </DataGridCell>
            <DataGridCell
              tone="secondary"
              className={`${fileMetaCellClassName} size`}
            />
            <DataGridCell
              tone="secondary"
              className={className(
                fileMetaCellClassName,
                "modified",
                hideInNarrowContainerClassName,
              )}
            />
          </DataGridRow>
        )
        : null}
      <div className={tableBottomPaddingClassName} aria-hidden="true" />
    </DataGrid>
  );
}

interface NameInputProps {
  disabled: boolean;
  error?: string;
  value: string;
  onCancel: () => void;
  onChange: (value: string) => void;
  onCommit: () => void;
}

function NameInput(
  { disabled, error, value, onCancel, onChange, onCommit }: NameInputProps,
) {
  const inputRef = React.useRef<HTMLInputElement>(null);

  React.useEffect(() => {
    const input = inputRef.current;
    if (!input) return;
    input.focus();
    input.select();
  }, []);

  return (
    <span className="inline-flex min-w-0 max-w-full flex-[1_1_auto] self-center">
      <input
        ref={inputRef}
        className={fileNameInputClassName}
        disabled={disabled}
        value={value}
        onBlur={onCommit}
        onChange={(event) => onChange(event.currentTarget.value)}
        onClick={(event) => event.stopPropagation()}
        onDoubleClick={(event) => event.stopPropagation()}
        onKeyDown={(event) => {
          if (event.key === "Escape") {
            event.preventDefault();
            event.stopPropagation();
            onCancel();
            return;
          }
          if (event.key === "Enter") {
            event.preventDefault();
            event.stopPropagation();
            onCommit();
          }
        }}
      />
      {error ? <span className={fileRenameErrorClassName}>{error}</span> : null}
    </span>
  );
}
