import type { DesktopInputEvent } from "../../src/protocol/generated/rpc.ts";
import { test, expect } from "@playwright/test";

test("Screen opens as a display catalog and selects one monitor in the same tab", async ({
  page,
}) => {
  await page.goto("/tests/fixtures/desktop.html");
  await expect(
    page.getByRole("navigation", { name: "Displays" }),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Display fixture", exact: false }),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Display second", exact: false }),
  ).toBeVisible();
  await expect(page.getByRole("button", { name: /control/i })).toHaveCount(0);
  await expect(
    page.getByRole("button", {
      name: /Open screen|Close screen|Reconnect|Open in another window/i,
    }),
  ).toHaveCount(0);
  await expect(page.getByRole("combobox")).toHaveCount(0);
  await expect(page.getByText("Diagnostics", { exact: true })).toHaveCount(0);
  await page
    .getByRole("button", { name: "Display second", exact: false })
    .click();
  await expect(
    page.getByLabel("Display second", { exact: true }),
  ).toBeVisible();
  await expect(page.getByLabel("Display fixture", { exact: true })).toHaveCount(
    0,
  );
  await expect(page.getByLabel("Recorded input")).toHaveText("[]");
  await expect(
    page.getByRole("button", { name: "Control screen", exact: true }),
  ).toBeEnabled();
  await page.getByRole("button", { name: "Back to displays" }).click();
  await expect(
    page.getByRole("navigation", { name: "Displays" }),
  ).toBeVisible();
  await expect(page.getByRole("button", { name: /control/i })).toHaveCount(0);
  await page
    .getByRole("button", { name: "Display fixture", exact: false })
    .click();
  await expect(
    page.getByLabel("Display fixture", { exact: true }),
  ).toBeVisible();
  await expect(page.getByLabel("Display second", { exact: true })).toHaveCount(
    0,
  );
});

test("viewing never takes control and preserves physical keys and drag transitions", async ({
  page,
}) => {
  await page.goto("/tests/fixtures/desktop.html");
  await page
    .getByRole("button", { name: "Display fixture", exact: false })
    .click();
  const canvas = page.locator('canvas[aria-label="Display fixture"]');
  await canvas.focus();
  await page.keyboard.press("a");
  await expect(page.getByLabel("Recorded input")).toHaveText("[]");
  await page
    .getByRole("button", { name: "Control screen", exact: true })
    .click();
  await canvas.focus();
  await page.keyboard.press("ControlLeft");
  await page.keyboard.press("ControlRight");
  await page.keyboard.press("NumpadEnter");
  const box = (await canvas.boundingBox())!;
  await page.mouse.move(box.x + box.width / 2 - 20, box.y + box.height / 2);
  await page.mouse.down();
  await page.mouse.move(
    box.x + box.width / 2 + 20,
    box.y + box.height / 2 + 10,
    { steps: 3 },
  );
  await page.mouse.up();
  await page
    .getByRole("button", { name: "Release control", exact: true })
    .focus();
  const events: DesktopInputEvent[] = JSON.parse(
    (await page.getByLabel("Recorded input").textContent())!,
  );
  expect(
    events
      .filter((e) => e.type === "physicalKey")
      .map((e) => [e.usage, e.down]),
  ).toEqual([
    [224, true],
    [224, false],
    [228, true],
    [228, false],
    [88, true],
    [88, false],
  ]);
  const down = events.findIndex((e) => e.type === "button" && e.down),
    up = events.findIndex((e) => e.type === "button" && !e.down);
  expect(down).toBeGreaterThan(-1);
  expect(up).toBeGreaterThan(down);
  expect(
    events.slice(down + 1, up).filter((e) => e.type === "absolutePointer")
      .length,
  ).toBeGreaterThanOrEqual(3);
  expect(events.at(-1)?.type).toBe("releaseAll");
  await page.getByRole("button", { name: "Back to displays" }).click();
  await expect(canvas).toHaveCount(0);
});

