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
const pathInputFormClassName = [
  "min-w-0",
  "[&_input]:w-full [&_input]:h-[23px] [&_input]:min-h-[23px]",
  "[&_input]:min-w-0 [&_input]:box-border [&_input]:border [&_input]:border-rieul-border-medium",
  "[&_input]:rounded-[6px] [&_input]:bg-white/74 [&_input]:px-[6px] [&_input]:text-rieul-text",
  "[&_input]:[font:inherit] [&_input]:leading-[1.38]",
  "[&_input:focus]:outline-none",
].join(" ");
const crumbsClassName = [
  "flex items-center gap-[1px] w-full h-[23px] min-h-[23px] min-w-0",
  "box-border leading-[1.38]",
  "overflow-x-auto overflow-y-hidden overscroll-x-contain [scrollbar-width:none] cursor-text",
  "[&::-webkit-scrollbar]:hidden",
  "[&_svg]:flex-[0_0_auto] [&_svg]:pointer-events-none [&_svg]:text-rieul-text-3",
  "[&_button]:inline-flex [&_button]:appearance-none [&_button]:cursor-pointer",
  "[&_button]:items-center [&_button]:flex-[0_0_auto] [&_button]:[font-family:inherit]",
  "[&_button]:min-w-0 [&_button]:max-w-[180px]",
  "[&_button]:h-[21px] [&_button]:min-h-[21px] [&_button]:overflow-hidden [&_button]:leading-[1.38]",
  "[&_button]:box-border [&_button]:rounded-rieul-sm [&_button]:border-transparent [&_button]:bg-transparent",
  "[&_button]:px-[5px] [&_button]:text-[12.5px] [&_button]:text-rieul-text-2",
  "[&_button:hover]:bg-white/42 [&_button:hover]:text-rieul-text",
  "[&_button:focus-visible]:bg-white/42 [&_button:focus-visible]:outline-none",
  "[&_button]:text-ellipsis [&_button]:whitespace-nowrap",
].join(" ");
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
        <form class={pathInputFormClassName} onSubmit={submitPath}>
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
          class={crumbsClassName}
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
