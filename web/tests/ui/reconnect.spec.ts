import { test, expect } from "@playwright/test";
test("RPC reconnects after daemon restart and half-open loss, but not explicit disconnect", async ({
  page,
}) => {
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await page.clock.install();
  await page.goto("/tests/fixtures/reconnect.html");
  await expect(page.getByLabel("Connection")).toHaveText("reachable");
  await expect(page.getByLabel("Attempts")).toHaveText("1");
  await page.getByRole("button", { name: "Daemon restart" }).click();
  await expect(page.getByLabel("Connection")).toHaveText("offline");
  await page.clock.runFor(500);
  await expect(page.getByLabel("Instance")).toHaveText("daemon-2");
  await page.getByRole("button", { name: "Drop packets" }).click();
  await page.clock.runFor(10500);
  await expect(page.getByLabel("Instance")).toHaveText("daemon-3");
  await page.getByRole("button", { name: "Disconnect", exact: true }).click();
  await page.getByRole("button", { name: "Online", exact: true }).click();
  await page.clock.runFor(60000);
  await expect(page.getByLabel("Connection")).toHaveText("offline");
  await expect(page.getByLabel("Attempts")).toHaveText("3");
  expect(errors).toEqual([]);
});
