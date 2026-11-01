import { style, theme } from "../../../../../zyzz.config.ts";
import { untrack, createMemo, createSignal, createEffect } from "solid-js";
import { ChevronRight } from "../../../../../solid/icons.tsx";
import {
  pathCrumbs,
  trashLocationPath,
} from "../../../../../state/explorer.ts";
interface PathCrumbsProps {
  path?: string;
  onNavigate: (path?: string) => void;
}

export function PathCrumbs(props: PathCrumbsProps) {
  const [editing, setEditing] = createSignal(false);
  const [draftPath, setDraftPath] = createSignal(
    untrack(() => props.path ?? ""),
  );
  const inputRef = { current: null as HTMLInputElement | null };
  const crumbsRef = { current: null as HTMLDivElement | null };
  const trashLocation = createMemo(() => props.path === trashLocationPath);
  const crumbs = createMemo(() =>
    trashLocation()
      ? [{ label: "Root" }, { label: "Trash", path: trashLocationPath }]
      : pathCrumbs(props.path),
  );
  createEffect(
    () => ({ editing: editing(), path: props.path }),
    ({ editing: currentEditing, path: currentPath }) => {
      if (!currentEditing) setDraftPath(currentPath ?? "");
    },
  );
  createEffect(
    () => ({ editing: editing() }),
    ({ editing: currentEditing }) => {
      if (!currentEditing) return;
      inputRef.current?.focus();
      inputRef.current?.select();
    },
  );
  createEffect(
    () => ({ editing: editing(), path: props.path }),
    ({ editing: currentEditing }) => {
      if (currentEditing) return;
      const element = crumbsRef.current;
      if (!element) return;
      const frame = requestAnimationFrame(() => {
        element.scrollLeft = element.scrollWidth;
      });
      return () => cancelAnimationFrame(frame);
    },
  );
  createEffect(
    () => ({ editing: editing() }),
    ({ editing: currentEditing }) => {
      if (currentEditing) return;
      const element = crumbsRef.current;
      if (!element) return;
      const crumbsElement = element;
      function scrollCrumbsHorizontally(event: WheelEvent) {
        if (crumbsElement.scrollWidth <= crumbsElement.clientWidth) return;
        const delta = event.deltaX || event.deltaY;
        if (delta === 0) return;
        event.preventDefault();
        crumbsElement.scrollLeft += delta;
      }
      crumbsElement.addEventListener("wheel", scrollCrumbsHorizontally, {
        passive: false,
      });
      return () => {
        crumbsElement.removeEventListener("wheel", scrollCrumbsHorizontally);
      };
    },
  );
  function beginEditing() {
    const currentTrashLocation = trashLocation();
    if (currentTrashLocation) return;
    setDraftPath(props.path ?? "");
    setEditing(true);
  }
  function cancelEditing() {
    setDraftPath(props.path ?? "");
    setEditing(false);
  }
  function submitPath(event: SubmitEvent) {
    const currentDraftPath = draftPath();
    event.preventDefault();
    const nextPath = currentDraftPath.trim();
    setEditing(false);
    props.onNavigate(nextPath || undefined);
  }
  return (
    <>
      {editing() ? (
        <form {...styles.pathInputForm()} onSubmit={submitPath}>
          <input
            ref={(element) => (inputRef.current = element)}
            value={draftPath()}
            onInput={(event) => setDraftPath(event.target.value)}
            onBlur={cancelEditing}
            onKeyDown={(event) => {
              if (event.key === "Escape") cancelEditing();
            }}
            aria-label="Path"
            placeholder="Path"
          />
        </form>
      ) : (
        <div
          ref={(element) => (crumbsRef.current = element)}
          {...styles.crumbs()}
          aria-label="Path"
          onMouseDown={(event) => {
            if (event.target !== event.currentTarget) return;
            event.preventDefault();
            beginEditing();
          }}
        >
          {crumbs().map((crumb, index) => (
            <>
              {index > 0 ? <ChevronRight size={12} /> : null}
              <button
                type="button"
                onClick={() => props.onNavigate(crumb.path)}
              >
                {crumb.label}
              </button>
            </>
          ))}
        </div>
      )}
    </>
  );
}

namespace styles {
  export const pathInputForm = style({
    selectors: {
      "& input": {
        font: "inherit",
        boxSizing: "border-box",
        height: "23px",
        minHeight: "23px",
        minWidth: "0",
        width: "100%",
        borderWidth: "1px",
        borderColor: theme.borderMedium,
        borderRadius: "6px",
        backgroundColor: "rgb(255 255 255 / 0.74)",
        paddingLeft: "6px",
        paddingRight: "6px",
        color: theme.textPrimary,
        lineHeight: 1.38,
      },
      "& input:focus": {
        outline: "2px solid transparent",
        outlineOffset: "2px",
      },
    },
    minWidth: "0",
  });
  export const crumbs = style({
    selectors: {
      "& button": {
        fontFamily: "inherit",
        boxSizing: "border-box",
        height: "21px",
        maxWidth: "180px",
        minHeight: "21px",
        minWidth: "0",
        display: "inline-flex",
        flex: "0 0 auto",
        cursor: "pointer",
        WebkitAppearance: "none",
        appearance: "none",
        alignItems: "center",
        overflow: "hidden",
        textOverflow: "ellipsis",
        whiteSpace: "nowrap",
        borderColor: "transparent",
        borderRadius: theme.radiusSm,
        backgroundColor: "transparent",
        paddingLeft: "5px",
        paddingRight: "5px",
        fontSize: "12.5px",
        color: theme.textSecondary,
        lineHeight: 1.38,
      },
      "& svg": {
        pointerEvents: "none",
        flex: "0 0 auto",
        color: theme.textTertiary,
      },
      "&::-webkit-scrollbar": {
        display: "none",
      },
      "& button:focus-visible": {
        backgroundColor: "rgb(255 255 255 / 0.42)",
        outline: "2px solid transparent",
        outlineOffset: "2px",
      },
      "& button:hover": {
        backgroundColor: "rgb(255 255 255 / 0.42)",
        color: theme.textPrimary,
      },
    },
    scrollbarWidth: "none",
    boxSizing: "border-box",
    minWidth: "0",
    height: "23px",
    minHeight: "23px",
    width: "100%",
    display: "flex",
    cursor: "text",
    alignItems: "center",
    gap: "1px",
    overflowX: "auto",
    overflowY: "hidden",
    overscrollBehaviorX: "contain",
    lineHeight: 1.38,
  });
}
