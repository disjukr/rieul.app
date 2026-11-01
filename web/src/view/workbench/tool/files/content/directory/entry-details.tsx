import { style, theme } from "../../../../../../zyzz.config.ts";
import { ArrowUpRight, X } from "../../../../../../solid/icons.tsx";
import type { FsEntry } from "../../../../../../protocol/generated/rpc.ts";
import {
  displayName,
  formatDate,
  formatSize,
  kindLabel,
} from "../../../../../../state/explorer.ts";
import { Button } from "../../../../../ui/button.tsx";
import { EntryIcon } from "./entry-icon.tsx";

interface InspectorProps {
  entry?: FsEntry;
  currentPath?: string;
  onOpenEntry: (entry: FsEntry) => void;
}
interface EntryPropertiesModalProps {
  entry: FsEntry;
  onClose: () => void;
}
interface EntryDetailsProps {
  entry?: FsEntry;
  currentPath?: string;
  onOpenEntry?: (entry: FsEntry) => void;
}
export function Inspector(props: InspectorProps) {
  return (
    <aside {...styles.inspector({ className: "inspector" })}>
      <div {...styles.inspectorTitle()}>
        <span>Selection</span>
        <span {...styles.inspectorTitleMeta()}>Files</span>
      </div>
      <EntryDetails
        entry={props.entry}
        currentPath={props.currentPath}
        onOpenEntry={props.onOpenEntry}
      />
    </aside>
  );
}
export function EntryPropertiesModal(props: EntryPropertiesModalProps) {
  return (
    <div
      {...styles.modalBackdrop()}
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) props.onClose();
      }}
    >
      <section
        {...styles.machineModal()}
        role="dialog"
        aria-modal="true"
        aria-labelledby="entry-properties-title"
      >
        <header {...styles.modalHead()}>
          <div>
            <span>File</span>
            <h2 id="entry-properties-title">Properties</h2>
          </div>
          <Button
            onClick={props.onClose}
            title="Close"
            aria-label="Close properties modal"
            className={styles.iconButton().class}
          >
            <X size={16} />
          </Button>
        </header>

        <div {...styles.entryPropertiesBody()}>
          <EntryDetails entry={props.entry} />
        </div>
      </section>
    </div>
  );
}
function EntryDetails(props: EntryDetailsProps) {
  return (
    <>
      {!props.entry ? (
        <div {...styles.details()}>
          <div {...styles.detailsSummary()}>
            <span {...styles.detailsIcon()} aria-hidden="true" />
            <div {...styles.div()}>
              <div {...styles.detailsTitle()}>No selection</div>
              <div {...styles.detailsMeta()}>
                {props.currentPath ?? "Files"}
              </div>
            </div>
          </div>
        </div>
      ) : (
        <div {...styles.details()}>
          <div {...styles.detailsSummary()}>
            <span {...styles.detailsIcon()}>
              <EntryIcon entry={props.entry} />
            </span>
            <div {...styles.div2()}>
              <div {...styles.detailsTitle()}>{displayName(props.entry)}</div>
              <div {...styles.detailsMeta()}>{summaryLine(props.entry)}</div>
            </div>
            {props.onOpenEntry ? (
              <button
                type="button"
                {...styles.objectActionButton()}
                onClick={() => {
                  if (props.entry) props.onOpenEntry?.(props.entry);
                }}
              >
                <ArrowUpRight size={11} />
                Open
              </button>
            ) : null}
          </div>
          <div {...styles.detailsSectionTitle()}>Info</div>
          <dl {...styles.detailsList()}>
            <DetailRow label="Source" value="Machine" />
            <DetailRow label="Parent" value={parentName(props.entry.path)} />
            <DetailRow label="Kind" value={kindLabel(props.entry.kind)} />
            <DetailRow label="Path" value={props.entry.path} />
            <DetailRow
              label="Modified"
              value={formatDate(props.entry.modifiedAtMs)}
            />
            <DetailRow
              label="Access"
              value={props.entry.readonly ? "Read only" : "Writable"}
            />
          </dl>
        </div>
      )}
    </>
  );
}
function summaryLine(entry: FsEntry) {
  const parts = [kindLabel(entry.kind)];
  const size = formatSize(entry.size);
  if (size) parts.push(size);
  parts.push(entry.readonly ? "Read only" : "Writable");
  return parts.join(" · ");
}
function parentName(path: string): string {
  const normalized = path.replace(/\/+$/, "");
  const slashIndex = normalized.lastIndexOf("/");
  if (slashIndex <= 0) return "/";
  const parentPath = normalized.slice(0, slashIndex);
  const parentSlashIndex = parentPath.lastIndexOf("/");
  return parentPath.slice(parentSlashIndex + 1) || "/";
}
function DetailRow(props: { label: string; value: string }) {
  return (
    <div>
      <dt>{props.label}</dt>
      <dd title={props.value}>{props.value}</dd>
    </div>
  );
}

