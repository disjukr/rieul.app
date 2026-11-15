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
    expect((await preview.boundingBox())!.height).toBeGreaterThan(0);
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

test("catalog fits mixed-DPI negative and vertical host layout through narrow resize", async ({
  page,
}) => {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.setViewportSize({ width: 900, height: 700 });
  await page.goto("/tests/fixtures/desktop.html?spatial");
  const nav = page.getByRole("navigation", { name: "Displays" });
  const first = nav.getByRole("button", {
    name: "Display fixture",
    exact: true,
  });
  const second = nav.getByRole("button", {
    name: "Display second",
    exact: true,
  });
  await expect(page.getByLabel("Preview subscriptions")).toHaveText("2");
  const canvas = await first.locator("canvas").elementHandle();
  for (const viewport of [
    { width: 900, height: 700 },
    { width: 180, height: 250 },
    { width: 390, height: 700 },
  ]) {
    await page.setViewportSize(viewport);
    await expect
      .poll(async () => {
        const container = (await nav.boundingBox())!;
        const expectedScale = Math.min(
          container.width / 3000,
          container.height / 1920,
        );
        return Math.abs(
          (await first.boundingBox())!.width - expectedScale * 1920,
        );
      })
      .toBeLessThan(0.1);
    await expect
      .poll(
        async () =>
          (await first.boundingBox())!.width /
          (await second.boundingBox())!.width,
      )
      .toBeCloseTo(1920 / 1080, 2);
    const [a, b, container] = await Promise.all([
      first.boundingBox(),
      second.boundingBox(),
      nav.boundingBox(),
    ]);
    expect(a!.x).toBeCloseTo(b!.x + b!.width, 1);
    expect(a!.y - b!.y).toBeCloseTo((b!.height * 400) / 1920, 1);
    expect(a!.width / a!.height).toBeCloseTo(1920 / 1080, 2);
    expect(b!.width / b!.height).toBeCloseTo(1080 / 1920, 2);
    for (const box of [a!, b!]) {
      expect(box.x).toBeGreaterThanOrEqual(container!.x);
      expect(box.y).toBeGreaterThanOrEqual(container!.y);
      expect(box.x + box.width).toBeLessThanOrEqual(
        container!.x + container!.width + 0.1,
      );
      expect(box.y + box.height).toBeLessThanOrEqual(
        container!.y + container!.height + 0.1,
      );
    }
    expect(await canvas!.evaluate((el) => el.isConnected)).toBe(true);
    await expect(page.getByLabel("Preview subscriptions")).toHaveText("2");
  }
  const pane = page.getByRole("region", { name: "First pane", exact: true });
  await pane.evaluate((element) => {
    element.style.width = "0px";
    element.style.height = "0px";
  });
  await expect.poll(async () => (await nav.boundingBox())!.width).toBe(0);
  await pane.evaluate((element) => {
    element.style.width = "";
    element.style.height = "calc(100dvh - 40px)";
  });
  await expect
    .poll(async () => (await first.boundingBox())!.width)
    .toBeGreaterThan(0);
  await expect(page.getByLabel("Preview subscriptions")).toHaveText("2");
  expect(await canvas!.evaluate((el) => el.isConnected)).toBe(true);
  expect(errors).toEqual([]);
  await second.focus();
  await page.keyboard.press("Enter");
  await expect(
    page.locator('canvas[aria-label="Display second"]'),
  ).toBeVisible();
  await expect(page.getByLabel("Recorded input")).toHaveText("[]");
});

test("mirrored monitors keep their positions and each remains pointer-selectable", async ({
  page,
}) => {
  await page.goto("/tests/fixtures/desktop.html?mirrored");
  const nav = page.getByRole("navigation", { name: "Displays" });
  await expect
    .poll(() =>
      nav.evaluate((element) => {
        const [a, b] = [...element.querySelectorAll("button")].map((button) =>
          button.getBoundingClientRect(),
        );
        return (
          a.width > 0 &&
          a.x === b.x &&
          a.y === b.y &&
          a.width === b.width &&
          a.height === b.height
        );
      }),
    )
    .toBe(true);
  await page
    .getByRole("button", { name: "Choose monitor fixture", exact: true })
    .click();
  await expect(
    page.locator('canvas[aria-label="Display fixture"]'),
  ).toBeVisible();
  await page.getByRole("button", { name: "Back to displays" }).click();
  await page
    .getByRole("button", { name: "Choose monitor second", exact: true })
    .click();
  await expect(
    page.locator('canvas[aria-label="Display second"]'),
  ).toBeVisible();
  await expect(page.getByLabel("Recorded input")).toHaveText("[]");
});

