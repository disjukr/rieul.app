import type { DividerRenderProps } from "panecake";
import { className } from "../../class-name.ts";

const paneDividerClassName = [
  "relative z-[2] bg-[#d8dde7]",
  "hover:bg-[#4f8cff] focus-visible:bg-[#4f8cff] focus-visible:outline-0",
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
