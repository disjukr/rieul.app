import { style } from "../../../../../../zyzz.config.ts";
import { createMemo } from "solid-js";
import { useBunja } from "bunja/solid";
import { FileText } from "../../../../../../solid/icons.tsx";
import { displayName, formatSize } from "../../../../../../state/explorer.ts";
import { Button } from "../../../../../ui/button.tsx";
import { fileViewerBunja } from "./state.tsx";
interface BigFileWarningProps {
  onCancel: () => void;
  onConfirm: () => void;
  viewerName: string;
}

export function BigFileWarning(props: BigFileWarningProps) {
  const viewer = useBunja(fileViewerBunja);
  const fsEntry = createMemo(() => viewer().fsEntry);
  const sizeLabel = createMemo(() =>
    fsEntry().size === undefined ? "Unknown size" : formatSize(fsEntry().size),
  );
  return (
    <section {...styles.bigFileWarning()}>
      <div {...styles.bigFileWarningPanel()}>
        <div {...styles.bigFileWarningIcon()}>
          <FileText size={24} />
        </div>
        <div {...styles.bigFileWarningCopy()}>
          <h2>{displayName(fsEntry())}</h2>
          <p>
            This file is <strong>{sizeLabel()}</strong>. Do you want to open it{" "}
            with the {props.viewerName}?
          </p>
          <p>{fsEntry().path}</p>
        </div>
        <div {...styles.bigFileWarningActions()}>
          <Button onClick={props.onCancel}>Cancel</Button>
          <Button onClick={props.onConfirm}>
            <FileText size={16} />
            Open
          </Button>
        </div>
      </div>
    </section>
  );
}

namespace styles {
  export const bigFileWarning = style({
    display: "grid",
    height: "100%",
    minHeight: "0",
    minWidth: "0",
    width: "100%",
    placeItems: "center",
    overflow: "auto",
    backgroundColor: "rgb(255 255 255 / 1)",
    padding: "24px",
  });
  export const bigFileWarningPanel = style({
    gridTemplateColumns: "auto minmax(0,1fr)",
    display: "grid",
    width: "min(520px,100%)",
    gap: "14px",
    borderWidth: "1px",
    borderColor: "rgb(216 221 231 / 1)",
    borderRadius: "8px",
    backgroundColor: "rgb(251 252 254 / 1)",
    padding: "16px",
  });
  export const bigFileWarningIcon = style({
    display: "grid",
    height: "42px",
    width: "42px",
    placeItems: "center",
    borderRadius: "8px",
    backgroundColor: "rgb(238 243 251 / 1)",
    color: "rgb(79 140 255 / 1)",
  });
  export const bigFileWarningCopy = style({
    selectors: {
      "& p": {
        overflowWrap: "anywhere",
        margin: "0",
        minWidth: "0",
        fontSize: "13px",
        color: "rgb(102 112 133 / 1)",
      },
      "& h2": {
        margin: "0",
        minWidth: "0",
        overflow: "hidden",
        textOverflow: "ellipsis",
        whiteSpace: "nowrap",
        fontSize: "16px",
        color: "rgb(32 36 45 / 1)",
        letterSpacing: "0",
      },
      "& strong": {
        fontSize: "14px",
        color: "rgb(48 54 66 / 1)",
      },
    },
    display: "grid",
    minWidth: "0",
    gap: "5px",
  });
  export const bigFileWarningActions = style({
    gridColumn: "1/-1",
    display: "flex",
    justifyContent: "flex-end",
    gap: "8px",
  });
}
