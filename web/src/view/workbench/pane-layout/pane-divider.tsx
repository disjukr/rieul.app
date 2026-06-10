import type { DividerRenderProps } from "panecake";

export function PaneDivider(
  { direction, onMouseDown, onKeyDown, ref }: DividerRenderProps,
) {
  return (
    <div
      ref={ref}
      className={`pane-divider ${direction}`}
      role="separator"
      tabIndex={0}
      onMouseDown={onMouseDown}
      onKeyDown={onKeyDown}
    />
  );
}
