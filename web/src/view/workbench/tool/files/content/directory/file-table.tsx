import { style, theme } from "../../../../../../zyzz.config.ts";
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
      {...styles.fileTable()}
      role="grid"
      aria-label="Files"
      onContextMenu={openFolderContextMenu}
    >
      <div
        class={`${styles.fileHead({ className: "file-head" }).class} ${styles.fileFirstColumn().class} name`}
        role="columnheader"
        data-file-table-head
      >
        Name
      </div>
      <div
        class={`${styles.fileHead({ className: "file-head" }).class} kind`}
        role="columnheader"
        data-file-table-head
      >
        Kind
      </div>
      <div
        class={`${styles.fileHead({ className: "file-head" }).class} size`}
        role="columnheader"
        data-file-table-head
      >
        Size
      </div>
      <div
        class={className(
          styles.fileHead({ className: "file-head" }).class,
          "modified",
          styles.hideInNarrowContainer().class,
        )}
        role="columnheader"
        data-file-table-head
      >
        Modified
      </div>
      {props.rows.length === 0 && !props.createIsEditing ? (
        <div {...styles.tableEmpty()}>No rows</div>
      ) : (
        <For each={props.rows}>
          {(entry) => {
            const renaming = () => entry.path === props.renamingPath;
            const selected = () => entry.path === props.selectedPath;
            return (
              <div
                class={className(
                  styles.fileRow({ className: "file-row" }).class,
                  selected() && "selected",
                )}
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
                <span
                  class={`${styles.fileCellBase({ className: "file-cell" }).class} ${styles.fileFirstColumn().class} ${styles.nameGap({ className: "name" }).class} `}
                >
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
                    <span {...styles.fileName()}>{displayName(entry)}</span>
                  )}
                  {entry.readonly ? (
                    <span {...styles.readonly()}>readonly</span>
                  ) : null}
                </span>
                <span
                  class={`${`${styles.fileCellBase({ className: "file-cell" }).class} ${styles.metadata().class} `} kind`}
                >
                  {kindLabel(entry.kind)}
                </span>
                <span
                  class={`${`${styles.fileCellBase({ className: "file-cell" }).class} ${styles.metadata().class} `} size`}
                >
                  {formatSize(entry.size)}
                </span>
                <span
                  class={className(
                    `${styles.fileCellBase({ className: "file-cell" }).class} font-500 text-rieul-text-3`,
                    "modified",
                    styles.hideInNarrowContainer().class,
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
          class={className(
            styles.fileRow({ className: "file-row" }).class,
            "selected",
          )}
          role="row"
          aria-selected="true"
          data-file-table-row
        >
          <span
            class={`${styles.fileCellBase({ className: "file-cell" }).class} ${styles.fileFirstColumn().class} ${styles.nameGap({ className: "name" }).class} `}
          >
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
          <span
            class={`${`${styles.fileCellBase({ className: "file-cell" }).class} ${styles.metadata().class} `} kind`}
          >
            {kindLabel(FsEntryKind.File)}
          </span>
          <span
            class={`${`${styles.fileCellBase({ className: "file-cell" }).class} ${styles.metadata().class} `} size`}
          />
          <span
            class={className(
              `${styles.fileCellBase({ className: "file-cell" }).class} font-500 text-rieul-text-3`,
              "modified",
              styles.hideInNarrowContainer().class,
            )}
          />
        </div>
      ) : null}
      <div {...styles.tableBottomPadding()} aria-hidden="true" />
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
    <span {...styles.span()}>
      <input
        ref={(element) => (inputRef.current = element)}
        {...styles.fileNameInput()}
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
        <span {...styles.fileRenameError()}>{props.error}</span>
      ) : null}
    </span>
  );
}

namespace styles {
  export const nameGap = style({
    gap: "7px",
  });
  export const metadata = style({
    color: theme.textTertiary,
    fontWeight: 500,
  });

