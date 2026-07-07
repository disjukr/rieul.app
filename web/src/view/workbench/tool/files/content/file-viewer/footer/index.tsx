import { useBunja } from "bunja/react";
import { useAtom } from "jotai";
import { formatSize } from "../../../../../../../state/explorer.ts";
import { fileViewerImpls, isFileViewerImpl } from "../impl/index.ts";
import { fileViewerBunja } from "../state.tsx";

const fileViewerFooterClassName = [
  "flex items-center justify-between gap-[12px] h-[2rem] min-h-[2rem] box-border",
  "border-t border-t-[var(--wgo-border-light)] bg-[var(--wgo-bg-subtle)] text-[var(--wgo-text-tertiary)]",
  "px-[8px] leading-[1.6]",
].join(" ");
const fileViewerImplControlClassName =
  "inline-flex items-center gap-[7px] min-w-0 text-[var(--wgo-text-tertiary)]";
const fileViewerImplSelectClassName = [
  "w-[86px] h-[2rem] min-h-[2rem] box-border border border-[var(--wgo-border-control-soft)] rounded-[4px]",
  "bg-[var(--wgo-bg-primary)] text-[var(--wgo-text-control)] font-inherit leading-[1.6] px-[6px]",
  "disabled:text-[var(--wgo-text-disabled)] disabled:bg-[var(--wgo-bg-control-disabled)]",
].join(" ");
const fileViewerFooterSizeClassName = "flex-[0_0_auto]";

export function FileViewerFooter() {
  const viewer = useBunja(fileViewerBunja);
  const [impl, setImpl] = useAtom(viewer.implAtom);
  const disabled = impl === undefined;

  return (
    <div className={fileViewerFooterClassName}>
      <label className={fileViewerImplControlClassName}>
        <span>View</span>
        <select
          className={fileViewerImplSelectClassName}
          value={impl ?? "text"}
          disabled={disabled}
          aria-label="File viewer"
          onChange={(event) => {
            const value = event.currentTarget.value;
            if (isFileViewerImpl(value)) setImpl(value);
          }}
        >
          {Object.entries(fileViewerImpls).map(([id, viewerImpl]) => (
            <option key={id} value={id}>
              {viewerImpl.label}
            </option>
          ))}
        </select>
      </label>
      <span className={fileViewerFooterSizeClassName}>
        {formatSize(viewer.fsEntry.size)}
      </span>
    </div>
  );
}
