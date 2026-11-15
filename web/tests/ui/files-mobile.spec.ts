import { expect, test } from "@playwright/test";

for (const width of [320, 375, 390, 600, 1280]) {
  test(`Files keeps desktop columns and local scrolling at ${width}px`, async ({
    page,
  }) => {
    await page.setViewportSize({ width, height: 240 });
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(error.message));
    await page.goto("/tests/fixtures/files-browser.html");
    const table = page.getByRole("grid", { name: "Files", exact: true });
    await expect(table.getByRole("row")).toHaveCount(4);
    await expect(table.getByRole("columnheader")).toHaveText([
      "Name",
      "Kind",
      "Size",
      "Modified",
    ]);
    for (const header of await table.getByRole("columnheader").all())
      await expect(header).toBeVisible();
    const row = table.getByRole("row").filter({
      hasText: "a-very-long-synthetic-filename-for-mobile-layout.txt",
    });
    const geometry = await table.evaluate((element) => {
      const row = element.querySelector('[role="row"]')!;
      return {
        client: element.clientWidth,
        scroll: element.scrollWidth,
        rowHeight: row.getBoundingClientRect().height,
        page: document.documentElement.scrollWidth,
        viewport: innerWidth,
      };
    });
    expect(geometry.page).toBe(geometry.viewport);
    expect(geometry.rowHeight).toBe(25);
    if (width < 500) expect(geometry.scroll).toBeGreaterThan(geometry.client);
    await row.locator(".name").click();
    await expect(row).toHaveAttribute("aria-selected", "true");
    const before = await table.locator(".modified").first().boundingBox();
    await table.evaluate((element) => {
      element.scrollLeft = element.scrollWidth;
    });
    const after = await table.locator(".modified").first().boundingBox();
    const bounds = (await table.boundingBox())!;
    expect(after!.x + after!.width).toBeLessThanOrEqual(
      bounds.x + bounds.width + 1,
    );
    expect(after!.x).toBeGreaterThanOrEqual(bounds.x);
    if (geometry.scroll > geometry.client)
      expect(after!.x).toBeLessThan(before!.x);
    const alignment = await row.evaluate((element) => {
      const table = element.closest('[role="grid"]')!;
      return ["kind", "size", "modified"].map((name) => {
        const header = table
          .querySelector(`.file-head.${name}`)!
          .getBoundingClientRect();
        const cell = element.querySelector(`.${name}`)!.getBoundingClientRect();
        return Math.abs(header.x - cell.x);
      });
    });
    expect(alignment.every((difference) => difference < 1)).toBe(true);
    const stickyTop = after!.y;
    await table.evaluate((element) => {
      element.scrollTop = element.scrollHeight;
    });
    expect(
      (await table.locator(".modified").first().boundingBox())!.y,
    ).toBeCloseTo(stickyTop, 0);
    expect(
      await table.evaluate((element) => element.scrollTop),
    ).toBeGreaterThan(0);
    await expect(row.locator(".modified")).not.toHaveText("");
    expect(errors).toEqual([]);
  });
}

test("Files columns stay present while resizing the pane", async ({ page }) => {
  await page.goto("/tests/fixtures/files-browser.html");
  const table = page.getByRole("grid", { name: "Files", exact: true });
  for (const width of [1280, 375, 1280]) {
    await page.setViewportSize({ width, height: 812 });
    await expect(table.getByRole("columnheader")).toHaveText([
      "Name",
      "Kind",
      "Size",
      "Modified",
    ]);
    for (const header of await table.getByRole("columnheader").all())
      await expect(header).toBeVisible();
    expect(
      await page.evaluate(() => document.documentElement.scrollWidth),
    ).toBe(width);
    await expect(table.getByRole("row")).toHaveCount(4);
  }
});
