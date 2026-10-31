import { expect, test } from "@playwright/test";
const metrics = (page: import("@playwright/test").Page) =>
  page.evaluate(
    () =>
      (window as unknown as { fixture: { metrics: Record<string, number> } })
        .fixture.metrics,
  );
test("shared Bunja survives first-owner removal; final owner releases both roots and atom subscription", async ({
  page,
}) => {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto("/");
  await expect(page.getByLabel("first", { exact: true })).toHaveText(
    "1:A:override:1:0",
  );
  await expect(page.getByLabel("second", { exact: true })).toHaveText(
    "1:A:override:1:0",
  );
  await page.getByRole("button", { name: "Remove first", exact: true }).click();
  await page
    .getByRole("button", { name: "Increment second", exact: true })
    .click();
  await expect(page.getByLabel("second", { exact: true })).toHaveText(
    "1:A:override:2:1",
  );
  expect(await metrics(page)).toEqual({
    created: 1,
    mounted: 1,
    released: 0,
    rootsDisposed: 0,
    observations: 1,
    unobservations: 0,
  });
  await page.getByRole("button", { name: "Remove all", exact: true }).click();
  await expect.poll(async () => (await metrics(page)).released).toBe(1);
  expect(await metrics(page)).toEqual({
    created: 1,
    mounted: 1,
    released: 1,
    rootsDisposed: 1,
    observations: 1,
    unobservations: 1,
  });
  await page.getByRole("button", { name: "Remount", exact: true }).click();
  await expect(page.getByLabel("first", { exact: true })).toHaveText(
    "2:A:override:1:0",
  );
  await page
    .getByRole("button", { name: "Dispose provider", exact: true })
    .click();
  await expect.poll(async () => (await metrics(page)).rootsDisposed).toBe(2);
  expect(errors).toEqual([]);
});
test("scope and store replacement release old instances and reconnect observers", async ({
  page,
}) => {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto("/");
  await expect(page.getByLabel("first", { exact: true })).toHaveText(
    "1:A:override:1:0",
  );
  await page
    .getByRole("button", { name: "Replace scope", exact: true })
    .click();
  await expect(page.getByLabel("first", { exact: true })).toHaveText(
    "2:B:override:1:0",
  );
  await expect(page.getByLabel("second", { exact: true })).toHaveText(
    "2:B:override:1:0",
  );
  await expect.poll(async () => (await metrics(page)).released).toBe(1);
  await page
    .getByRole("button", { name: "Replace store", exact: true })
    .click();
  await expect(page.getByLabel("first", { exact: true })).toHaveText(
    "3:B:override:1:0",
  );
  await expect.poll(async () => (await metrics(page)).released).toBe(2);
  expect((await metrics(page)).unobservations).toBe(2);
  expect(errors).toEqual([]);
});

test("production machine Bunja keeps sharing, machine scope and persistence through Solid replacement", async ({
  page,
}) => {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto("/production.html");
  await page.getByRole("button", { name: "Add one", exact: true }).click();
  await expect(page.getByLabel("one", { exact: true })).toHaveText(
    "1:Machine A",
  );
  await expect(page.getByLabel("two", { exact: true })).toHaveText(
    "1:Machine A",
  );
  await page.getByRole("button", { name: "Select B one", exact: true }).click();
  await expect(page.getByLabel("one", { exact: true })).toHaveText(
    "2:Machine A",
  );
  await page.getByRole("button", { name: "Keep one", exact: true }).click();
  const writes = () =>
    page.evaluate(
      () =>
        (window as unknown as { productionFixture: { writes: number[] } })
          .productionFixture.writes,
    );
  expect(await writes()).toEqual([4, 0]);
  await page.getByRole("button", { name: "Remove all", exact: true }).click();
  // Wait for the documented deferred Bunja release, not a fixed test delay.
  await expect
    .poll(() =>
      page.evaluate(() => {
        const f = (
          window as unknown as {
            productionFixture: {
              writes: number[];
              last: { selectMachine(id: string): void };
            };
          }
        ).productionFixture;
        const before = f.writes[0];
        f.last.selectMachine(crypto.randomUUID());
        return f.writes[0] === before;
      }),
    )
    .toBe(true);
  await page.getByRole("button", { name: "Remount", exact: true }).click();
  await expect(page.getByLabel("one", { exact: true })).toHaveText(
    "2:Machine A",
  );
  await page
    .getByRole("button", { name: "Replace storage", exact: true })
    .click();
  await expect(page.getByLabel("one", { exact: true })).toHaveText("0:none");
  await page.getByRole("button", { name: "Add two", exact: true }).click();
  await expect(page.getByLabel("one", { exact: true })).toHaveText(
    "1:Machine A",
  );
  expect((await writes())[1]).toBe(2);
  expect(errors).toEqual([]);
});
