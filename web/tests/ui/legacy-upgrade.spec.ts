import { test, expect } from "@playwright/test";
test("legacy upgrade requires version read and explicit install; new connection hides it", async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/tests/fixtures/legacy-upgrade.html");
  await expect(
    page.getByRole("region", { name: "Legacy daemon upgrade" }),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Check for updates", exact: true }),
  ).toBeDisabled();
  await expect(
    page.getByRole("button", { name: "Install update…", exact: true }),
  ).toBeDisabled();
  const read = page.getByRole("button", {
    name: "Read update status",
    exact: true,
  });
  await read.focus();
  await expect(read).toBeFocused();
  await read.hover();
  await read.click();
  await expect(page.getByText("Installed: 0.6.16")).toBeVisible();
  await page
    .getByRole("button", { name: "Check for updates", exact: true })
    .click();
  await expect(page.getByRole("alert")).toContainText("Read update status");
  await page
    .getByRole("button", { name: "Install update…", exact: true })
    .click();
  await expect(page.getByRole("alertdialog")).toContainText(
    "will not be forcibly terminated",
  );
  await expect(page.getByLabel("Legacy install calls")).toHaveText("0");
  await page
    .getByRole("button", { name: "Confirm and install", exact: true })
    .click();
  await expect(page.getByLabel("Legacy install calls")).toHaveText("1");
  await expect(
    page.getByText("Active work postpones installation."),
  ).toBeVisible();
  await page
    .getByRole("button", { name: "Install update…", exact: true })
    .click();
  await page.getByRole("button", { name: "Reconnect", exact: true }).click();
  await expect(
    page.getByRole("region", { name: "Legacy daemon upgrade" }),
  ).toHaveCount(0);
  await expect(page.getByRole("alertdialog")).toHaveCount(0);
  await expect(page.getByText("Installed: 0.6.20")).toBeVisible();
});
test("legacy failed request invalidates confirmation and leaves status retry available", async ({
  page,
}) => {
  await page.goto("/tests/fixtures/legacy-upgrade.html");
  await page
    .getByRole("button", { name: "Read update status", exact: true })
    .click();
  await page
    .getByRole("button", { name: "Install update…", exact: true })
    .click();
  await page.getByRole("button", { name: "Simulate failure" }).click();
  await expect(page.getByRole("alertdialog")).toHaveCount(0);
  await expect(page.getByRole("alert")).toContainText("failed");
  await expect(
    page.getByRole("button", { name: "Install update…", exact: true }),
  ).toBeDisabled();
  await expect(
    page.getByRole("button", { name: "Read update status", exact: true }),
  ).toBeEnabled();
  await expect(page.getByLabel("Legacy install calls")).toHaveText("0");
});
