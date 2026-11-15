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
  const canvas = page.getByLabel("Display fixture", { exact: true });
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

test("diagnostics stay hidden and errors remain visible on a narrow selected display", async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(
    "/tests/fixtures/desktop.html?automatic&quality&no-input&input-error",
  );
  await page
    .getByRole("button", { name: "Display fixture", exact: false })
    .click();
  await page.getByLabel("Connection status", { exact: true }).click();
  const status = page
    .getByRole("region", { name: "Screen" })
    .getByRole("status")
    .first();
  await expect(status).toContainText("Input connection failed.");
  await expect(
    page.getByRole("button", { name: "Control screen", exact: true }),
  ).toBeDisabled();
  const codec = page.getByText("Display fixture: 320 × 180 · fixture", {
    exact: true,
  });
  const decoder = page.getByLabel("Screen decoder status");
  await expect(codec).not.toBeVisible();
  await expect(decoder).not.toBeVisible();
  await page.getByText("Options", { exact: true }).click();
  await page.getByRole("button", { name: "Check quality support" }).click();
  const probe = page.getByText(
    "Fixture encoder verified; throughput unverified.",
    { exact: false },
  );
  await expect(probe).not.toBeVisible();
  await expect(
    page.getByRole("button", { name: "Use 30 FPS / 5 Mbps", exact: true }),
  ).toBeEnabled();
  await expect(
    page.getByRole("button", { name: "Use 120 FPS / 50 Mbps", exact: true }),
  ).toBeDisabled();
  const diagnostics = page.getByText("Diagnostics", { exact: true });
  await diagnostics.focus();
  await page.keyboard.press("Enter");
  await expect(codec).toBeVisible();
  await expect(decoder).toBeVisible();
  await expect(probe).toBeVisible();
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBe(true);
  await diagnostics.click();
  await expect(codec).not.toBeVisible();
  await page.getByLabel("Connection status", { exact: true }).click();
  await expect(status).toContainText("Input connection failed.");
});

test("quality changes preserve the selected surface and focused held input", async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/tests/fixtures/desktop.html?automatic&quality");
  await page
    .getByRole("button", { name: "Display fixture", exact: false })
    .click();
  await page.getByText("Options", { exact: true }).click();
  await page.getByRole("button", { name: "Check quality support" }).click();
  await page
    .getByRole("button", { name: "Control screen", exact: true })
    .click();
  const canvas = page.getByLabel("Display fixture", { exact: true });
  await canvas.focus();
  await page.keyboard.down("a");
  const handle = await canvas.elementHandle();
  await page
    .getByRole("button", { name: "Use Auto", exact: true })
    .evaluate((button: HTMLButtonElement) => button.click());
  await expect(
    page.getByText("Current target: 30 FPS", { exact: false }),
  ).toBeVisible();
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
  await page.getByLabel("Connection status", { exact: true }).click();
  await expect(
    page.getByText("Taking control will release their held inputs.", {
      exact: false,
    }),
  ).toBeVisible();
  await expect(page.getByLabel("Recorded input")).toHaveText("[]");
  await page
    .getByRole("button", { name: "Take control from another viewer" })
    .click();
  await expect(
    page.getByRole("button", { name: "Release control", exact: true }),
  ).toBeVisible();
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
