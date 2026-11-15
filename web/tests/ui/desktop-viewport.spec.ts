import { expect, test } from "@playwright/test";
import type { DesktopInputEvent } from "../../src/protocol/generated/rpc.ts";
for (const portrait of [false, true]) {
  for (const height of [220, 700]) {
    test(`contained ${portrait ? "portrait" : "landscape"} screen rejects bars and releases exiting drags at height ${height}`, async ({
      page,
    }) => {
      await page.setViewportSize({ width: 390, height });
      await page.goto(
        `/tests/fixtures/desktop.html${portrait ? "?portrait" : ""}`,
      );
      await page
        .getByRole("button", { name: "Display fixture", exact: false })
        .click();
      const screen = page.getByRole("region", { name: "Screen", exact: true });
      const canvas = page.getByLabel("Display fixture", { exact: true });
      await page
        .getByRole("button", { name: "Control screen", exact: true })
        .click();
      const box = (await canvas.boundingBox())!;
      expect(box.height).toBeGreaterThan(20);
      expect(
        await screen.evaluate(
          (element) =>
            element.scrollHeight <= element.clientHeight &&
            element.scrollWidth <= element.clientWidth,
        ),
      ).toBe(true);
      expect(await screen.locator(":scope > p").count()).toBe(0);
      expect(await screen.locator(":scope > h2").count()).toBe(0);
      const source = await canvas.evaluate((element: HTMLCanvasElement) => ({
        width: element.width,
        height: element.height,
        fit: getComputedStyle(element).objectFit,
      }));
      expect(source.fit).toBe("contain");
      expect(source.width < source.height).toBe(portrait);
      const scale = Math.min(
        box.width / source.width,
        box.height / source.height,
      );
      const imageHeight = source.height * scale;
      const bar =
        box.height - imageHeight > 2
          ? { x: box.x + box.width / 2, y: box.y + 1 }
          : { x: box.x + 1, y: box.y + box.height / 2 };
      await page.mouse.click(bar.x, bar.y);
      await expect(page.getByLabel("Recorded input")).toHaveText("[]");
      await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
      let events: DesktopInputEvent[] = JSON.parse(
        (await page.getByLabel("Recorded input").textContent())!,
      );
      const down = events.find(
        (event) => event.type === "button" && event.down,
      );
      expect(down?.type).toBe("button");
      if (down?.type === "button") {
        expect(down.x).toBeCloseTo(source.width / 2, 0);
        expect(down.y).toBeCloseTo(source.height / 2, 0);
      }
      await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
      await page.mouse.down();
      await page.mouse.move(bar.x, bar.y, { steps: 3 });
      await page.mouse.up();
      events = JSON.parse(
        (await page.getByLabel("Recorded input").textContent())!,
      );
      expect(events.some((event) => event.type === "releaseAll")).toBe(true);
      const before = await canvas.boundingBox();
      await expect(
        page.getByLabel("Screen options", { exact: true }),
      ).toHaveCount(0);
      await expect(
        page.getByRole("combobox", { name: "Maximum video size" }),
      ).toBeVisible();
      expect(await canvas.boundingBox()).toEqual(before);
      expect(
        await screen.evaluate(
          (element) => element.scrollHeight <= element.clientHeight,
        ),
      ).toBe(true);
    });
  }
}
