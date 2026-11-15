import { expect, test } from "@playwright/test";

for (const width of [320, 375, 390, 600, 1280]) {
  test(`Files table fits a ${width}px pane with long names and paths`, async ({
    page,
  }) => {
    await page.setViewportSize({ width, height: 812 });
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(error.message));
    await page.goto("/tests/fixtures/files-browser.html");
    const table = page.getByRole("grid", { name: "Files", exact: true });
    await expect(table.getByRole("row")).toHaveCount(4);
    await expect(
      page.getByRole("button", { name: "Back", exact: true }),
    ).toBeVisible();
    await expect(
      page.getByRole("button", { name: "Up", exact: true }),
    ).toBeVisible();
    expect(
      await table.evaluate(
        (element) => element.scrollWidth - element.clientWidth,
      ),
    ).toBe(0);
    await expect(
      table.getByRole("columnheader", { name: "Name", exact: true }),
    ).toBeVisible();
    if (width < 500) {
      await expect(
        table.getByRole("columnheader", { name: "Kind", exact: true }),
      ).toBeHidden();
      await expect(
        table.getByRole("columnheader", { name: "Size", exact: true }),
      ).toBeHidden();
    } else {
      await expect(
        table.getByRole("columnheader", { name: "Kind", exact: true }),
      ).toBeVisible();
      await expect(
        table.getByRole("columnheader", { name: "Size", exact: true }),
      ).toBeVisible();
    }
    const row = table.getByRole("row").filter({
      hasText: "a-very-long-synthetic-filename-for-mobile-layout.txt",
    });
    await expect(row.locator(".kind")).toBeVisible();
    await expect(row.locator(".size")).toBeVisible();
    if (width < 680)
      await expect(
        table.getByRole("columnheader", { name: "Modified", exact: true }),
      ).toBeHidden();
    await row.click();
    await expect(row).toHaveAttribute("aria-selected", "true");
    await expect(table).toBeVisible();
    expect(errors).toEqual([]);
  });
}

test("Files columns reflow when the pane width changes", async ({ page }) => {
  await page.goto("/tests/fixtures/files-browser.html");
  const table = page.getByRole("grid", { name: "Files", exact: true });
  for (const width of [1280, 375, 1280]) {
    await page.setViewportSize({ width, height: 812 });
    const modified = table.getByRole("columnheader", {
      name: "Modified",
      exact: true,
    });
    if (width < 680) await expect(modified).toBeHidden();
    else await expect(modified).toBeVisible();
    expect(
      await table.evaluate(
        (element) => element.scrollWidth - element.clientWidth,
      ),
    ).toBe(0);
    await expect(table.getByRole("row")).toHaveCount(4);
  }
});
