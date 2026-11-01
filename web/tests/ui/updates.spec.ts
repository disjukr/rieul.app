import { test, expect } from "@playwright/test";
test("daemon update menu displays deferral and requires explicit confirmation", async ({
  page,
}) => {
  await page.goto("/tests/fixtures/updates.html");
  await expect(
    page.getByRole("region", { name: "Daemon updates" }).getByRole("status"),
  ).toHaveText("Waiting");
  await expect(
    page.getByText("Connected clients postpone automatic installation."),
  ).toBeVisible();
  await page
    .getByRole("button", { name: "Install update…", exact: true })
    .click();
  await expect(page.getByRole("alertdialog")).toContainText(
    "disconnects all clients",
  );
  await expect(page.getByRole("alertdialog")).toContainText(
    "will not be forcibly terminated",
  );
  await expect(page.getByLabel("Install calls")).toHaveText("0");
  await page.getByRole("button", { name: "Cancel", exact: true }).click();
  await expect(page.getByRole("alertdialog")).toHaveCount(0);
  await page
    .getByRole("button", { name: "Install update…", exact: true })
    .click();
  await page
    .getByRole("button", { name: "Confirm and install", exact: true })
    .click();
  await expect(
    page.getByRole("region", { name: "Daemon updates" }).getByRole("status"),
  ).toHaveText("Installing");
  await expect(page.getByLabel("Install calls")).toHaveText("1");
});
test("replacement daemon invalidates the displayed installation confirmation", async ({
  page,
}) => {
  await page.goto("/tests/fixtures/updates.html");
  await page
    .getByRole("button", { name: "Install update…", exact: true })
    .click();
  await page
    .getByRole("button", { name: "Replace daemon", exact: true })
    .click();
  await expect(page.getByRole("alertdialog")).toHaveCount(0);
  await expect(page.getByLabel("Install calls")).toHaveText("0");
});
