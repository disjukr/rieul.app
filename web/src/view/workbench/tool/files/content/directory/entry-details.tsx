import { ArrowUpRight, X } from "lucide-react";
import type { FsEntry } from "../../../../../../protocol/generated/rpc.ts";
import {
  displayName,
  formatDate,
  formatSize,
  kindLabel,
} from "../../../../../../state/explorer.ts";
import { Button } from "../../../../../ui/button.tsx";
import { EntryIcon } from "./entry-icon.tsx";

const inspectorClassName = [
  "inspector min-w-0 overflow-auto rounded-[8px] border border-white/52",
  "[@container_workbench-tab-page_(max-width:980px)]:hidden",
  "bg-[rgba(247,247,248,0.72)]",
  "p-[10px] backdrop-blur-2xl",
].join(" ");
const inspectorTitleClassName =
  "mb-[8px] flex items-center justify-between px-[2px] text-[11px] font-700 leading-none text-wgo-text-3/82";
const inspectorTitleMetaClassName =
  "rounded-[999px] bg-[rgba(47,109,246,0.08)] px-[6px] py-[3px] text-[10.5px] font-660 normal-case text-[rgba(35,84,168,0.82)]";
const detailsClassName = "grid content-start gap-[8px]";
const detailsSummaryClassName = [
  "grid min-w-0 grid-cols-[34px_minmax(0,1fr)_auto] items-center gap-[9px]",
  "rounded-[8px] border border-white/46 bg-[rgba(248,248,249,0.42)]",
  "px-[7px] py-[7px]",
].join(" ");
const detailsIconClassName =
  "grid h-[30px] w-[30px] place-items-center rounded-[7px] border border-[rgba(255,255,255,0.58)] bg-[rgba(247,247,248,0.48)] text-[rgba(47,82,145,0.78)] [&_svg]:h-[17px] [&_svg]:w-[17px]";
const detailsTitleClassName =
  "min-w-0 max-w-full overflow-hidden text-ellipsis whitespace-nowrap text-[14px] font-740 text-wgo-text";
const detailsMetaClassName =
  "min-w-0 max-w-full overflow-hidden text-ellipsis whitespace-nowrap text-[12px] font-560 text-wgo-text-3";
const objectActionButtonClassName = [
  "inline-flex h-[24px] min-h-[24px] appearance-none items-center justify-center gap-[4px]",
  "rounded-[6px] border border-[rgba(47,109,246,0.16)] bg-[rgba(47,109,246,0.075)]",
  "px-[7px] text-[11.5px] font-700 text-[rgba(35,84,168,0.88)] [font-family:inherit]",
  "shadow-[inset_0_1px_0_rgba(255,255,255,0.76)]",
  "cursor-pointer wgo-transition",
  "hover:border-[rgba(47,109,246,0.24)] hover:bg-[rgba(47,109,246,0.11)] hover:text-[rgba(25,70,152,0.98)]",
  "focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-wgo-focus",
].join(" ");
const detailsSectionTitleClassName =
  "px-[2px] pt-[2px] text-[11px] font-700 leading-none text-wgo-text-3/82";
const detailsListClassName = [
  "grid m-0 gap-0 px-[2px]",
  "[&_div]:grid [&_div]:grid-cols-[68px_minmax(0,1fr)] [&_div]:items-baseline [&_div]:gap-[9px]",
  "[&_div]:border-b [&_div]:border-b-[rgba(18,25,38,0.045)] [&_div]:py-[5px] [&_div:last-child]:border-b-0",
  "[&_dt]:m-0 [&_dt]:text-[11px] [&_dt]:font-620 [&_dt]:text-wgo-text-3",
  "[&_dd]:m-0 [&_dd]:min-w-0 [&_dd]:overflow-hidden [&_dd]:text-ellipsis [&_dd]:text-[12.5px] [&_dd]:font-620 [&_dd]:text-wgo-text-2",
].join(" ");
const modalBackdropClassName =
  "fixed inset-0 z-[20] grid place-items-center bg-[rgb(32_36_45_/_42%)] p-[24px]";
