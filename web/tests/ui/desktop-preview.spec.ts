import { expect, test } from "@playwright/test";
for (const portrait of [false, true]) {
  test(`catalog ${portrait ? "portrait" : "landscape"} previews contain synthetic pixels without input controls`, async ({
    page,
  }) => {
    await page.setViewportSize({ width: 390, height: 700 });
    await page.goto(
      `/tests/fixtures/desktop.html${portrait ? "?portrait" : ""}`,
    );
    const tiles = page.getByRole("navigation", { name: "Displays" });
    const preview = tiles.locator("canvas").first();
    await expect(tiles.locator("canvas")).toHaveCount(2);
    expect((await preview.boundingBox())!.height).toBeLessThanOrEqual(180);
    await expect(page.getByLabel("Preview subscriptions")).toHaveText("2");
    expect(
      await preview.evaluate((canvas: HTMLCanvasElement) => ({
        fit: getComputedStyle(canvas).objectFit,
        width: canvas.width,
        height: canvas.height,
        blue: [
          ...canvas
            .getContext("2d")!
            .getImageData(canvas.width / 2, canvas.height / 2, 1, 1).data,
        ],
      })),
    ).toEqual({
      fit: "contain",
      width: portrait ? 100 : 320,
      height: 180,
      blue: [35, 103, 209, 255],
    });
    await expect(page.getByRole("button", { name: /control/i })).toHaveCount(0);
    await expect(page.getByLabel("Recorded input")).toHaveText("[]");
    await preview.dispatchEvent("contextlost");
    await expect(page.getByLabel("Preview subscriptions")).toHaveText("1");
    await preview.dispatchEvent("contextrestored");
    await expect(page.getByLabel("Preview subscriptions")).toHaveText("2");
    await page
      .getByRole("button", { name: "Display fixture", exact: true })
      .click();
    await expect(
      page.locator('canvas[aria-label="Display fixture"]'),
    ).toBeVisible();
    await expect(page.getByLabel("Preview subscriptions")).toHaveText("0");
    await expect(page.getByLabel("Recorded input")).toHaveText("[]");
    await page.getByRole("button", { name: "Back to displays" }).click();
    await expect(page.getByLabel("Preview subscriptions")).toHaveText("2");
    await page.getByRole("button", { name: "Hide Screen tab" }).click();
    await expect(page.getByLabel("Preview subscriptions")).toHaveText("0");
    await page.getByRole("button", { name: "Show Screen tab" }).click();
    await expect(page.getByLabel("Preview subscriptions")).toHaveText("2");
  });
}
