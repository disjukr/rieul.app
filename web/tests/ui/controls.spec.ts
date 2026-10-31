import { expect, test } from "@playwright/test";
test("modal traps keyboard focus and Escape restores its opener", async ({
  page,
}) => {
  await page.goto("/tests/fixtures/controls.html");
  const opener = page.getByRole("button", { name: "Open dialog", exact: true });
  await opener.click();
  const dialog = page.getByRole("dialog", {
    name: "Fixture dialog",
    exact: true,
  });
  await expect(dialog).toBeVisible();
  await page
    .getByRole("button", { name: "Last dialog button", exact: true })
    .focus();
  await page.keyboard.press("Tab");
  await expect
    .poll(() => dialog.evaluate((el) => el.contains(document.activeElement)))
    .toBe(true);
  await page.keyboard.press("Shift+Tab");
  await expect
    .poll(() => dialog.evaluate((el) => el.contains(document.activeElement)))
    .toBe(true);
  await page.keyboard.press("Escape");
  await expect(dialog).toHaveCount(0);
  await expect(opener).toBeFocused();
});
test("menu keyboard navigation skips disabled items and restores focus", async ({
  page,
}) => {
  await page.goto("/tests/fixtures/controls.html");
  const opener = page.getByRole("button", { name: "Open menu", exact: true });
  await opener.click();
  await expect(
    page.getByRole("menuitem", { name: "Alpha", exact: true }),
  ).toBeFocused();
  await page.keyboard.press("ArrowDown");
  await expect(
    page.getByRole("menuitem", { name: "Beta", exact: true }),
  ).toBeFocused();
  await page.keyboard.press("Home");
  await expect(
    page.getByRole("menuitem", { name: "Alpha", exact: true }),
  ).toBeFocused();
  await page.keyboard.press("End");
  await page.keyboard.press("Enter");
  await expect(page.getByLabel("action", { exact: true })).toHaveText("Beta");
  await expect(opener).toBeFocused();
  await opener.click();
  await page.keyboard.press("Escape");
  await expect(page.getByRole("menu")).toHaveCount(0);
  await expect(opener).toBeFocused();
});
test("file rename keeps one focused input while typing and path editor submits its current draft", async ({
  page,
}) => {
  await page.goto("/tests/fixtures/controls.html");
  await page.getByRole("button", { name: "Rename file", exact: true }).click();
  const rename = page.getByRole("grid", { name: "Files" }).getByRole("textbox");
  await expect(rename).toBeFocused();
  await rename.fill("renamed.txt");
  await expect(rename).toBeFocused();
  await rename.press("End");
  await rename.pressSequentially("2");
  await expect(rename).toHaveValue("renamed.txt2");
  await rename.press("Enter");
  await expect(page.getByLabel("action", { exact: true })).toHaveText(
    "renamed.txt2",
  );
  await page.locator('div[aria-label="Path"]').dispatchEvent("mousedown");
  const path = page.getByRole("textbox", { name: "Path", exact: true });
  await expect(path).toBeFocused();
  await path.fill("/next/folder");
  await path.press("Enter");
  await expect(page.getByLabel("current path", { exact: true })).toHaveText(
    "/next/folder",
  );
});
