import { test, expect } from "@playwright/test";

test.beforeEach(async ({ page }) => {
  // No real daemon, credentials, user browser profile, or transport connection.
  await page.addInitScript(() => {
    Object.defineProperty(window, "WebTransport", {
      configurable: true,
      value: class {
        constructor() {
          throw new Error("isolated UI fixture: offline");
        }
      },
    });
  });
});
test("empty app adds a synthetic machine and restores it on reload", async ({
  page,
}) => {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto("/");
  await page
    .getByRole("textbox", { name: "Machine name" })
    .fill("Fixture machine");
  await page
    .getByRole("textbox", { name: "Machine URL" })
    .fill("fixture.invalid");
  await page.getByRole("button", { name: "Continue", exact: true }).click();
  await expect(
    page.getByRole("dialog", { name: "Pair machine" }),
  ).toBeVisible();
  await page.getByRole("button", { name: "Skip", exact: true }).click();
  await expect(
    page.getByRole("button", { name: "Fixture machine", exact: true }),
  ).toHaveAttribute("aria-current", "true");
  await page.reload();
  await expect(
    page.getByRole("button", { name: "Fixture machine", exact: true }),
  ).toHaveAttribute("aria-current", "true");
  expect(
    await page.evaluate(
      () => JSON.parse(localStorage.getItem("rieul.machines.v1")!)[0].baseUrl,
    ),
  ).toBe("https://fixture.invalid:9012");
  expect(errors).toEqual([]);
});
test("scoped machine selection survives switching and navigation reload", async ({
  page,
}) => {
  await page.addInitScript(() => {
    if (localStorage.getItem("fixture-seeded")) return;
    localStorage.setItem("fixture-seeded", "true");
    localStorage.setItem(
      "rieul.machines.v1",
      JSON.stringify(
        ["A", "B"].map((id) => ({
          id,
          name: `Fixture ${id}`,
          baseUrl: `https://${id.toLowerCase()}.invalid:9012`,
        })),
      ),
    );
    localStorage.setItem("rieul.selected-machine-id.v1", "A");
  });
  await page.goto("/");
  await page.getByRole("button", { name: "Fixture B", exact: true }).click();
  await expect(
    page.getByRole("button", { name: "Fixture B", exact: true }),
  ).toHaveAttribute("aria-current", "true");
  await page.reload();
  await expect(
    page.getByRole("button", { name: "Fixture B", exact: true }),
  ).toHaveAttribute("aria-current", "true");
});
test("Solid consumers share writers, retain them on partial unmount, reload and replace storage scope", async ({
  page,
}) => {
  await page.goto("/tests/fixtures/bunja.html");
  await page.getByRole("button", { name: "Add from one", exact: true }).click();
  await expect(page.getByLabel("one")).toHaveText("1");
  await expect(page.getByLabel("two")).toHaveText("1");
  const writes = () =>
    page.evaluate(() =>
      (
        window as unknown as { fixture: { domains: { writes: number }[] } }
      ).fixture.domains.map((domain) => domain.writes),
    );
  expect(await writes()).toEqual([2, 0]);
  await page.getByRole("button", { name: "One consumer", exact: true }).click();
  await page.getByRole("button", { name: "Add from one", exact: true }).click();
  expect(await writes()).toEqual([4, 0]);
  await page.getByRole("button", { name: "Unmount all", exact: true }).click();
  await expect(page.getByLabel("one")).toHaveCount(0);
  // The Bunja adapter delays final cleanup by one timer tick.
  await expect
    .poll(() =>
      page.evaluate(
        () =>
          (window as unknown as { fixture: { cleanups: number } }).fixture
            .cleanups,
      ),
    )
    .toBe(1);
  await page.evaluate(() =>
    (
      window as unknown as {
        fixture: { lastStore: { selectMachine(id?: string): void } };
      }
    ).fixture.lastStore.selectMachine(undefined),
  );
  expect(await writes()).toEqual([4, 0]);
  await page.getByRole("button", { name: "Remount", exact: true }).click();
  await expect(page.getByLabel("one")).toHaveText("2");
  await expect(page.getByLabel("two")).toHaveText("2");
  await page
    .getByRole("button", { name: "Replace domain", exact: true })
    .click();
  await expect(page.getByLabel("one")).toHaveText("0");
  await expect(page.getByLabel("two")).toHaveText("0");
  await page.getByRole("button", { name: "Add from two", exact: true }).click();
  await expect(page.getByLabel("one")).toHaveText("1");
  expect(await writes()).toEqual([4, 2]);
});

