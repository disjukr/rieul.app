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

async function navigatePath(
  page: import("@playwright/test").Page,
  path: string,
) {
  // Click blank breadcrumb space to enter an explicit path.
  const crumbs = page.locator('div[aria-label="Path"]');
  await crumbs.dispatchEvent("mousedown", { bubbles: true });
  await page.getByRole("textbox", { name: "Path", exact: true }).fill(path);
  await page.getByRole("textbox", { name: "Path", exact: true }).press("Enter");
}
async function savedLocation(page: import("@playwright/test").Page) {
  return page.evaluate(
    () =>
      JSON.parse(
        localStorage.getItem("rieul.explorer.navigation.fixture.tab.v2") ??
          "null",
      )?.location,
  );
}
for (const mode of ["empty", "pending"]) {
  test(`${mode} Home is superseded by manual navigation and Back/Up`, async ({
    page,
  }) => {
    await page.goto(`/tests/fixtures/files-locations.html?${mode}`);
    await expect(
      page.getByText(
        mode === "empty"
          ? "No logged-in user home is available."
          : "Opening home…",
        { exact: true },
      ),
    ).toBeVisible();
    await navigatePath(page, "/Users/chosen/first");
    await expect(page.getByRole("alert")).toHaveCount(0);
    await expect(page.getByText("Opening home…", { exact: true })).toHaveCount(
      0,
    );
    await expect
      .poll(() => savedLocation(page))
      .toEqual({ type: "directory", path: "/Users/chosen/first" });
    if (mode === "pending") {
      await page.evaluate(async () => {
        (window as any).finishHome();
        await new Promise((resolve) => setTimeout(resolve, 0));
      });
      await expect
        .poll(() => savedLocation(page))
        .toEqual({ type: "directory", path: "/Users/chosen/first" });
    }
    await navigatePath(page, "/Users/chosen/second");
    await page.getByRole("button", { name: "Back", exact: true }).click();
    await expect
      .poll(() => savedLocation(page))
      .toEqual({ type: "directory", path: "/Users/chosen/first" });
    await page.getByRole("button", { name: "Up", exact: true }).click();
    await expect
      .poll(() => savedLocation(page))
      .toEqual({ type: "directory", path: "/Users/chosen" });
    await expect(page.getByRole("button", { name: "Retry home" })).toHaveCount(
      0,
    );
    expect(await page.evaluate(() => (window as any).filesFixture.home)).toBe(
      1,
    );
  });
}
