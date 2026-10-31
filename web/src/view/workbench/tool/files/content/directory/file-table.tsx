import { createEffect, For } from "solid-js";
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
interface FileTableProps {
  rows: FsEntry[];
  selectedPath?: string;
  onSelect: (entry: FsEntry) => void;
  onOpen: (entry: FsEntry) => void;
  onContextMenu: (entry: FsEntry, event: MouseEvent) => void;
  onFolderContextMenu: (event: MouseEvent) => void;
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
  "file-table relative grid",
  "[grid-template-columns:minmax(220px,1fr)_minmax(96px,130px)_minmax(88px,120px)_minmax(140px,190px)]",
  "[@container_workbench-tab-page_(max-width:680px)]:[grid-template-columns:minmax(200px,1fr)_96px_88px]",
  "auto-rows-[25px] min-w-0 min-h-0 overflow-auto",
  "rounded-[8px] border border-white/56",
  "bg-[rgba(251,251,252,0.98)] leading-[1.38]",
  "pt-[2px]",
].join(" ");
const hideInNarrowContainerClassName =
  "[@container_workbench-tab-page_(max-width:680px)]:hidden";
const fileHeadClassName = [
  "file-head sticky top-0 z-[2] flex items-center h-[21px] box-border",
  "border-b border-b-[#e7e9ee] bg-[#fdfdfd] px-[8px]",
  "text-[10px] font-620 text-rieul-text-3",
].join(" ");
const fileRowClassName = [
  "file-row relative z-[1] grid [grid-column:1/-1] [grid-template-columns:subgrid]",
  "mx-[7px] h-[25px] min-h-[25px] box-border border-0 rounded-[6px]",
  "appearance-none cursor-pointer bg-transparent p-0 text-left leading-[1.38] [font-family:inherit]",
  "hover:bg-[rgba(48,64,86,0.026)]",
  "[&.selected]:bg-[rgba(62,84,116,0.15)]",
  "[&.selected]:before:content-[''] [&.selected]:before:absolute [&.selected]:before:left-[3px] [&.selected]:before:top-[5px] [&.selected]:before:bottom-[5px]",
  "[&.selected]:before:w-[2px] [&.selected]:before:rounded-full [&.selected]:before:bg-rieul-accent",
  "[&.selected_.file-cell]:text-rieul-text [&.selected_.file-cell.name]:font-670",
  "[&.selected_.file-cell_svg]:text-[rgba(35,84,168,0.82)]",
  "[&.selected]:[box-shadow:inset_0_1px_0_rgba(255,255,255,0.78),inset_0_-1px_0_rgba(18,25,38,0.04),0_2px_6px_rgba(25,38,56,0.045)]",
].join(" ");
const fileCellBaseClassName = [
  "file-cell flex items-center min-w-0 overflow-hidden text-rieul-text",
  "px-[8px] text-[12.5px] text-ellipsis whitespace-nowrap",
].join(" ");
const fileFirstColumnClassName = "pl-[10px]";
const fileNameCellClassName = `${fileCellBaseClassName} ${fileFirstColumnClassName} name gap-[7px]`;
const fileMetaCellClassName = `${fileCellBaseClassName} font-500 text-rieul-text-3`;
const fileNameClassName =
  "min-w-0 overflow-hidden text-ellipsis whitespace-nowrap leading-[1.38]";
const fileNameInputClassName = [
  "block min-w-0 min-h-0 w-full h-[1.8rem] box-border appearance-none rounded-[3px]",
  "border border-transparent bg-rieul-surface px-[3px] py-0",
  "text-rieul-text [font:inherit] leading-[1.6rem]",
  "outline-none [outline-offset:0] focus:outline-none focus:[outline:none] focus:[outline-offset:0]",
  "focus:border-rieul-accent",
  "disabled:opacity-64",
].join(" ");
const fileRenameErrorClassName = [
  "min-w-0 overflow-hidden text-ellipsis whitespace-nowrap",
  "text-rieul-danger",
].join(" ");
const readonlyClassName = [
  "flex-[0_0_auto] border border-rieul-warning rounded-full bg-rieul-warning-soft",
  "text-rieul-warning px-[4px] py-0 leading-[1]",
].join(" ");
const tableEmptyClassName =
  "[grid-column:1/-1] flex items-center text-rieul-text-3 px-[12px]";
