import { test, expect } from "@playwright/test";

test("nested providers isolate overrides and dispose each resource once despite deferred releases", async ({
  page,
}) => {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto("/tests/fixtures/providers.html");
  await expect(
    page.getByRole("button", { name: "outer one", exact: true }),
  ).toHaveText("outer:0");
  await expect(
    page.getByRole("button", { name: "inner one", exact: true }),
  ).toHaveText("inner:0");
  await expect(
    page.getByRole("button", { name: "independent default", exact: true }),
  ).toHaveText("default:0");
  await page.getByRole("button", { name: "inner one", exact: true }).click();
  await expect(
    page.getByRole("button", { name: "inner two", exact: true }),
  ).toHaveText("inner:1");
  await expect(
    page.getByRole("button", { name: "outer two", exact: true }),
  ).toHaveText("outer:0");
  await page
    .getByRole("button", { name: "Remove nested providers", exact: true })
    .click();
  await page.getByRole("button", { name: "outer one", exact: true }).click();
  await expect(
    page.getByRole("button", { name: "outer two", exact: true }),
  ).toHaveText("outer:1");
  await page
    .getByRole("button", { name: "Remove outer provider", exact: true })
    .click();
  // Cross the deferred-unmount task boundary before checking exact cleanup counts.
  const events = await page.evaluate(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
    return (window as unknown as { providerEvents: string[] }).providerEvents;
  });
  expect(events.sort()).toEqual(
    [
      "mount:default",
      "mount:inner",
      "mount:outer",
      "release:default",
      "release:inner",
      "release:outer",
      "root:default",
      "root:inner",
      "root:outer",
    ].sort(),
  );
  expect(errors).toEqual([]);
});
