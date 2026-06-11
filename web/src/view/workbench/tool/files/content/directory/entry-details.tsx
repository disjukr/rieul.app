import { X } from "lucide-react";
import { FsEntry } from "../../../../../../protocol/rpc.ts";
import {
  displayName,
  formatDate,
  formatSize,
  kindLabel,
} from "../../../../../../state/explorer.ts";

const inspectorClassName = [
  "inspector min-w-0 overflow-auto border-l border-l-[#d8dde7]",
  "[@container_workbench-tab-page_(max-width:980px)]:hidden",
  "bg-[#fbfcfe] p-[14px]",
  "[&_dl]:grid [&_dl]:gap-[6px] [&_dl]:m-0",
  "[&_dt]:text-[#667085] [&_dt]:text-[12px] [&_dt]:font-700",
  "[&_dd]:min-w-0 [&_dd]:mt-0 [&_dd]:mx-0 [&_dd]:mb-[8px]",
  "[&_dd]:[overflow-wrap:anywhere] [&_dd]:text-[#303642] [&_dd]:text-[13px]",
].join(" ");
const inspectorTitleClassName = "mb-[12px] text-[#20242d] font-700";
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
  "[&_span]:text-[#667085] [&_span]:text-[12px] [&_span]:font-700",
  "[&_h2]:m-0 [&_h2]:text-[#20242d] [&_h2]:text-[18px] [&_h2]:tracking-[0]",
].join(" ");
const iconButtonClassName = "w-[36px] min-w-[36px] p-0";
const entryPropertiesBodyClassName = [
  "pt-[14px] px-[16px] pb-[16px]",
  "[&_dl]:grid [&_dl]:gap-[6px] [&_dl]:m-0",
  "[&_dt]:text-[#667085] [&_dt]:text-[12px] [&_dt]:font-700",
  "[&_dd]:min-w-0 [&_dd]:mt-0 [&_dd]:mx-0 [&_dd]:mb-[8px]",
  "[&_dd]:[overflow-wrap:anywhere] [&_dd]:text-[#303642] [&_dd]:text-[13px]",
].join(" ");

interface InspectorProps {
  entry?: FsEntry;
  currentPath?: string;
}

interface EntryPropertiesModalProps {
  entry: FsEntry;
  onClose: () => void;
}

interface EntryDetailsProps {
  entry?: FsEntry;
  currentPath?: string;
}

export function Inspector(
  { entry, currentPath }: InspectorProps,
) {
  return (
    <aside className={inspectorClassName}>
      <div className={inspectorTitleClassName}>Selection</div>
      <EntryDetails entry={entry} currentPath={currentPath} />
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
          <button
            type="button"
            onClick={onClose}
            title="Close"
            aria-label="Close properties modal"
            className={iconButtonClassName}
          >
            <X size={16} />
          </button>
        </header>

        <div className={entryPropertiesBodyClassName}>
          <EntryDetails entry={entry} />
        </div>
      </section>
    </div>
  );
}

function EntryDetails(
  { entry, currentPath }: EntryDetailsProps,
) {
  if (!entry) {
    return (
      <dl>
        <dt>Location</dt>
        <dd>{currentPath ?? "Files"}</dd>
      </dl>
    );
  }

  return (
    <dl>
      <dt>Name</dt>
      <dd>{displayName(entry)}</dd>
      <dt>Path</dt>
      <dd>{entry.path}</dd>
      <dt>Kind</dt>
      <dd>{kindLabel(entry.kind)}</dd>
      <dt>Size</dt>
      <dd>{formatSize(entry.size)}</dd>
      <dt>Modified</dt>
      <dd>{formatDate(entry.modifiedAtMs)}</dd>
      <dt>Flags</dt>
      <dd>{entry.readonly ? "Readonly" : "Writable"}</dd>
    </dl>
  );
}
