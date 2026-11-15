import { test } from "node:test";
import assert from "node:assert/strict";
import {
  desktopArrangement,
  fitDesktopArrangement,
} from "../src/protocol/desktop-arrangement.ts";
import type { DesktopDisplay } from "../src/protocol/generated/rpc.ts";
function display(
  displayId: string,
  x: number,
  y: number,
  width: number,
  height: number,
  scale = 1,
): DesktopDisplay {
  return { displayId, bounds: { x, y, width, height }, scale, dpi: 96 * scale };
}
test("exact host layout preserves mixed DPI, negative origins and portrait offsets", () => {
  const retina = display("retina", 0, 0, 3840, 2160, 2);
  retina.arrangementBounds = { x: 0, y: 0, width: 1920, height: 1080 };
  const portrait = display("portrait", -1080, -400, 1080, 1920);
  portrait.arrangementBounds = portrait.bounds;
  const layout = desktopArrangement([retina, portrait]);
  assert.equal(layout.width, 3000);
  assert.equal(layout.height, 1920);
  assert.deepEqual(
    layout.tiles.map(({ x, y, width, height }) => ({ x, y, width, height })),
    [
      { x: 1080, y: 400, width: 1920, height: 1080 },
      { x: 0, y: 0, width: 1080, height: 1920 },
    ],
  );
  assert.equal(layout.overlapping, false);
  for (const [width, height] of [
    [180, 120],
    [1000, 700],
    [50, 50],
  ]) {
    const fit = fitDesktopArrangement(layout, width, height);
    for (const tile of layout.tiles) {
      assert.ok(fit.left + tile.x * fit.scale >= 0);
      assert.ok(fit.top + tile.y * fit.scale >= 0);
      assert.ok(fit.left + (tile.x + tile.width) * fit.scale <= width);
      assert.ok(fit.top + (tile.y + tile.height) * fit.scale <= height);
      assert.ok(
        Math.abs(
          (tile.width * fit.scale) / (tile.height * fit.scale) -
            tile.width / tile.height,
        ) < 1e-12,
      );
    }
  }
});
test("legacy mac uses point dimensions but leaves origins alone; Windows never divides pixels", () => {
  const displays = [
    display("a", -1920, 100, 3840, 2160, 2),
    display("b", 0, 0, 1920, 1080),
  ];
  assert.equal(desktopArrangement(displays, "macOS Sequoia").width, 3840);
  assert.equal(
    desktopArrangement(displays, "macOS Sequoia").tiles[0].width,
    1920,
  );
  assert.equal(desktopArrangement(displays, "Windows 11").tiles[0].width, 3840);
  assert.equal(desktopArrangement(displays).tiles[0].width, 3840);
});
test("single off-origin monitor is centered, mirroring retained and invalid metadata bounded", () => {
  const layout = desktopArrangement([display("a", 200, 300, 100, 200)]);
  assert.deepEqual(
    [layout.width, layout.height, layout.tiles[0].x, layout.tiles[0].y],
    [100, 200, 0, 0],
  );
  assert.equal(
    desktopArrangement([
      display("a", 0, 0, 100, 100),
      display("b", 0, 0, 100, 100),
    ]).overlapping,
    true,
  );
  const bad = display("bad", NaN, Infinity, 0, 0, 0);
  bad.arrangementBounds = { x: 0, y: 0, width: Infinity, height: 1 };
  const invalid = desktopArrangement([bad], "macOS Sequoia");
  assert.equal(invalid.width, 16);
  assert.ok(Number.isFinite(fitDesktopArrangement(invalid, 180, 120).scale));
  assert.equal(fitDesktopArrangement(desktopArrangement([]), 0, 0).scale, 0);
});
