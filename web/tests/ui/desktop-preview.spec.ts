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
        const container = (await nav
          .locator(".rieul-desktop-arrangement-content")
          .boundingBox())!;
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
  await expect
    .poll(
      async () =>
        (await nav.locator(".rieul-desktop-arrangement-content").boundingBox())!
          .width,
    )
    .toBe(0);
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
    .toBeCloseTo(588, 0);
  await expect(
    page.getByRole("navigation", { name: "Monitor list", exact: true }),
  ).toHaveCount(0);
  for (const colorScheme of ["light", "dark"] as const) {
    await page.emulateMedia({ colorScheme });
    await expect(nav).toHaveCSS("background-color", "rgb(0, 0, 0)");
  }
  const wideStage = (await nav.boundingBox())!;
  const wideTile = (await tile.boundingBox())!;
  expect(wideTile.x - wideStage.x).toBeCloseTo(12, 1);
  const canvas = await tile.locator("canvas").elementHandle();
  await page.setViewportSize({ width: 390, height: 700 });
  const list = page.getByRole("navigation", {
    name: "Monitor list",
    exact: true,
  });
  await expect(list).toBeVisible();
  await expect
    .poll(async () => (await nav.boundingBox())!.height)
    .toBeCloseTo((366 * 180) / 640 + 48, 0);
  const [stage, rows] = await Promise.all([
    nav.boundingBox(),
    list.boundingBox(),
  ]);
  expect(rows!.y).toBeCloseTo(stage!.y + stage!.height, 1);
  const mobileTile = (await tile.boundingBox())!;
  expect(mobileTile.x - stage!.x).toBeCloseTo(12, 1);
  expect(mobileTile.y - stage!.y).toBeCloseTo(24, 1);
  await expect(list).not.toHaveCSS("background-color", "rgb(0, 0, 0)");
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
    .toBeLessThanOrEqual(128.1);
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

test("arrangement padding uses live rem/em with square borderless tiles and keyboard focus", async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 700 });
  await page.goto("/tests/fixtures/desktop.html");
  const stage = page.getByRole("navigation", { name: "Displays", exact: true });
  const tile = stage.getByRole("button", {
    name: "Display fixture",
    exact: true,
  });
  const canvas = await tile.locator("canvas").elementHandle();
  await page.evaluate(() => {
    document.documentElement.style.fontSize = "20px";
  });
  await stage.evaluate((element) => {
    element.style.fontSize = "18px";
  });
  await expect(stage).toHaveCSS("padding-top", "40px");
  await expect(stage).toHaveCSS("padding-bottom", "40px");
  await expect(stage).toHaveCSS("padding-left", "18px");
  await expect(stage).toHaveCSS("padding-right", "18px");
  await expect(stage).toHaveCSS("background-color", "rgb(0, 0, 0)");
  for (const element of [stage, tile]) {
    await expect(element).toHaveCSS("border-top-width", "0px");
    await expect(element).toHaveCSS("border-radius", "0px");
  }
  await expect
    .poll(async () => (await tile.boundingBox())!.width)
    .toBeCloseTo(177, 0);
  const [outer, inner, box, list] = await Promise.all([
    stage.boundingBox(),
    stage.locator(".rieul-desktop-arrangement-content").boundingBox(),
    tile.boundingBox(),
    page
      .getByRole("navigation", { name: "Monitor list", exact: true })
      .boundingBox(),
  ]);
  expect(box!.x - outer!.x).toBeCloseTo(18, 1);
  expect(box!.y - outer!.y).toBeCloseTo(40, 1);
  expect(box!.width / box!.height).toBeCloseTo(320 / 180, 2);
  expect(box!.x + box!.width).toBeLessThanOrEqual(inner!.x + inner!.width);
  expect(box!.y + box!.height).toBeLessThanOrEqual(
    inner!.y + inner!.height + 0.1,
  );
  expect(list!.y).toBeCloseTo(outer!.y + outer!.height, 1);
  await tile.focus();
  await expect(tile).toHaveCSS("outline-style", "solid");
  await expect(tile).toHaveCSS("outline-width", "2px");
  expect(await canvas!.evaluate((element) => element.isConnected)).toBe(true);
  await expect(page.getByLabel("Preview subscriptions")).toHaveText("2");
});

test("catalog hides transient connection bars and stale errors but retains actionable status", async ({
  page,
}) => {
  for (const query of ["connecting", "connecting&stale-error", "loading"]) {
    await page.goto(`/tests/fixtures/desktop.html?${query}`);
    await expect(
      page.getByLabel("Connection status", { exact: true }),
    ).toHaveCount(0);
    await expect(
      page.getByText("Old connection failure", { exact: true }),
    ).toHaveCount(0);
  }
  for (const [query, text] of [
    [
      "unavailable",
      "This daemon version does not offer Screen. Update the daemon to continue.",
    ],
    ["unpaired", "Select a paired daemon to connect."],
    ["no-displays", "No displays are available."],
    ["failure", "Screen connection failed."],
  ]) {
    await page.goto(`/tests/fixtures/desktop.html?${query}`);
    await page.getByLabel("Connection status", { exact: true }).click();
    await expect(
      page.getByRole("status").filter({ hasText: text }),
    ).toBeVisible();
  }
});

test("a very short wide catalog scrolls without clipping its overlap selector", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1100, height: 140 });
  await page.goto("/tests/fixtures/desktop.html?mirrored&split");
  const pane = page.getByRole("region", { name: "First pane", exact: true });
  const screen = pane.getByRole("region", { name: "Screen", exact: true });
  const list = pane.getByRole("navigation", {
    name: "Monitor list",
    exact: true,
  });
  await expect(list).toBeVisible();
  await expect(screen).toHaveCSS("overflow-y", "auto");
  const row = list.getByRole("button", {
    name: "Choose monitor fixture",
    exact: true,
  });
  await row.scrollIntoViewIfNeeded();
  await row.click();
  await expect(
    pane.locator('canvas[aria-label="Display fixture"]'),
  ).toBeVisible();
  await expect(
    pane.getByRole("region", { name: "Screen", exact: true }),
  ).toHaveCSS("overflow-y", "hidden");
});
