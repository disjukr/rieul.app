import { useBunja } from "bunja/react";
import { FileText } from "lucide-react";
import { displayName, formatSize } from "../../../../../../state/explorer.ts";
import { fileViewerBunja } from "./state.tsx";

interface BigFileWarningProps {
  onCancel: () => void;
  onConfirm: () => void;
  viewerName: string;
}

const bigFileWarningClassName = [
  "grid place-items-center w-full h-full min-w-0 min-h-0",
  "overflow-auto bg-white p-[24px]",
].join(" ");
const bigFileWarningPanelClassName = [
  "grid [grid-template-columns:auto_minmax(0,1fr)] gap-[14px]",
  "w-[min(520px,100%)] border border-[#d8dde7] rounded-[8px]",
  "bg-[#fbfcfe] p-[16px]",
].join(" ");
const bigFileWarningIconClassName = [
  "grid place-items-center w-[42px] h-[42px] rounded-[8px]",
  "bg-[#eef3fb] text-[#4f8cff]",
].join(" ");
const bigFileWarningCopyClassName = [
  "grid gap-[5px] min-w-0",
  "[&_h2]:min-w-0 [&_h2]:m-0 [&_h2]:overflow-hidden",
  "[&_h2]:text-[#20242d] [&_h2]:text-[15px] [&_h2]:tracking-[0]",
  "[&_h2]:text-ellipsis [&_h2]:whitespace-nowrap",
  "[&_p]:min-w-0 [&_p]:m-0 [&_p]:[overflow-wrap:anywhere]",
  "[&_p]:text-[#667085] [&_p]:text-[12px]",
  "[&_strong]:text-[#303642] [&_strong]:text-[13px]",
].join(" ");
const bigFileWarningActionsClassName =
  "[grid-column:1/-1] flex justify-end gap-[8px]";

export function BigFileWarning(
  { onCancel, onConfirm, viewerName }: BigFileWarningProps,
) {
  const viewer = useBunja(fileViewerBunja);
  const fsEntry = viewer.fsEntry;
  const sizeLabel = fsEntry.size === undefined
    ? "Unknown size"
    : formatSize(fsEntry.size);

  return (
    <section className={bigFileWarningClassName}>
      <div className={bigFileWarningPanelClassName}>
        <div className={bigFileWarningIconClassName}>
          <FileText size={24} />
        </div>
        <div className={bigFileWarningCopyClassName}>
          <h2>{displayName(fsEntry)}</h2>
          <p>
            This file is <strong>{sizeLabel}</strong>. Do you want to open it
            {" "}
            with the {viewerName}?
          </p>
          <p>{fsEntry.path}</p>
        </div>
        <div className={bigFileWarningActionsClassName}>
          <button type="button" onClick={onCancel}>
            Cancel
          </button>
          <button type="button" onClick={onConfirm}>
            <FileText size={16} />
            Open
          </button>
        </div>
      </div>
    </section>
  );
}