const tableBottomPaddingClassName = [
  "relative z-[1] [grid-column:1/-1] mx-[8px] mt-[8px] h-[78px] rounded-[10px]",
  "bg-[rgba(246,246,247,0.18)]",
].join(" ");
const newFileEntry: FsEntry = {
  kind: FsEntryKind.File,
  name: "",
  path: "",
  readonly: false,
};
export function FileTable(props: FileTableProps) {
  function openFolderContextMenu(event: MouseEvent) {
    const target = event.target;
    if (!(target instanceof Element)) return;
    if (target.closest("[data-file-table-row], [data-file-table-head]")) {
      return;
    }
    props.onFolderContextMenu(event);
  }
  return (
    <div
      class={fileTableClassName}
      role="grid"
      aria-label="Files"
      onContextMenu={openFolderContextMenu}
    >
      <div
        class={`${fileHeadClassName} ${fileFirstColumnClassName} name`}
        role="columnheader"
        data-file-table-head
      >
        Name
      </div>
      <div
        class={`${fileHeadClassName} kind`}
        role="columnheader"
        data-file-table-head
      >
        Kind
      </div>
      <div
        class={`${fileHeadClassName} size`}
        role="columnheader"
        data-file-table-head
      >
        Size
      </div>
      <div
        class={className(
          fileHeadClassName,
          "modified",
          hideInNarrowContainerClassName,
        )}
        role="columnheader"
        data-file-table-head
      >
        Modified
      </div>
      {props.rows.length === 0 && !props.createIsEditing ? (
        <div class={tableEmptyClassName}>No rows</div>
      ) : (
        <For each={props.rows}>
          {(entry) => {
            const renaming = () => entry.path === props.renamingPath;
            const selected = () => entry.path === props.selectedPath;
            return (
              <div
                class={className(fileRowClassName, selected() && "selected")}
                role="row"
                aria-selected={selected() ? "true" : "false"}
                tabindex={0}
                onClick={() => props.onSelect(entry)}
                onDblClick={() => props.onOpen(entry)}
                onContextMenu={(event) => props.onContextMenu(entry, event)}
                onKeyDown={(event) => {
                  if (event.key !== "Enter") return;
                  event.preventDefault();
                  props.onOpen(entry);
                }}
                data-file-table-row
              >
                <span class={fileNameCellClassName}>
                  <EntryIcon entry={entry} />
                  {renaming() ? (
                    <NameInput
                      disabled={props.renameIsSaving}
                      error={props.renameError}
                      value={props.renameDraftName}
                      onCancel={props.onRenameCancel}
                      onChange={props.onRenameDraftChange}
                      onCommit={() => props.onRenameCommit(entry)}
                    />
                  ) : (
                    <span class={fileNameClassName}>{displayName(entry)}</span>
                  )}
                  {entry.readonly ? (
                    <span class={readonlyClassName}>readonly</span>
                  ) : null}
                </span>
                <span class={`${fileMetaCellClassName} kind`}>
                  {kindLabel(entry.kind)}
                </span>
                <span class={`${fileMetaCellClassName} size`}>
                  {formatSize(entry.size)}
                </span>
                <span
                  class={className(
                    fileMetaCellClassName,
                    "modified",
                    hideInNarrowContainerClassName,
                  )}
                >
                  {formatDate(entry.modifiedAtMs)}
                </span>
              </div>
            );
          }}
        </For>
      )}
      {props.createIsEditing ? (
        <div
          class={className(fileRowClassName, "selected")}
          role="row"
          aria-selected="true"
          data-file-table-row
        >
          <span class={fileNameCellClassName}>
            <EntryIcon entry={newFileEntry} />
            <NameInput
              disabled={props.createIsCreating}
              error={props.createError}
              value={props.createDraftName}
              onCancel={props.onCreateCancel}
              onChange={props.onCreateDraftChange}
              onCommit={props.onCreateCommit}
            />
          </span>
          <span class={`${fileMetaCellClassName} kind`}>
            {kindLabel(FsEntryKind.File)}
          </span>
          <span class={`${fileMetaCellClassName} size`} />
          <span
            class={className(
              fileMetaCellClassName,
              "modified",
              hideInNarrowContainerClassName,
            )}
          />
        </div>
      ) : null}
      <div class={tableBottomPaddingClassName} aria-hidden="true" />
    </div>
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
function NameInput(props: NameInputProps) {
  const inputRef = { current: null as HTMLInputElement | null };
  createEffect(
    () => ({}),
    ({}) => {
      const input = inputRef.current;
      if (!input) return;
      input.focus();
      input.select();
    },
  );
  return (
    <span class="inline-flex min-w-0 max-w-full flex-[1_1_auto] self-center">
      <input
        ref={(element) => (inputRef.current = element)}
        class={fileNameInputClassName}
        disabled={props.disabled}
        value={props.value}
        onBlur={props.onCommit}
        onInput={(event) => props.onChange(event.currentTarget.value)}
        onClick={(event) => event.stopPropagation()}
        onDblClick={(event) => event.stopPropagation()}
        onKeyDown={(event) => {
          if (event.key === "Escape") {
            event.preventDefault();
            event.stopPropagation();
            props.onCancel();
            return;
          }
          if (event.key === "Enter") {
            event.preventDefault();
            event.stopPropagation();
            props.onCommit();
          }
        }}
      />
      {props.error ? (
        <span class={fileRenameErrorClassName}>{props.error}</span>
      ) : null}
    </span>
  );
}
