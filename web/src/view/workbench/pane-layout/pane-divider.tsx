import type { DividerRenderProps } from "panecake";
import { className } from "../../class-name.ts";

const paneDividerClassName = [
  "relative z-[5] bg-transparent",
  "before:content-[''] before:absolute before:rounded-full",
  "before:bg-[rgba(108,126,151,0.22)] before:opacity-0 before:rieul-transition",
  "after:content-[''] after:absolute after:rounded-full after:bg-white/38 after:opacity-0 after:rieul-transition",
  "hover:before:opacity-100 hover:after:opacity-92 focus-visible:before:opacity-100 focus-visible:after:opacity-92 focus-visible:outline-0",
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
          ? "w-[8px] cursor-col-resize before:top-[18px] before:bottom-[18px] before:left-[3px] before:w-[2px] after:top-[42%] after:left-[2px] after:h-[16%] after:w-[4px]"
          : "h-[8px] cursor-row-resize before:left-[18px] before:right-[18px] before:top-[3px] before:h-[2px] after:left-[42%] after:top-[2px] after:h-[4px] after:w-[16%]",
      )}
      role="separator"
      tabIndex={0}
      onMouseDown={onMouseDown}
      onKeyDown={onKeyDown}
    />
  );
}