test("selected toolbar exposes compact accessible controls without Status or Options text", async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(
    "/tests/fixtures/desktop.html?automatic&quality&no-input&input-error",
  );
  await page
    .getByRole("button", { name: "Display fixture", exact: true })
    .click();
  const toolbar = page.locator(".rieul-desktop-toolbar");
  await expect(toolbar.locator("details, summary")).toHaveCount(0);
  await expect(
    toolbar.getByText(
      /Status|Options|Diagnostics|Target FPS|Shared bitrate|Current target|Keyboard input|Automatic video/,
    ),
  ).toHaveCount(0);
  const control = page.getByRole("button", {
    name: "Control screen",
    exact: true,
  });
  await expect(control).toBeDisabled();
  await expect(control).toHaveText("Control screen");
  await expect(control).toHaveAttribute("title", /Input connection failed/);
  for (const label of ["Back to displays", "Check quality support"]) {
    const button = toolbar.getByRole("button", { name: label, exact: true });
    await expect(button).toHaveAttribute("title", /.+/);
    expect((await button.textContent())!.trim()).toBe("");
  }
  await expect(
    page.getByRole("spinbutton", { name: "Target FPS" }),
  ).toBeVisible();
  await expect(
    page.getByRole("spinbutton", { name: "Shared bitrate target (Mbps)" }),
  ).toBeVisible();
  await page.getByRole("spinbutton", { name: "Target FPS" }).fill("30");
  await page
    .getByRole("spinbutton", { name: "Shared bitrate target (Mbps)" })
    .fill("5");
  await page
    .getByRole("button", { name: "Check quality support", exact: true })
    .click();
  const targets = page.getByRole("combobox", {
    name: "Verified video quality target",
  });
  await expect(targets.locator('option[value="0"]')).toBeEnabled();
  await expect(targets.locator('option[value="1"]')).toBeDisabled();
  await expect(
    page.getByRole("button", { name: "Apply verified video quality" }),
  ).toBeEnabled();
  await expect(
    page.getByRole("button", { name: "Use Auto", exact: true }),
  ).toHaveAttribute("title", /Current: 60 FPS/);
  await expect(page.getByLabel("Quality actions")).toHaveText('["query"]');
  await expect(page.getByRole("button", { name: "Use Auto" })).toHaveAttribute(
    "aria-pressed",
    "false",
  );
  await page
    .getByRole("button", { name: "Apply verified video quality" })
    .click();
  await expect(
    page.getByRole("button", { name: "Use Auto", exact: true }),
  ).toHaveAttribute("title", /Current: 30 FPS \/ 5 Mbps/);
  await expect(page.getByLabel("Quality actions")).toHaveText(
    '["query","apply-manual"]',
  );
  await expect(page.getByRole("button", { name: "Use Auto" })).toHaveAttribute(
    "aria-pressed",
    "false",
  );
  expect(
    await page
      .getByRole("region", { name: "Screen", exact: true })
      .evaluate(
        (element) =>
          element.scrollHeight <= element.clientHeight &&
          element.scrollWidth <= element.clientWidth,
      ),
  ).toBe(true);
});

test("quality changes preserve the selected surface and focused held input", async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/tests/fixtures/desktop.html?automatic&quality");
  await page
    .getByRole("button", { name: "Display fixture", exact: false })
    .click();
  await page.getByRole("button", { name: "Check quality support" }).click();
  await page
    .getByRole("button", { name: "Control screen", exact: true })
    .click();
  const canvas = page.locator('canvas[aria-label="Display fixture"]');
  await canvas.focus();
  await page.keyboard.down("a");
  const handle = await canvas.elementHandle();
  await page
    .getByRole("button", { name: "Use Auto", exact: true })
    .evaluate((button: HTMLButtonElement) => button.click());
  await expect(
    page.getByRole("button", { name: "Use Auto", exact: true }),
  ).toHaveAttribute("aria-pressed", "true");
  await expect(
    page.getByRole("button", { name: "Use Auto", exact: true }),
  ).toHaveAttribute("title", /Current: 30 FPS/);
  await expect(canvas).toBeFocused();
  expect(await handle!.evaluate((node) => node.isConnected)).toBe(true);
  let events: DesktopInputEvent[] = JSON.parse(
    (await page.getByLabel("Recorded input").textContent())!,
  );
  expect(events.filter((e) => e.type === "releaseAll")).toHaveLength(0);
  await page.keyboard.up("a");
  events = JSON.parse((await page.getByLabel("Recorded input").textContent())!);
  expect(
    events
      .filter((e) => e.type === "physicalKey")
      .map((e) => [e.usage, e.down]),
  ).toEqual([
    [4, true],
    [4, false],
  ]);
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBe(true);
});

