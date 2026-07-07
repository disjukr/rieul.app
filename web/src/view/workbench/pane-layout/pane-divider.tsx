import type { DividerRenderProps } from "panecake";
import { className } from "../../class-name.ts";

const paneDividerClassName = [
  "relative z-[2] bg-[var(--wgo-border-light)]",
  "hover:bg-[var(--wgo-accent)] focus-visible:bg-[var(--wgo-accent)] focus-visible:outline-0",
].join(" ");

export function PaneDivider(
  { direction, onMouseDown, onKeyDown, ref }: DividerRenderProps,
) {
  return (
    <div
      ref={ref}
      className={className(
        paneDividerClassName,
        direction === "horizontal"
          ? "w-[1px] cursor-col-resize"
          : "h-[1px] cursor-row-resize",
      )}
      role="separator"
      tabIndex={0}
      onMouseDown={onMouseDown}
      onKeyDown={onKeyDown}
    />
  );
}
