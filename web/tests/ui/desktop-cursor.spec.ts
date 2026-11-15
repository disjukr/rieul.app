import { expect, test } from "@playwright/test";

for (const deviceScaleFactor of [1, 2]) {
  test.describe(`remote cursor at client DPR ${deviceScaleFactor}`, () => {
    test.use({ deviceScaleFactor });
    for (const spatial of [false, true]) {
      test(`bounds enlarged I-beams and retains smaller cursors on ${spatial ? "large" : "small"} source displays`, async ({
        page,
      }) => {
        await page.setViewportSize({ width: 1000, height: 700 });
        await page.goto(
          `/tests/fixtures/desktop.html?cursor${spatial ? "&spatial" : ""}`,
        );
        await page
          .getByRole("button", { name: "Display fixture", exact: false })
          .click();
        const canvas = page.getByLabel("Display fixture", { exact: true });
        const cursor = page.locator(".rieul-desktop-cursor");
        const img = cursor.locator("img");
        const verify = async (
          width: number,
          height: number,
          hotspotX: number,
          hotspotY: number,
        ) => {
          await expect(img).toBeVisible();
          await expect
            .poll(() =>
              img.evaluate((image: HTMLImageElement) => image.naturalHeight),
            )
            .toBe(height);
          await expect
            .poll(async () => {
              const box = (await canvas.boundingBox())!;
              const source = await canvas.evaluate(
                (element: HTMLCanvasElement) => ({
                  width: element.width,
                  height: element.height,
                }),
              );
              const scale = Math.min(
                box.width / source.width,
                box.height / source.height,
                32 / width,
                32 / height,
              );
              const cursorBox = (await img.boundingBox())!;
              return Math.max(
                Math.abs(cursorBox.width - width * scale),
                Math.abs(cursorBox.height - height * scale),
                Math.abs(
                  cursorBox.x + hotspotX * scale - (box.x + box.width / 2),
                ),
                Math.abs(
                  cursorBox.y + hotspotY * scale - (box.y + box.height / 2),
                ),
              );
            })
            .toBeLessThan(0.25);
        };
        await verify(8, 80, 4, 40);
        await page.getByRole("button", { name: "Change cursor shape" }).click();
        await verify(24, 24, 3, 2);
        await page.setViewportSize({ width: 390, height: 700 });
        await verify(24, 24, 3, 2);
        await page.getByRole("button", { name: "Change cursor shape" }).click();
        await verify(8, 80, 4, 40);
        await page
          .getByRole("button", { name: "Control screen", exact: true })
          .click();
        await verify(8, 80, 4, 40);
        await page.getByRole("button", { name: "Back to displays" }).click();
        await expect(cursor).toHaveCount(0);
        await page
          .getByRole("button", { name: "Display fixture", exact: false })
          .click();
        await verify(8, 80, 4, 40);
      });
    }
  });
}
