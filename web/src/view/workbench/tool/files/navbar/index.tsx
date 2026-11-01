import { style } from "../../../../../zyzz.config.ts";
import { createMemo, useContext } from "solid-js";
import { ArrowLeft, ArrowUp } from "../../../../../solid/icons.tsx";

import {
  FilesActionsContext,
  FilesExplorerContext,
  requireFilesActions,
  requireFilesExplorer,
} from "../context.tsx";
import { Button } from "../../../../ui/button.tsx";
import { PathCrumbs } from "./path-crumbs.tsx";

export function FilesNavbar() {
  const explorer = requireFilesExplorer(useContext(FilesExplorerContext));
  const actions = requireFilesActions(useContext(FilesActionsContext));
  const currentPath = () => explorer().currentPath();
  const displayPath = () => explorer().displayPath();
  const history = () => explorer().history();
  const specialLocation = () => explorer().specialLocation();
  const canGoBack = createMemo(() => history().length > 0);
  const canGoUp = createMemo(
    () => currentPath() !== undefined && !specialLocation(),
  );
  return (
    <div {...styles.pathToolbar()}>
      <div {...styles.pathToolbarButtonGroup()}>
        <Button
          onClick={actions().goBack}
          disabled={!canGoBack()}
          title="Back"
          aria-label="Back"
          className={styles.pathToolbarButton().class}
        >
          <ArrowLeft size={12} />
        </Button>
        <Button
          onClick={actions().goUp}
          disabled={!canGoUp()}
          title="Up"
          aria-label="Up"
          className={styles.pathToolbarButton().class}
        >
          <ArrowUp size={12} />
        </Button>
      </div>
      <PathCrumbs path={displayPath()} onNavigate={actions().navigate} />
    </div>
  );
}

namespace styles {
  export const pathToolbar = style({
    gridTemplateColumns: "auto minmax(0,1fr)",
    position: "relative",
    display: "grid",
    boxSizing: "border-box",
    height: "29px",
    minHeight: "29px",
    alignItems: "center",
    gap: "6px",
    overflow: "visible",
    borderWidth: "1px",
    borderColor: "transparent",
    borderRadius: "8px",
    backgroundColor: "rgba(248, 248, 249, 0.32)",
    paddingLeft: "5px",
    paddingRight: "5px",
    paddingTop: "0",
    paddingBottom: "0",
    lineHeight: 1.38,
    WebkitBackdropFilter: "blur(40px)",
    backdropFilter: "blur(40px)",
  });
  export const pathToolbarButtonGroup = style({
    boxSizing: "border-box",
    height: "23px",
    display: "inline-flex",
    alignItems: "center",
    gap: "3px",
  });
  export const pathToolbarButton = style({
    boxSizing: "border-box !important",
    height: "23px !important",
    minHeight: "0 !important",
    minWidth: "23px !important",
    width: "23px !important",
    borderColor: "transparent !important",
    borderRadius: "6px !important",
    backgroundColor: "rgb(255 255 255 / 0.28) !important",
    selectors: {
      "&:hover": {
        backgroundColor: "rgb(255 255 255 / 0.05) !important",
      },
    },
    padding: "0 !important",
  });
}