const machineModalClassName = [
  "w-[min(460px,100%)] overflow-hidden border border-[#d8dde7]",
  "rounded-[8px] bg-white [box-shadow:0_24px_72px_rgb(32_36_45_/_28%)]",
].join(" ");
const modalHeadClassName = [
  "flex items-center justify-between gap-[12px] border-b border-b-[#e4e8ef]",
  "px-[16px] py-[14px]",
  "[&_div]:grid [&_div]:gap-[2px] [&_div]:min-w-0",
  "[&_span]:text-[#667085] [&_span]:text-[13px] [&_span]:font-700",
  "[&_h2]:m-0 [&_h2]:text-[#20242d] [&_h2]:text-[18px] [&_h2]:tracking-[0]",
].join(" ");
const iconButtonClassName = "!w-[36px] !min-w-[36px] !p-0";
const entryPropertiesBodyClassName = [
  "pt-[14px] px-[16px] pb-[16px]",
  "[&_dl]:grid [&_dl]:gap-[6px] [&_dl]:m-0",
  "[&_dt]:text-[#667085] [&_dt]:text-[13px] [&_dt]:font-700",
  "[&_dd]:min-w-0 [&_dd]:mt-0 [&_dd]:mx-0 [&_dd]:mb-[8px]",
  "[&_dd]:[overflow-wrap:anywhere] [&_dd]:text-[#303642] [&_dd]:text-[14px]",
].join(" ");

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

export function Inspector(
  { entry, currentPath, onOpenEntry }: InspectorProps,
) {
  return (
    <aside className={inspectorClassName}>
      <div className={inspectorTitleClassName}>
        <span>Selection</span>
        <span className={inspectorTitleMetaClassName}>Files</span>
      </div>
      <EntryDetails
        entry={entry}
        currentPath={currentPath}
        onOpenEntry={onOpenEntry}
      />
    </aside>
  );
}

export function EntryPropertiesModal(
  { entry, onClose }: EntryPropertiesModalProps,
) {
  return (
    <div
      className={modalBackdropClassName}
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <section
        className={machineModalClassName}
        role="dialog"
        aria-modal="true"
        aria-labelledby="entry-properties-title"
      >
        <header className={modalHeadClassName}>
          <div>
            <span>File</span>
            <h2 id="entry-properties-title">Properties</h2>
          </div>
          <Button
            onClick={onClose}
            title="Close"
            aria-label="Close properties modal"
            className={iconButtonClassName}
          >
            <X size={16} />
          </Button>
        </header>

        <div className={entryPropertiesBodyClassName}>
          <EntryDetails entry={entry} />
        </div>
      </section>
    </div>
  );
}

function EntryDetails(
  { entry, currentPath, onOpenEntry }: EntryDetailsProps,
) {
  if (!entry) {
    return (
      <div className={detailsClassName}>
        <div className={detailsSummaryClassName}>
          <span className={detailsIconClassName} aria-hidden="true" />
          <div className="min-w-0">
            <div className={detailsTitleClassName}>No selection</div>
            <div className={detailsMetaClassName}>{currentPath ?? "Files"}</div>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className={detailsClassName}>
      <div className={detailsSummaryClassName}>
        <span className={detailsIconClassName}>
          <EntryIcon entry={entry} />
        </span>
        <div className="grid min-w-0 max-w-full gap-[3px]">
          <div className={detailsTitleClassName}>{displayName(entry)}</div>
          <div className={detailsMetaClassName}>
            {summaryLine(entry)}
          </div>
        </div>
        {onOpenEntry
          ? (
            <button
              type="button"
              className={objectActionButtonClassName}
              onClick={() => onOpenEntry(entry)}
            >
              <ArrowUpRight size={11} />
              Open
            </button>
          )
          : null}
      </div>
      <div className={detailsSectionTitleClassName}>Info</div>
      <dl className={detailsListClassName}>
        <DetailRow label="Source" value="Machine" />
        <DetailRow label="Parent" value={parentName(entry.path)} />
        <DetailRow label="Kind" value={kindLabel(entry.kind)} />
        <DetailRow label="Path" value={entry.path} />
        <DetailRow label="Modified" value={formatDate(entry.modifiedAtMs)} />
        <DetailRow
          label="Access"
          value={entry.readonly ? "Read only" : "Writable"}
        />
      </dl>
    </div>
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

function DetailRow(
  { label, value }: {
    label: string;
    value: string;
  },
) {
  return (
    <div>
      <dt>{label}</dt>
      <dd title={value}>{value}</dd>
    </div>
  );
}
