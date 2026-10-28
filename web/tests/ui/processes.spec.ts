import { test, expect } from "@playwright/test";
test("process consumers share the stream across context replacement and partial unmount", async ({
  page,
}) => {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto("/tests/fixtures/processes.html");
  const counts = () =>
    page.evaluate(
      () =>
        (
          window as unknown as {
            processesFixture: { starts: number; stops: number };
          }
        ).processesFixture,
    );
  await expect(page.getByLabel("list")).toHaveText("ready:a");
  await expect(page.getByLabel("tree")).toHaveText("ready:a");
  expect(await counts()).toEqual({ starts: 1, stops: 0 });
  await page.getByRole("button", { name: "Replace machine" }).click();
  await expect(page.getByLabel("list")).toHaveText("ready:b");
  await expect(page.getByLabel("tree")).toHaveText("ready:b");
  await expect.poll(counts).toEqual({ starts: 2, stops: 1 });
  await page.getByRole("button", { name: "One consumer" }).click();
  await expect(page.getByLabel("tree")).toHaveCount(0);
  expect(await counts()).toEqual({ starts: 2, stops: 1 });
  await page.getByRole("button", { name: "Unmount all" }).click();
  await expect.poll(counts).toEqual({ starts: 2, stops: 2 });
  await page.getByRole("button", { name: "Remount" }).click();
  await expect(page.getByLabel("list")).toHaveText("ready:b");
  await expect(page.getByLabel("tree")).toHaveText("ready:b");
  expect(await counts()).toEqual({ starts: 3, stops: 2 });
  expect(errors).toEqual([]);
});
