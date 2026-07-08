import React, { FormEvent, useEffect, useRef, useState } from "react";
import { ChevronRight } from "lucide-react";
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
  "[&_input]:min-w-0 [&_input]:box-border [&_input]:border [&_input]:border-wgo-border-medium",
  "[&_input]:rounded-[6px] [&_input]:bg-white/74 [&_input]:px-[6px] [&_input]:text-wgo-text",
  "[&_input]:[font:inherit] [&_input]:leading-[1.38]",
  "[&_input:focus]:outline-none",
].join(" ");
const crumbsClassName = [
  "flex items-center gap-[1px] w-full h-[23px] min-h-[23px] min-w-0",
  "box-border leading-[1.38]",
  "overflow-x-auto overflow-y-hidden overscroll-x-contain [scrollbar-width:none] cursor-text",
  "[&::-webkit-scrollbar]:hidden",
  "[&_svg]:flex-[0_0_auto] [&_svg]:pointer-events-none [&_svg]:text-wgo-text-3",
  "[&_button]:inline-flex [&_button]:appearance-none [&_button]:cursor-pointer",
  "[&_button]:items-center [&_button]:flex-[0_0_auto] [&_button]:[font-family:inherit]",
  "[&_button]:min-w-0 [&_button]:max-w-[180px]",
  "[&_button]:h-[21px] [&_button]:min-h-[21px] [&_button]:overflow-hidden [&_button]:leading-[1.38]",
  "[&_button]:box-border [&_button]:rounded-wgo-sm [&_button]:border-transparent [&_button]:bg-transparent",
  "[&_button]:px-[5px] [&_button]:text-[12.5px] [&_button]:text-wgo-text-2",
  "[&_button:hover]:bg-white/42 [&_button:hover]:text-wgo-text",
  "[&_button:focus-visible]:bg-white/42 [&_button:focus-visible]:outline-none",
  "[&_button]:text-ellipsis [&_button]:whitespace-nowrap",
].join(" ");

export function PathCrumbs(
  { path, onNavigate }: PathCrumbsProps,
) {
  const [editing, setEditing] = useState(false);
  const [draftPath, setDraftPath] = useState(path ?? "");
  const inputRef = useRef<HTMLInputElement>(null);
  const crumbsRef = useRef<HTMLDivElement>(null);
  const trashLocation = path === trashLocationPath;
  const crumbs = trashLocation
    ? [{ label: "Root" }, { label: "Trash", path: trashLocationPath }]
    : pathCrumbs(path);

  useEffect(() => {
    if (!editing) setDraftPath(path ?? "");
  }, [editing, path]);

  useEffect(() => {
    if (!editing) return;
    inputRef.current?.focus();
    inputRef.current?.select();
  }, [editing]);

  useEffect(() => {
    if (editing) return;
    const element = crumbsRef.current;
    if (!element) return;
    const frame = requestAnimationFrame(() => {
      element.scrollLeft = element.scrollWidth;
    });
    return () => cancelAnimationFrame(frame);
  }, [editing, path]);

  useEffect(() => {
    if (editing) return;
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
  }, [editing]);

  function beginEditing() {
    if (trashLocation) return;
    setDraftPath(path ?? "");
    setEditing(true);
  }

  function cancelEditing() {
    setDraftPath(path ?? "");
    setEditing(false);
  }

  function submitPath(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const nextPath = draftPath.trim();
    setEditing(false);
    onNavigate(nextPath || undefined);
  }

  if (editing) {
    return (
      <form className={pathInputFormClassName} onSubmit={submitPath}>
        <input
          ref={inputRef}
          value={draftPath}
          onChange={(event) => setDraftPath(event.target.value)}
          onBlur={cancelEditing}
          onKeyDown={(event) => {
            if (event.key === "Escape") cancelEditing();
          }}
          aria-label="Path"
          placeholder="Path"
        />
      </form>
    );
  }

  return (
    <div
      ref={crumbsRef}
      className={crumbsClassName}
      aria-label="Path"
      onMouseDown={(event) => {
        if (event.target !== event.currentTarget) return;
        event.preventDefault();
        beginEditing();
      }}
    >
      {crumbs.map((crumb, index) => (
        <React.Fragment key={`${crumb.path ?? "roots"}:${index}`}>
          {index > 0 ? <ChevronRight size={12} /> : null}
          <button
            type="button"
            onClick={() =>
              onNavigate(crumb.path)}
          >
            {crumb.label}
          </button>
        </React.Fragment>
      ))}
    </div>
  );
}