test("explorer child observers wait for the shared Bunja owner and retain one subscription", async ({
  page,
}) => {
  await page.goto("/tests/fixtures/explorer.html");
  await expect(page.getByLabel("one")).toHaveText("Fixture root");
  await expect(page.getByLabel("two")).toHaveText("Fixture root");
  const metrics = () =>
    page.evaluate(
      () =>
        (
          window as unknown as {
            explorerFixture: {
              opens: number;
              closes: number;
              earlyCalls: number;
            };
          }
        ).explorerFixture,
    );
  expect(await metrics()).toEqual({ opens: 1, closes: 0, earlyCalls: 0 });
  await page
    .getByRole("button", { name: "Keep one owner", exact: true })
    .click();
  await expect(page.getByLabel("two")).toHaveCount(0);
  await expect(page.getByLabel("one")).toHaveText("Fixture root");
  expect(await metrics()).toEqual({ opens: 1, closes: 0, earlyCalls: 0 });
  await page
    .getByRole("button", { name: "Remove owners", exact: true })
    .click();
  await expect.poll(async () => (await metrics()).closes).toBe(1);
  expect(await metrics()).toEqual({ opens: 1, closes: 1, earlyCalls: 0 });
});

test("Jotai observes child mount writes and isolates Provider stores", async ({
  page,
}) => {
  await page.goto("/tests/fixtures/jotai.html");
  await expect(page.getByLabel("first", { exact: true })).toHaveText("1");
  await expect(page.getByLabel("second", { exact: true })).toHaveText("0");
  await page.getByRole("button", { name: "Increment first" }).click();
  await expect(page.getByLabel("first", { exact: true })).toHaveText("2");
  await expect(page.getByLabel("second", { exact: true })).toHaveText("0");
});

test("pane split and close preserve the controlled workbench layout", async ({
  page,
}) => {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.addInitScript(() => {
    localStorage.setItem(
      "rieul.machines.v1",
      JSON.stringify([
        { id: "A", name: "Fixture A", baseUrl: "https://a.invalid:9012" },
      ]),
    );
    localStorage.setItem("rieul.selected-machine-id.v1", "A");
  });
  await page.goto("/");
  await expect(
    page.getByRole("button", { name: "Pane actions", exact: true }),
  ).toHaveCount(1);
  await page.getByRole("button", { name: "Split right", exact: true }).click();
  await expect(
    page.getByRole("button", { name: "Pane actions", exact: true }),
  ).toHaveCount(2);
  await page
    .getByRole("button", { name: "Pane actions", exact: true })
    .last()
    .click();
  await page.getByRole("menuitem", { name: "Close pane", exact: true }).click();
  await expect(
    page.getByRole("button", { name: "Pane actions", exact: true }),
  ).toHaveCount(1);
  expect(errors).toEqual([]);
});

test("Solid atom bridge releases replaced atoms and stores and ignores stale writes", async ({
  page,
}) => {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto("/tests/fixtures/jotai.html");
  const result = page.getByLabel("replacement", { exact: true });
  const metrics = () =>
    page.evaluate(
      () =>
        (
          window as unknown as {
            atomFixture: { mounts: number; cleanups: number };
          }
        ).atomFixture,
    );
  await expect(result).toHaveText("10");
  await expect.poll(metrics).toEqual({ mounts: 1, cleanups: 0 });
  await page.getByRole("button", { name: "Replace atom", exact: true }).click();
  await expect(result).toHaveText("20");
  await expect.poll(metrics).toEqual({ mounts: 2, cleanups: 1 });
  await page
    .getByRole("button", { name: "Write stale atom", exact: true })
    .click();
  await expect(result).toHaveText("20");
  await page
    .getByRole("button", { name: "Replace store", exact: true })
    .click();
  await expect.poll(metrics).toEqual({ mounts: 3, cleanups: 2 });
  await page
    .getByRole("button", { name: "Write old store", exact: true })
    .click();
  await expect(result).toHaveText("20");
  await page
    .getByRole("button", { name: "Remove reader", exact: true })
    .click();
  await expect(result).toHaveCount(0);
  await expect.poll(metrics).toEqual({ mounts: 3, cleanups: 3 });
  expect(errors).toEqual([]);
});
