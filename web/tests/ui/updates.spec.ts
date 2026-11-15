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
  await expect(
    page.getByRole("button", { name: "Check for updates", exact: true }),
  ).toBeDisabled();
  await expect(
    page.getByRole("button", { name: "Install update…", exact: true }),
  ).toBeDisabled();
  await expect(page.getByText(/^Update target:/)).toBeVisible();
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

test("update details stay inside the daemon version cell at wide and narrow sizes", async ({
  page,
}, testInfo) => {
  for (const width of [1440, 390, 320]) {
    await page.setViewportSize({ width, height: 900 });
    await page.goto("/tests/fixtures/updates.html");
    const row = page
      .locator("dl > div")
      .filter({ has: page.locator("dt", { hasText: "Daemon version" }) });
    await expect(row.locator("dd > code")).toHaveText("0.6.13");
    await expect(
      row.locator("dd").getByRole("region", { name: "Daemon updates" }),
    ).toHaveCount(1);
    const install = row.getByRole("button", {
      name: "Install update…",
      exact: true,
    });
    await install.focus();
    await expect(install).toBeFocused();
    await install.hover();
    await page.keyboard.press("Enter");
    const dialog = row.getByRole("alertdialog", {
      name: "Confirm server update",
    });
    await expect(dialog).toBeVisible();
    await expect(
      dialog.getByRole("button", { name: "Confirm and install", exact: true }),
    ).toBeEnabled();
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= window.innerWidth,
      ),
    ).toBe(true);
    for (const button of await row.getByRole("button").all()) {
      const box = await button.boundingBox();
      expect(box).not.toBeNull();
      expect(box!.x).toBeGreaterThanOrEqual(0);
      expect(box!.x + box!.width).toBeLessThanOrEqual(width);
    }
    await page.screenshot({
      path: testInfo.outputPath(`daemon-version-${width}.png`),
      fullPage: true,
    });
    await dialog.getByRole("button", { name: "Cancel", exact: true }).click();
    await expect(dialog).toHaveCount(0);
    await expect(page.getByLabel("Install calls")).toHaveText("0");
  }
});

test("version cell preserves error feedback and unavailable update gating", async ({
  page,
}) => {
  await page.goto("/tests/fixtures/updates.html");
  const region = page.getByRole("region", { name: "Daemon updates" });
  await page
    .getByRole("button", { name: "Fail update request", exact: true })
    .click();
  await expect(region.getByRole("alert")).toHaveText(
    "Update request failed. Try again.",
  );
  await page
    .getByRole("button", { name: "Unavailable updates", exact: true })
    .click();
  await expect(region.getByRole("button")).toHaveCount(0);
  await page
    .getByRole("button", { name: "Unsupported updates", exact: true })
    .click();
  await expect(region.getByRole("status")).toHaveText(
    "This daemon does not support update management.",
  );
  await expect(region.getByRole("button")).toHaveCount(0);
  await expect(page.getByLabel("Install calls")).toHaveText("0");
});
