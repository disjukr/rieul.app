import React, { FormEvent, useEffect, useRef, useState } from "react";
import { ChevronRight } from "lucide-react";
import { pathCrumbs } from "../../../../../state/explorer.ts";

interface PathCrumbsProps {
  path?: string;
  onNavigate: (path?: string) => void;
}

const pathInputFormClassName = [
  "min-w-0",
  "[&_input]:w-full [&_input]:h-[26px] [&_input]:min-h-[26px] [&_input]:px-[8px]",
].join(" ");
const crumbsClassName = [
  "flex items-center gap-[4px] w-full min-h-[26px] min-w-0",
  "overflow-x-auto overflow-y-hidden overscroll-x-contain [scrollbar-width:thin] cursor-text",
  "[&::-webkit-scrollbar]:h-[6px]",
  "[&::-webkit-scrollbar-thumb]:rounded-full",
  "[&::-webkit-scrollbar-thumb]:bg-[#c6cfdb]",
  "[&_svg]:flex-[0_0_auto]",
  "[&_button]:flex-[0_0_auto] [&_button]:min-w-0 [&_button]:max-w-[180px]",
  "[&_button]:min-h-[24px] [&_button]:overflow-hidden",
  "[&_button]:border-transparent [&_button]:bg-transparent [&_button]:px-[7px]",
  "[&_button]:text-ellipsis [&_button]:whitespace-nowrap",
].join(" ");

export function PathCrumbs(
  { path, onNavigate }: PathCrumbsProps,
) {
  const [editing, setEditing] = useState(false);
  const [draftPath, setDraftPath] = useState(path ?? "");
  const inputRef = useRef<HTMLInputElement>(null);
  const crumbsRef = useRef<HTMLDivElement>(null);
  const crumbs = pathCrumbs(path);

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

  function beginEditing() {
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
          {index > 0 ? <ChevronRight size={14} /> : null}
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
