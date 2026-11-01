import { style } from "../../../../../../../zyzz.config.ts";
import { createMemo } from "solid-js";
import { useBunja } from "bunja/solid";

import { formatSize } from "../../../../../../../state/explorer.ts";
import { fileViewerImpls, isFileViewerImpl } from "../impl/index.ts";
import { fileViewerBunja } from "../state.tsx";

export function FileViewerFooter() {
  const viewer = useBunja(fileViewerBunja);
  const impl = () => viewer().impl();
  const disabled = createMemo(() => impl() === undefined);
  return (
    <div {...styles.fileViewerFooter()}>
      <label {...styles.fileViewerImplControl()}>
        <span>View</span>
        <select
          {...styles.fileViewerImplSelect()}
          value={impl() ?? "text"}
          disabled={disabled()}
          aria-label="File viewer"
          onChange={(event) => {
            const value = event.currentTarget.value;
            if (isFileViewerImpl(value)) viewer().setImpl(value);
          }}
        >
          {Object.entries(fileViewerImpls).map(([id, viewerImpl]) => (
            <option value={id}>{viewerImpl.label}</option>
          ))}
        </select>
      </label>
      <span {...styles.fileViewerFooterSize()}>
        {formatSize(viewer().fsEntry.size)}
      </span>
    </div>
  );
}

namespace styles {
  export const fileViewerFooter = style({
    boxSizing: "border-box",
    height: "2rem",
    minHeight: "2rem",
    display: "flex",
    alignItems: "center",
    justifyContent: "space-between",
    gap: "12px",
    borderTopWidth: "1px",
    borderTopColor: "rgb(216 221 231 / 1)",
    backgroundColor: "rgb(251 252 254 / 1)",
    paddingLeft: "8px",
    paddingRight: "8px",
    color: "rgb(102 112 133 / 1)",
    lineHeight: 1.6,
  });
  export const fileViewerImplControl = style({
    minWidth: "0",
    display: "inline-flex",
    alignItems: "center",
    gap: "7px",
    color: "rgb(102 112 133 / 1)",
  });
  export const fileViewerImplSelect = style({
    boxSizing: "border-box",
    height: "2rem",
    minHeight: "2rem",
    width: "86px",
    borderWidth: "1px",
    borderColor: "rgb(207 215 229 / 1)",
    borderRadius: "4px",
    backgroundColor: "rgb(255 255 255 / 1)",
    selectors: {
      "&:disabled": {
        backgroundColor: "rgb(244 246 250 / 1)",
        color: "rgb(152 162 179 / 1)",
      },
    },
    paddingLeft: "6px",
    paddingRight: "6px",
    color: "rgb(52 64 84 / 1)",
    lineHeight: 1.6,
    fontFamily: "inherit",
  });
  export const fileViewerFooterSize = style({
    flex: "0 0 auto",
  });
}