namespace styles {
  export const inspector = style({
    minWidth: "0",
    overflow: "auto",
    borderWidth: "1px",
    borderColor: "rgb(255 255 255 / 0.52)",
    borderRadius: "8px",
    backgroundColor: "rgba(247, 247, 248, 0.72)",
    padding: "10px",
    WebkitBackdropFilter: "blur(40px)",
    backdropFilter: "blur(40px)",
    "@container workbench-tab-page (max-width:980px)": {
      display: "none",
    },
  });
  export const inspectorTitle = style({
    marginBottom: "8px",
    display: "flex",
    alignItems: "center",
    justifyContent: "space-between",
    paddingLeft: "2px",
    paddingRight: "2px",
    fontSize: "11px",
    color: theme.textTertiary,
    fontWeight: 700,
    lineHeight: 1,
  });
  export const inspectorTitleMeta = style({
    borderRadius: "999px",
    backgroundColor: "rgba(47, 109, 246, 0.08)",
    paddingLeft: "6px",
    paddingRight: "6px",
    paddingTop: "3px",
    paddingBottom: "3px",
    fontSize: "10.5px",
    color: "rgba(35, 84, 168, 0.82)",
    fontWeight: 660,
    textTransform: "none",
  });
  export const details = style({
    display: "grid",
    alignContent: "flex-start",
    gap: "8px",
  });
  export const detailsSummary = style({
    display: "grid",
    gridTemplateColumns: "34px minmax(0,1fr) auto",
    minWidth: "0",
    alignItems: "center",
    gap: "9px",
    borderWidth: "1px",
    borderColor: "rgb(255 255 255 / 0.46)",
    borderRadius: "8px",
    backgroundColor: "rgba(248, 248, 249, 0.42)",
    paddingLeft: "7px",
    paddingRight: "7px",
    paddingTop: "7px",
    paddingBottom: "7px",
  });
  export const detailsIcon = style({
    display: "grid",
    selectors: {
      "& svg": {
        height: "17px",
        width: "17px",
      },
    },
    height: "30px",
    width: "30px",
    placeItems: "center",
    borderWidth: "1px",
    borderColor: "rgba(255, 255, 255, 0.58)",
    borderRadius: "7px",
    backgroundColor: "rgba(247, 247, 248, 0.48)",
    color: "rgba(47, 82, 145, 0.78)",
  });
  export const detailsTitle = style({
    maxWidth: "100%",
    minWidth: "0",
    overflow: "hidden",
    textOverflow: "ellipsis",
    whiteSpace: "nowrap",
    fontSize: "14px",
    color: theme.textPrimary,
    fontWeight: 740,
  });
  export const detailsMeta = style({
    maxWidth: "100%",
    minWidth: "0",
    overflow: "hidden",
    textOverflow: "ellipsis",
    whiteSpace: "nowrap",
    fontSize: "12px",
    color: theme.textTertiary,
    fontWeight: 560,
  });
  export const objectActionButton = style({
    transition:
      "background var(--rieul-duration-fast,100ms) var(--rieul-ease-out,cubic-bezier(0.16,1,0.3,1)),color var(--rieul-duration-fast,100ms) var(--rieul-ease-out,cubic-bezier(0.16,1,0.3,1)),border-color var(--rieul-duration-fast,100ms) var(--rieul-ease-out,cubic-bezier(0.16,1,0.3,1)),box-shadow var(--rieul-duration-fast,100ms) var(--rieul-ease-out,cubic-bezier(0.16,1,0.3,1))",
    fontFamily: "inherit",
    height: "24px",
    minHeight: "24px",
    display: "inline-flex",
    cursor: "pointer",
    WebkitAppearance: "none",
    appearance: "none",
    alignItems: "center",
    justifyContent: "center",
    gap: "4px",
    borderWidth: "1px",
    borderColor: "rgba(47, 109, 246, 0.16)",
    selectors: {
      "&:hover": {
        borderColor: "rgba(47, 109, 246, 0.24)",
        backgroundColor: "rgba(47, 109, 246, 0.11)",
        color: "rgba(25, 70, 152, 0.98)",
      },
      "&:focus-visible": {
        outlineWidth: "2px",
        outlineColor: theme.focus,
        outlineOffset: "1px",
        outlineStyle: "solid",
      },
    },
    borderRadius: "6px",
    backgroundColor: "rgba(47, 109, 246, 0.075)",
    paddingLeft: "7px",
    paddingRight: "7px",
    fontSize: "11.5px",
    color: "rgba(35, 84, 168, 0.88)",
    fontWeight: 700,
    boxShadow:
      "0 0 rgb(0 0 0 / 0), 0 0 rgb(0 0 0 / 0), inset 0 1px 0 rgba(255, 255, 255, 0.76)",
  });
  export const detailsSectionTitle = style({
    paddingLeft: "2px",
    paddingRight: "2px",
    paddingTop: "2px",
    fontSize: "11px",
    color: theme.textTertiary,
    fontWeight: 700,
    lineHeight: 1,
  });
  export const detailsList = style({
    selectors: {
      "& div": {
        display: "grid",
        gridTemplateColumns: "68px minmax(0,1fr)",
        alignItems: "baseline",
        gap: "9px",
        borderBottomWidth: "1px",
        borderBottomColor: "rgba(18, 25, 38, 0.045)",
        paddingTop: "5px",
        paddingBottom: "5px",
      },
      "& dd": {
        margin: "0",
        minWidth: "0",
        overflow: "hidden",
        textOverflow: "ellipsis",
        fontSize: "12.5px",
        color: theme.textSecondary,
        fontWeight: 620,
      },
      "& dt": {
        margin: "0",
        fontSize: "11px",
        color: theme.textTertiary,
        fontWeight: 620,
      },
      "& div:last-child": {
        borderBottomWidth: "0px",
      },
    },
    display: "grid",
    margin: "0",
    gap: "0",
    paddingLeft: "2px",
    paddingRight: "2px",
  });
  export const modalBackdrop = style({
    position: "fixed",
    inset: "0",
    zIndex: 20,
    display: "grid",
    placeItems: "center",
    backgroundColor: "rgb(32 36 45 / 42%)",
    padding: "24px",
  });
  export const machineModal = style({
    boxShadow: "0 24px 72px rgb(32 36 45 / 28%)",
    width: "min(460px,100%)",
    overflow: "hidden",
    borderWidth: "1px",
    borderColor: "rgb(216 221 231 / 1)",
    borderRadius: "8px",
    backgroundColor: "rgb(255 255 255 / 1)",
  });
  export const modalHead = style({
    selectors: {
      "& div": {
        display: "grid",
        minWidth: "0",
        gap: "2px",
      },
      "& h2": {
        margin: "0",
        fontSize: "18px",
        color: "rgb(32 36 45 / 1)",
        letterSpacing: "0",
      },
      "& span": {
        fontSize: "13px",
        color: "rgb(102 112 133 / 1)",
        fontWeight: 700,
      },
    },
    display: "flex",
    alignItems: "center",
    justifyContent: "space-between",
    gap: "12px",
    borderBottomWidth: "1px",
    borderBottomColor: "rgb(228 232 239 / 1)",
    paddingLeft: "16px",
    paddingRight: "16px",
    paddingTop: "14px",
    paddingBottom: "14px",
  });
  export const iconButton = style({
    minWidth: "36px !important",
    width: "36px !important",
    padding: "0 !important",
  });
  export const entryPropertiesBody = style({
    selectors: {
      "& dd": {
        overflowWrap: "anywhere",
        marginLeft: "0",
        marginRight: "0",
        marginBottom: "8px",
        marginTop: "0",
        minWidth: "0",
        fontSize: "14px",
        color: "rgb(48 54 66 / 1)",
      },
      "& dl": {
        display: "grid",
        margin: "0",
        gap: "6px",
      },
      "& dt": {
        fontSize: "13px",
        color: "rgb(102 112 133 / 1)",
        fontWeight: 700,
      },
    },
    paddingLeft: "16px",
    paddingRight: "16px",
    paddingBottom: "16px",
    paddingTop: "14px",
  });
  export const div = style({
    minWidth: "0",
  });
  export const div2 = style({
    display: "grid",
    maxWidth: "100%",
    minWidth: "0",
    gap: "3px",
  });
}