test("control action distinguishes vacant and occupied ownership without taking control automatically", async ({
  page,
}) => {
  await page.goto("/tests/fixtures/desktop.html?occupied");
  await expect(page.getByRole("button", { name: /control/i })).toHaveCount(0);
  await page
    .getByRole("button", { name: "Display fixture", exact: false })
    .click();
  await expect(
    page.getByRole("button", { name: "Control screen", exact: true }),
  ).toHaveCount(0);
  await expect(
    page.getByRole("button", { name: "Take control from another viewer" }),
  ).toBeEnabled();
  await expect(
    page.getByRole("button", { name: "Take control from another viewer" }),
  ).toHaveText("Take control");
  await expect(
    page.getByRole("button", { name: "Take control from another viewer" }),
  ).toHaveAttribute("title", /release their held inputs/);
  await expect(page.getByLabel("Recorded input")).toHaveText("[]");
  await page
    .getByRole("button", { name: "Take control from another viewer" })
    .click();
  await expect(
    page.getByRole("button", { name: "Release control", exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Release control", exact: true }),
  ).toHaveText("Release control");
  await page.getByRole("button", { name: "Back to displays" }).click();
  await page
    .getByRole("button", { name: "Display fixture", exact: false })
    .click();
  await expect(
    page.getByRole("button", { name: "Control screen", exact: true }),
  ).toBeVisible();
});

test("hiding a tab releases control and retains selection without restoring authority", async ({
  page,
}) => {
  await page.goto("/tests/fixtures/desktop.html");
  await page
    .getByRole("button", { name: "Display fixture", exact: false })
    .click();
  await page
    .getByRole("button", { name: "Control screen", exact: true })
    .click();
  await page.getByRole("button", { name: "Hide Screen tab" }).click();
  await expect(page.getByRole("region", { name: "Screen" })).not.toBeVisible();
  await page.getByRole("button", { name: "Show Screen tab" }).click();
  await expect(
    page.getByLabel("Display fixture", { exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Control screen", exact: true }),
  ).toBeEnabled();
  await expect(
    page.getByRole("button", { name: "Release control", exact: true }),
  ).toHaveCount(0);
});

test("same-monitor panes keep independent navigation and explicit shared input ownership", async ({
  page,
}) => {
  await page.goto("/tests/fixtures/desktop.html?split");
  const first = page.getByRole("region", { name: "First pane", exact: true });
  const second = page.getByRole("region", { name: "Second pane", exact: true });
  await first
    .getByRole("button", { name: "Display fixture", exact: false })
    .click();
  await second
    .getByRole("button", { name: "Display fixture", exact: false })
    .click();
  await expect(
    first.getByLabel("Display fixture", { exact: true }),
  ).toBeVisible();
  await expect(
    second.getByLabel("Display fixture", { exact: true }),
  ).toBeVisible();
  await first
    .getByRole("button", { name: "Control screen", exact: true })
    .click();
  await expect(
    second.getByRole("button", { name: "Control here", exact: true }),
  ).toBeVisible();
  await expect(
    second.getByRole("button", { name: "Control here", exact: true }),
  ).toHaveText("Control here");
  await second.getByRole("button", { name: "Back to displays" }).click();
  await expect(
    first.getByLabel("Display fixture", { exact: true }),
  ).toBeVisible();
  await expect(
    first.getByRole("button", { name: "Release control", exact: true }),
  ).toBeVisible();
  await second
    .getByRole("button", { name: "Display fixture", exact: false })
    .click();
  await second
    .getByRole("button", { name: "Control here", exact: true })
    .click();
  await expect(
    first.getByRole("button", { name: "Control here", exact: true }),
  ).toBeVisible();
  await second.getByRole("button", { name: "Back to displays" }).click();
  await expect(
    first.getByLabel("Display fixture", { exact: true }),
  ).toBeVisible();
  await expect(
    first.getByRole("button", { name: "Control screen", exact: true }),
  ).toBeVisible();
});

test("direct toolbar keeps quality validation and legacy resize usable in a short narrow pane", async ({
  page,
}) => {
  await page.setViewportSize({ width: 180, height: 260 });
  await page.goto("/tests/fixtures/desktop.html?quality");
  await page
    .getByRole("navigation", { name: "Monitor list" })
    .getByRole("button", { name: "Choose monitor fixture", exact: true })
    .click();
  const screen = page.getByRole("region", { name: "Screen", exact: true });
  const toolbar = page.locator(".rieul-desktop-toolbar");
  await expect(toolbar.locator("summary")).toHaveCount(0);
  const sizingLabel = page
    .getByRole("combobox", { name: "Maximum video size" })
    .locator("..");
  await expect(sizingLabel.locator("svg")).toHaveCount(0);
  await page
    .getByRole("combobox", { name: "Maximum video size" })
    .selectOption("720");
  await expect(
    page.getByRole("combobox", { name: "Maximum video size" }),
  ).toHaveValue("720");
  const fps = page.getByRole("spinbutton", { name: "Target FPS" });
  await fps.fill("0");
  await expect(
    page.getByRole("button", { name: "Check quality support" }),
  ).toBeDisabled();
  await fps.fill("30");
  await page
    .getByRole("spinbutton", { name: "Shared bitrate target (Mbps)" })
    .fill("5");
  await page.getByRole("button", { name: "Check quality support" }).click();
  await page
    .getByRole("button", { name: "Apply verified video quality" })
    .click();
  const canvas = page.locator('canvas[aria-label="Display fixture"]');
  await expect(canvas).toBeVisible();
  expect((await canvas.boundingBox())!.height).toBeGreaterThan(20);
  expect(
    await screen.evaluate(
      (element) =>
        element.scrollHeight <= element.clientHeight &&
        element.scrollWidth <= element.clientWidth,
    ),
  ).toBe(true);
  expect(
    await page.evaluate(
      () =>
        document.documentElement.scrollWidth <= innerWidth &&
        document.documentElement.scrollHeight <= innerHeight,
    ),
  ).toBe(true);
  await expect(page.getByLabel("Recorded input")).toHaveText("[]");
});

test("host input source select is compact, controller-only and keeps native input untouched", async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 720 });
  await page.goto("/tests/fixtures/desktop.html?ime&automatic");
  await page
    .getByRole("button", { name: "Display fixture", exact: false })
    .click();
  const select = page.getByRole("combobox", { name: "Host input source" });
  await expect(select).toBeDisabled();
  await expect(select).toHaveValue("english");
  await page
    .getByRole("button", { name: "Control screen", exact: true })
    .click();
  await expect(select).toBeEnabled();
  await select.focus();
  await expect(select).toBeFocused();
  await select.selectOption("korean");
  await expect(select).toHaveValue("korean");
  await select.selectOption("english");
  await expect(select).toHaveValue("english");
  await expect(page.getByLabel("Recorded input")).toHaveText("[]");
  await page
    .getByRole("button", { name: "Release control", exact: true })
    .click();
  await expect(select).toBeDisabled();
  await page
    .getByRole("button", { name: "Back to displays", exact: true })
    .click();
  await expect(select).toHaveCount(0);
});

test("unsupported hosts hide IME and failed selections stay explicit", async ({
  page,
}) => {
  await page.goto("/tests/fixtures/desktop.html");
  await page
    .getByRole("button", { name: "Display fixture", exact: false })
    .click();
  await expect(
    page.getByRole("combobox", { name: "Host input source" }),
  ).toHaveCount(0);
  await page.goto("/tests/fixtures/desktop.html?ime&ime-error");
  await page
    .getByRole("button", { name: "Display fixture", exact: false })
    .click();
  await page
    .getByRole("button", { name: "Control screen", exact: true })
    .click();
  const select = page.getByRole("combobox", { name: "Host input source" });
  await select.selectOption("korean");
  await expect(select).toHaveValue("english");
  await expect(page.getByRole("alert")).toContainText(
    "Input source change failed",
  );
});
