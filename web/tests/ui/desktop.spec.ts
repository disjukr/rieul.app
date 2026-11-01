import type { DesktopInputEvent } from "../../src/protocol/generated/rpc.ts";
import { test, expect } from "@playwright/test";
test("viewer never takes control on viewing and preserves physical key identity and drag transitions", async ({
  page,
}) => {
  await page.goto("/tests/fixtures/desktop.html");
  await expect(
    page.getByRole("button", { name: "Acquire control", exact: true }),
  ).toBeDisabled();
  await page.getByRole("button", { name: "Connect", exact: true }).click();
  await expect(
    page.getByRole("region", { name: "Remote desktop" }).getByRole("status"),
  ).toContainText("Viewing only");
  const canvas = page.getByLabel("Remote display fixture", { exact: true });
  await canvas.focus();
  await page.keyboard.press("a");
  await expect(page.getByLabel("Recorded input")).toHaveText("[]");
  await page
    .getByRole("button", { name: "Acquire control", exact: true })
    .click();
  await canvas.focus();
  await page.keyboard.press("ControlLeft");
  await page.keyboard.press("ControlRight");
  await page.keyboard.press("NumpadEnter");
  const box = (await canvas.boundingBox())!;
  await page.mouse.move(box.x + 10, box.y + 10);
  await page.mouse.down();
  await page.mouse.move(box.x + 60, box.y + 40, { steps: 3 });
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
  await page.getByRole("button", { name: "Disconnect", exact: true }).click();
  await expect(canvas).toHaveCount(0);
});
