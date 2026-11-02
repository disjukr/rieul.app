import { expect, test } from "@playwright/test";
test("Home resolves the daemon user path and reports an empty home with retry", async ({
  page,
}) => {
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await page.goto("/tests/fixtures/files-locations.html?empty");
  await expect(page.getByRole("alert")).toContainText("No logged-in user home");
  await page.getByRole("button", { name: "Retry home" }).click();
  await expect(page.getByRole("alert")).toHaveCount(0);
  await expect(
    page.getByText("fixture", { exact: true }).first(),
  ).toBeVisible();
  await expect
    .poll(() =>
      page.evaluate(
        () =>
          JSON.parse(
            localStorage.getItem("rieul.explorer.navigation.fixture.tab.v2") ??
              "null",
          )?.location,
      ),
    )
    .toEqual({ type: "directory", path: "/Users/fixture" });
  expect(errors).toEqual([]);
});
test("Trash opens its stream and read-only rows never expose destructive actions", async ({
  page,
}) => {
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await page.goto("/tests/fixtures/files-locations.html?view=trash");
  await expect(page.getByRole("grid", { name: "Trash" })).toContainText(
    "discarded.txt",
  );
  await expect(
    page.getByText("1 items · Read only; restore is unavailable"),
  ).toBeVisible();
  await page.getByRole("row").click({ button: "right" });
  await expect(
    page.getByText("Delete permanently", { exact: true }),
  ).toHaveCount(0);
  await expect(page.getByText("Restore", { exact: true })).toHaveCount(0);
  expect(await page.evaluate(() => (window as any).filesFixture)).toEqual({
    home: 0,
    trash: 1,
    mutation: 0,
  });
  expect(errors).toEqual([]);
});