test("wide catalog fills available width and mobile list immediately follows the arrangement", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1200, height: 800 });
  await page.goto("/tests/fixtures/desktop.html");
  const nav = page.getByRole("navigation", { name: "Displays", exact: true });
  const tile = nav.getByRole("button", {
    name: "Display fixture",
    exact: true,
  });
  await expect
    .poll(async () => (await tile.boundingBox())!.width)
    .toBeCloseTo(600, 0);
  await expect(
    page.getByRole("navigation", { name: "Monitor list", exact: true }),
  ).toHaveCount(0);
  const canvas = await tile.locator("canvas").elementHandle();
  await page.setViewportSize({ width: 390, height: 700 });
  const list = page.getByRole("navigation", {
    name: "Monitor list",
    exact: true,
  });
  await expect(list).toBeVisible();
  await expect
    .poll(async () => (await nav.boundingBox())!.height)
    .toBeCloseTo((390 * 180) / 640, 0);
  const [stage, rows] = await Promise.all([
    nav.boundingBox(),
    list.boundingBox(),
  ]);
  expect(rows!.y).toBeCloseTo(stage!.y + stage!.height, 1);
  expect(rows!.height).toBeGreaterThanOrEqual(88);
  expect(rows!.y + rows!.height).toBeLessThan(700);
  await expect(nav.locator("canvas")).toHaveCount(2);
  await expect(list.locator("canvas")).toHaveCount(0);
  await expect(page.getByLabel("Preview subscriptions")).toHaveText("2");
  expect(await canvas!.evaluate((el) => el.isConnected)).toBe(true);
  await list
    .getByRole("button", { name: "Choose monitor second", exact: true })
    .click();
  await expect(
    page.locator('canvas[aria-label="Display second"]'),
  ).toBeVisible();
  await expect(page.getByLabel("Recorded input")).toHaveText("[]");
  await page.getByRole("button", { name: "Back to displays" }).click();
  await nav
    .getByRole("button", { name: "Display fixture", exact: true })
    .click();
  await expect(
    page.locator('canvas[aria-label="Display fixture"]'),
  ).toBeVisible();
});

test("narrow split panes use their own width and locally scroll to a tappable list", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1100, height: 260 });
  await page.goto("/tests/fixtures/desktop.html?portrait&split");
  const pane = page.getByRole("region", { name: "First pane", exact: true });
  await pane.evaluate((element) => {
    element.style.width = "300px";
  });
  const nav = pane.getByRole("navigation", { name: "Displays", exact: true });
  const list = pane.getByRole("navigation", {
    name: "Monitor list",
    exact: true,
  });
  await expect(list).toBeVisible();
  await expect(
    pane.getByRole("navigation", { name: "Monitor list", exact: true }),
  ).toHaveCount(1);
  await expect(pane.locator("canvas")).toHaveCount(2);
  await expect
    .poll(async () => (await nav.boundingBox())!.height)
    .toBeLessThanOrEqual(80.1);
  const screen = pane.getByRole("region", { name: "Screen", exact: true });
  expect(
    await screen.evaluate((element) => ({
      scroll: element.scrollHeight > element.clientHeight,
      overflow: getComputedStyle(element).overflowY,
    })),
  ).toEqual({ scroll: true, overflow: "auto" });
  const row = list.getByRole("button", {
    name: "Choose monitor second",
    exact: true,
  });
  await row.scrollIntoViewIfNeeded();
  expect((await row.boundingBox())!.height).toBeGreaterThanOrEqual(44);
  await row.click();
  await expect(
    pane.locator('canvas[aria-label="Display second"]'),
  ).toBeVisible();
  expect(
    await pane
      .getByRole("region", { name: "Screen", exact: true })
      .evaluate((element) => getComputedStyle(element).overflowY),
  ).toBe("hidden");
  await expect(page.getByLabel("Recorded input")).toHaveText("[]");
});