  export const fileTable = style({
    gridTemplateColumns:
      "minmax(220px,1fr) minmax(96px,130px) minmax(88px,120px) minmax(140px,190px)",
    position: "relative",
    display: "grid",
    gridAutoRows: "25px",
    minHeight: "0",
    minWidth: "0",
    selectors: {
      "&::file-selector-button": {
        display: "table",
      },
    },
    overflow: "auto",
    borderWidth: "1px",
    borderColor: "rgb(255 255 255 / 0.56)",
    borderRadius: "8px",
    backgroundColor: "rgba(251, 251, 252, 0.98)",
    paddingTop: "2px",
    lineHeight: 1.38,
    "@container workbench-tab-page (max-width:680px)": {
      gridTemplateColumns: "minmax(200px,1fr) 96px 88px",
    },
  });
  export const hideInNarrowContainer = style({
    "@container workbench-tab-page (max-width:680px)": {
      display: "none",
    },
  });
  export const fileHead = style({
    position: "sticky",
    top: "0",
    zIndex: 2,
    boxSizing: "border-box",
    height: "21px",
    display: "flex",
    alignItems: "center",
    borderBottomWidth: "1px",
    borderBottomColor: "rgb(231 233 238 / 1)",
    backgroundColor: "rgb(253 253 253 / 1)",
    paddingLeft: "8px",
    paddingRight: "8px",
    fontSize: "10px",
    color: theme.textTertiary,
    fontWeight: 620,
  });
  export const fileRow = style({
    selectors: {
      "&.selected": {
        boxShadow:
          "inset 0 1px 0 rgba(255,255,255,0.78),inset 0 -1px 0 rgba(18,25,38,0.04),0 2px 6px rgba(25,38,56,0.045)",
        backgroundColor: "rgba(62, 84, 116, 0.15)",
      },
      "&.selected::before": {
        position: "absolute",
        bottom: "5px",
        left: "3px",
        top: "5px",
        width: "2px",
        borderRadius: "9999px",
        backgroundColor: theme.accent,
        content: "''",
      },
      "&:hover": {
        backgroundColor: "rgba(48, 64, 86, 0.026)",
      },
      "&.selected .file-cell svg": {
        color: "rgba(35, 84, 168, 0.82)",
      },
      "&.selected .file-cell": {
        color: theme.textPrimary,
      },
      "&.selected .file-cell.name": {
        fontWeight: 670,
      },
    },
    fontFamily: "inherit",
    gridColumn: "1/-1",
    gridTemplateColumns: "subgrid",
    position: "relative",
    zIndex: 1,
    display: "grid",
    marginLeft: "7px",
    marginRight: "7px",
    boxSizing: "border-box",
    height: "25px",
    minHeight: "25px",
    cursor: "pointer",
    WebkitAppearance: "none",
    appearance: "none",
    borderWidth: "0px",
    borderRadius: "6px",
    backgroundColor: "transparent",
    padding: "0",
    textAlign: "left",
    lineHeight: 1.38,
  });
  export const fileCellBase = style({
    minWidth: "0",
    display: "flex",
    alignItems: "center",
    overflow: "hidden",
    textOverflow: "ellipsis",
    whiteSpace: "nowrap",
    paddingLeft: "8px",
    paddingRight: "8px",
    fontSize: "12.5px",
    color: theme.textPrimary,
  });
  export const fileFirstColumn = style({
    paddingLeft: "10px",
  });
  export const fileName = style({
    minWidth: "0",
    overflow: "hidden",
    textOverflow: "ellipsis",
    whiteSpace: "nowrap",
    lineHeight: 1.38,
  });
  export const fileNameInput = style({
    font: "inherit",
    outlineOffset: "2px",
    selectors: {
      "&:focus": {
        outlineOffset: "2px",
        outline: "2px solid transparent",
        borderColor: theme.accent,
      },
      "&:disabled": {
        opacity: 0.64,
      },
    },
    boxSizing: "border-box",
    display: "block",
    height: "1.8rem",
    minHeight: "0",
    minWidth: "0",
    width: "100%",
    WebkitAppearance: "none",
    appearance: "none",
    borderWidth: "1px",
    borderColor: "transparent",
    borderRadius: "3px",
    backgroundColor: theme.bgPrimary,
    paddingLeft: "3px",
    paddingRight: "3px",
    paddingTop: "0",
    paddingBottom: "0",
    color: theme.textPrimary,
    lineHeight: "1.6rem",
    outline: "2px solid transparent",
  });
  export const fileRenameError = style({
    minWidth: "0",
    overflow: "hidden",
    textOverflow: "ellipsis",
    whiteSpace: "nowrap",
    color: theme.danger,
  });
  export const readonly = style({
    flex: "0 0 auto",
    borderWidth: "1px",
    borderColor: theme.warning,
    borderRadius: "9999px",
    backgroundColor: theme.warningSoft,
    paddingLeft: "4px",
    paddingRight: "4px",
    paddingTop: "0",
    paddingBottom: "0",
    color: theme.warning,
    lineHeight: 1,
  });
  export const tableEmpty = style({
    gridColumn: "1/-1",
    display: "flex",
    alignItems: "center",
    paddingLeft: "12px",
    paddingRight: "12px",
    color: theme.textTertiary,
  });
  export const tableBottomPadding = style({
    gridColumn: "1/-1",
    position: "relative",
    zIndex: 1,
    marginLeft: "8px",
    marginRight: "8px",
    marginTop: "8px",
    height: "78px",
    borderRadius: "10px",
    backgroundColor: "rgba(246, 246, 247, 0.18)",
  });
  export const span = style({
    maxWidth: "100%",
    minWidth: "0",
    display: "inline-flex",
    flex: "1 1 auto",
    alignSelf: "center",
  });
}
