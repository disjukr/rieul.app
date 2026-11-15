import type { DesktopDisplay } from "./generated/rpc.ts";

type Rect = { x: number; y: number; width: number; height: number };
function valid(rect: Rect): boolean {
  return (
    Object.values(rect).every(
      (value) =>
        Number.isFinite(value) && Math.abs(value) <= Number.MAX_SAFE_INTEGER,
    ) &&
    rect.width > 0 &&
    rect.height > 0
  );
}

/** Catalog-only coordinates. Never use these for capture or pointer input. */
export function desktopArrangement(
  displays: DesktopDisplay[],
  hostOs?: string,
) {
  const rects = displays.map((display) => {
    if (display.arrangementBounds && valid(display.arrangementBounds))
      return display.arrangementBounds;
    const scale =
      hostOs?.startsWith("macOS ") &&
      Number.isFinite(display.scale) &&
      display.scale > 0
        ? display.scale
        : 1;
    const rect = {
      ...display.bounds,
      width: display.bounds.width / scale,
      height: display.bounds.height / scale,
    };
    // A broken metadata entry must not poison the union or hide every display.
    return valid(rect) ? rect : { x: 0, y: 0, width: 16, height: 9 };
  });
  // Normalize the actual union, not a union including a phantom origin display.
  const x = rects.length ? Math.min(...rects.map((r) => r.x)) : 0;
  const y = rects.length ? Math.min(...rects.map((r) => r.y)) : 0;
  const width = Math.max(1, ...rects.map((r) => r.x + r.width - x));
  const height = Math.max(1, ...rects.map((r) => r.y + r.height - y));
  return {
    width,
    height,
    tiles: displays.map((display, i) => ({
      display,
      ...rects[i],
      x: rects[i].x - x,
      y: rects[i].y - y,
    })),
    overlapping: rects.some((a, i) =>
      rects
        .slice(i + 1)
        .some(
          (b) =>
            a.x < b.x + b.width &&
            b.x < a.x + a.width &&
            a.y < b.y + b.height &&
            b.y < a.y + a.height,
        ),
    ),
  };
}

export function fitDesktopArrangement(
  layout: ReturnType<typeof desktopArrangement>,
  width: number,
  height: number,
) {
  const scale = Math.max(
    0,
    Math.min(
      Math.max(0, width) / layout.width,
      Math.max(0, height) / layout.height,
    ),
  );
  return {
    scale,
    left: (width - layout.width * scale) / 2,
    top: (height - layout.height * scale) / 2,
  };
}
