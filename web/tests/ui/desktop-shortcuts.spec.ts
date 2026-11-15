import { test, expect } from "@playwright/test";

test("rail shortcuts select a monitor in an internal pane without control, and Screen still opens the catalog", async ({
  page,
  context,
}) => {
  await page.goto("/tests/fixtures/desktop.html?shortcuts");
  await expect(page.getByLabel("Screen lifetimes")).toHaveText(
    JSON.stringify({ starts: 0, stops: 0 }),
  );
  const first = page.getByRole("region", { name: "Pane p1", exact: true });
  await page.getByRole("button", { name: "Screen menu", exact: true }).click();
  await page
    .getByRole("menuitem", { name: "Display second", exact: true })
    .click();
  await expect(
    first.getByLabel("Display second", { exact: true }),
  ).toBeVisible();
  await expect(first.getByRole("navigation", { name: "Displays" })).toHaveCount(
    0,
  );
  await expect(page.getByLabel("Recorded input")).toHaveText("[]");
  await expect(
    first.getByRole("button", { name: "Control screen", exact: true }),
  ).toHaveAttribute("aria-pressed", "false");
  expect(context.pages()).toHaveLength(1);
  expect(page.url()).toContain("/tests/fixtures/desktop.html?shortcuts");
  await page.getByRole("button", { name: "Screen", exact: true }).click();
  await expect(
    first.getByRole("navigation", { name: "Displays" }),
  ).toBeVisible();
  await page.getByRole("button", { name: "Screen menu", exact: true }).click();
  await page
    .getByRole("menuitem", { name: "Display second", exact: true })
    .click();
  await expect(
    first.getByLabel("Display second", { exact: true }),
  ).toBeVisible();
  const panes = JSON.parse(
    (await page.getByLabel("Workbench state").textContent())!,
  );
  expect(
    panes[0].tabs.filter(
      (tab: { desktopDisplayId?: string }) => tab.desktopDisplayId === "second",
    ),
  ).toHaveLength(1);
});

test("Screen menu is opt-in, dismisses on Escape/outside, and hides for one monitor or a different host", async ({
  page,
}) => {
  await page.goto("/tests/fixtures/desktop.html?shortcuts");
  const menu = page.getByRole("button", { name: "Screen menu", exact: true });
  await expect(
    page.getByRole("menuitem", { name: "Display second" }),
  ).toHaveCount(0);
  await menu.focus();
  await menu.press("Enter");
  await expect(
    page.getByRole("menuitem", { name: "Display second" }),
  ).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(
    page.getByRole("menuitem", { name: "Display second" }),
  ).toHaveCount(0);
  await menu.click();
  await page.getByRole("button", { name: "Focus p1", exact: true }).click();
  await expect(
    page.getByRole("menuitem", { name: "Display second" }),
  ).toHaveCount(0);
  await menu.click();
  await page.getByRole("button", { name: "One monitor", exact: true }).click();
  await expect(menu).toHaveCount(0);
  await page.getByRole("button", { name: "Two monitors", exact: true }).click();
  await menu.click();
  await page.getByRole("button", { name: "Replace host", exact: true }).click();
  await expect(
    page.getByRole("menuitem", { name: "Display second" }),
  ).toHaveCount(0);
});

test("moving a real Workbench Screen content route preserves selected display and catalog on the same tab", async ({
  page,
}) => {
  await page.goto("/tests/fixtures/desktop.html?shortcuts");
  const first = page.getByRole("region", { name: "Pane p1", exact: true });
  const second = page.getByRole("region", { name: "Pane p2", exact: true });
  await page.getByRole("button", { name: "Screen menu", exact: true }).click();
  await page
    .getByRole("menuitem", { name: "Display second", exact: true })
    .click();
  await expect(
    first.getByLabel("Display second", { exact: true }),
  ).toBeVisible();
  const lifetimes = await page.getByLabel("Screen lifetimes").textContent();
  await page
    .getByRole("button", { name: "Move active Screen tab", exact: true })
    .click();
  await expect(first.getByLabel("Display second", { exact: true })).toHaveCount(
    0,
  );
  await expect(
    second.getByLabel("Display second", { exact: true }),
  ).toBeVisible();
  await expect(page.getByLabel("Screen lifetimes")).toHaveText(lifetimes!);
  await expect(page.getByLabel("Recorded input")).toHaveText("[]");
  await second
    .getByRole("button", { name: "Back to displays", exact: true })
    .click();
  await expect(
    second.getByRole("navigation", { name: "Displays" }),
  ).toBeVisible();
  await page
    .getByRole("button", { name: "Move active Screen tab", exact: true })
    .click();
  await expect(
    first.getByRole("navigation", { name: "Displays" }),
  ).toBeVisible();
  await expect(
    first.locator('canvas[aria-label="Display second"]'),
  ).toHaveCount(0);
});
