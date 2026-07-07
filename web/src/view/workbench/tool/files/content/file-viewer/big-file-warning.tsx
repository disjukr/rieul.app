import { useBunja } from "bunja/react";
import { FileText } from "lucide-react";
import { displayName, formatSize } from "../../../../../../state/explorer.ts";
import { Button } from "../../../../../ui/button.tsx";
import { fileViewerBunja } from "./state.tsx";

interface BigFileWarningProps {
  onCancel: () => void;
  onConfirm: () => void;
  viewerName: string;
}

const bigFileWarningClassName = [
  "grid place-items-center w-full h-full min-w-0 min-h-0",
  "overflow-auto bg-[var(--wgo-bg-primary)] p-[24px]",
].join(" ");
const bigFileWarningPanelClassName = [
  "grid [grid-template-columns:auto_minmax(0,1fr)] gap-[14px]",
  "w-[min(520px,100%)] border border-[var(--wgo-border-light)] rounded-[8px]",
  "bg-[var(--wgo-bg-subtle)] p-[16px]",
].join(" ");
const bigFileWarningIconClassName = [
  "grid place-items-center w-[42px] h-[42px] rounded-[8px]",
  "bg-[var(--wgo-bg-hover)] text-[var(--wgo-accent)]",
].join(" ");
const bigFileWarningCopyClassName = [
  "grid gap-[5px] min-w-0",
  "[&_h2]:min-w-0 [&_h2]:m-0 [&_h2]:overflow-hidden",
  "[&_h2]:text-[var(--wgo-text-primary)] [&_h2]:text-[15px] [&_h2]:tracking-[0]",
  "[&_h2]:text-ellipsis [&_h2]:whitespace-nowrap",
  "[&_p]:min-w-0 [&_p]:m-0 [&_p]:[overflow-wrap:anywhere]",
  "[&_p]:text-[var(--wgo-text-tertiary)] [&_p]:text-[12px]",
  "[&_strong]:text-[var(--wgo-text-strong)] [&_strong]:text-[13px]",
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
          <Button onClick={onCancel}>
            Cancel
          </Button>
          <Button onClick={onConfirm}>
            <FileText size={16} />
            Open
          </Button>
        </div>
      </div>
    </section>
  );
}
