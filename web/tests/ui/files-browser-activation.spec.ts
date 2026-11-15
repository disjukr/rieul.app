import { expect, test } from "@playwright/test";

const fixture = "/tests/fixtures/files-browser.html";
const folderName = "nested-folder-with-a-long-name";
const textName = "a-very-long-synthetic-filename-for-mobile-layout.txt";

test("selecting keeps the directory, and opening a file activates its viewer", async ({
  page,
}) => {
  await page.goto(fixture);
  const grid = page.getByRole("grid", { name: "Files", exact: true });
  const file = grid.getByRole("row").filter({ hasText: textName });
  const folder = grid.getByRole("row").filter({ hasText: folderName });
  const homeTab = page.getByRole("tab", {
    name: "another-long-directory",
    exact: true,
  });
  await expect(homeTab).toHaveAttribute("aria-selected", "true");

  await folder.dblclick();
  await expect(
    page.getByRole("tab", { name: folderName, exact: true }),
  ).toHaveAttribute("aria-selected", "true");
  await expect(page.getByRole("tab")).toHaveCount(1);
  await expect(grid).toBeVisible();
  await page.getByRole("button", { name: "Back", exact: true }).click();

  await file.click();
  await expect(file).toHaveAttribute("aria-selected", "true");
  await expect(homeTab).toHaveAttribute("aria-selected", "true");
  await expect(page.getByRole("combobox", { name: "File viewer" })).toHaveCount(
    0,
  );

  await file.dblclick();
  await expect(page.getByRole("combobox", { name: "File viewer" })).toHaveValue(
    "text",
  );
  await expect(
    page.getByText("Synthetic file contents", { exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole("tab", { name: textName, exact: true }),
  ).toHaveAttribute("aria-selected", "true");
  await expect(grid).toHaveCount(0);
  await expect(page.getByRole("tab")).toHaveCount(2);

  await homeTab.click();
  await expect(grid).toBeVisible();
  await expect(file).toHaveAttribute("aria-selected", "true");
});

for (const [filename, viewer] of [
  ["fixture.png", "image"],
  ["binary.bin", "hex"],
] as const) {
  test(`Enter opens ${filename} in the ${viewer} viewer and reload keeps it open`, async ({
    page,
  }) => {
    await page.goto(fixture);
    const file = page.getByRole("row").filter({ hasText: filename });
    await file.press("Enter");
    const control = page.getByRole("combobox", { name: "File viewer" });
    await expect(control).toHaveValue(viewer);
    if (viewer === "image") {
      const image = page.locator("img");
      await expect(image).toBeVisible();
      await expect
        .poll(() =>
          image.evaluate((element: HTMLImageElement) => element.naturalWidth),
        )
        .toBe(1);
    }
    await page.reload();
    await expect(control).toHaveValue(viewer);
    await expect(
      page.getByRole("tab", { name: filename, exact: true }),
    ).toHaveAttribute("aria-selected", "true");
  });
}
