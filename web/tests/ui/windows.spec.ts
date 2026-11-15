import { test, expect } from "@playwright/test";

test("titleless rows stay inspectable and a lost subscription clears stale window metadata", async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 670 });
  await page.goto("/tests/fixtures/windows.html", { waitUntil: "networkidle" });

  const pidLabel = page.getByText("Untitled window (PID 4125)", {
    exact: true,
  });
  await expect(pidLabel).toBeVisible();
  await expect(
    page.getByText("Untitled window", { exact: true }),
  ).toBeVisible();
  await expect(page.getByText("Fixture editor", { exact: true })).toBeVisible();
  const row = page.getByRole("row").filter({ has: pidLabel });
  await row.hover();
  await expect(row).toHaveCSS("cursor", "pointer");
  await pidLabel.dblclick();
  await expect(page.getByLabel("Tab title")).toHaveText(
    "Untitled window (PID 4125)",
  );
  await expect(page.getByLabel("Cancelled list count")).toHaveText("1");
  const property = (label: string) =>
    page
      .locator("dl > div")
      .filter({ has: page.getByText(label, { exact: true }) })
      .locator("dd");
  await expect(property("Title")).toHaveText("Unknown");
  await expect(property("Focused")).toHaveText("Unknown");
  await expect(property("Visible")).toHaveText("Yes");
  await expect(property("Minimized")).toHaveText("Unknown");
  await expect(property("Maximized")).toHaveText("Unknown");
  await expect(property("X")).toHaveText("-132");

  await page.getByRole("button", { name: "End detail stream" }).click();
  await expect(
    page.getByRole("heading", { name: "Window detail unavailable" }),
  ).toBeVisible();
  await expect(property("X")).toHaveCount(0);
  await expect(page.getByText("Window closed")).toHaveCount(0);

  const rootCrumb = page.getByRole("button", { name: "Windows", exact: true });
  await rootCrumb.focus();
  await expect(rootCrumb).toBeFocused();
  await rootCrumb.press("Enter");
  await pidLabel.dblclick();
  await expect(property("Visible")).toHaveText("Yes");
  await page.getByRole("button", { name: "Remove window" }).click();
  await expect(
    page.getByRole("heading", { name: "Window detail unavailable" }),
  ).toBeVisible();

  await rootCrumb.click();
  await page.getByText("Stale entry", { exact: true }).dblclick();
  await expect(
    page.getByRole("heading", { name: "Window detail unavailable" }),
  ).toBeVisible();
  await rootCrumb.click();
  await expect(pidLabel).toBeVisible();
  await page.getByRole("button", { name: "End list stream" }).click();
  await expect(
    page.getByRole("heading", { name: "Windows unavailable" }),
  ).toBeVisible();
  await expect(pidLabel).toHaveCount(0);
});
