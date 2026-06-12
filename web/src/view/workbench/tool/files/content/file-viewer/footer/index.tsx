import { useBunja } from "bunja/react";
import { useAtom } from "jotai";
import { formatSize } from "../../../../../../../state/explorer.ts";
import {
  fileViewerImpls,
  isFileViewerImpl,
} from "../impl/index.ts";
import { fileViewerBunja } from "../state.tsx";

const fileViewerFooterClassName = [
  "flex items-center justify-between gap-[12px] min-h-[28px]",
  "border-t border-t-[#d8dde7] bg-[#fbfcfe] text-[#667085]",
  "px-[16px] text-[12px]",
].join(" ");
const fileViewerImplControlClassName =
  "inline-flex items-center gap-[7px] min-w-0 text-[#667085]";
const fileViewerImplSelectClassName = [
  "w-[86px] h-[24px] min-h-[24px] border border-[#cfd7e5] rounded-[5px]",
  "bg-white text-[#344054] font-inherit leading-[22px] px-[6px]",
  "disabled:text-[#98a2b3] disabled:bg-[#f4f6fa]",
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
