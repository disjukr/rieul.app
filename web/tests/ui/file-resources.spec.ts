import { expect, test } from "@playwright/test";

test("image object URL survives zoom and is revoked on final removal", async ({
  page,
}) => {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto("/tests/fixtures/file-resources.html");
  await page.getByRole("button", { name: "Show image", exact: true }).click();
  await expect(page.locator("img")).toBeVisible();
  await expect
    .poll(() =>
      page
        .locator("img")
        .evaluate((image: HTMLImageElement) => image.naturalWidth),
    )
    .toBe(1);
  const url = await page.locator("img").getAttribute("src");
  await page.getByRole("button", { name: "Zoom in", exact: true }).click();
  await expect(page.locator("img")).toHaveAttribute("src", url!);
  await page
    .getByRole("button", { name: "Remove viewer", exact: true })
    .click();
  await expect(page.locator("img")).toHaveCount(0);
  const urls = await page.evaluate(
    () =>
      (
        window as unknown as {
          fileResources: { created: string[]; revoked: string[] };
        }
      ).fileResources,
  );
  expect(urls.created).toEqual([url]);
  expect(urls.revoked).toEqual([url]);
  expect(errors).toEqual([]);
});

test("PDF worker renders a real page and removal cancels its DOM lifetime", async ({
  page,
}) => {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto("/tests/fixtures/file-resources.html");
  await page.getByRole("button", { name: "Show PDF", exact: true }).click();
  await expect(page.locator("canvas")).toHaveCount(1);
  await expect(
    page.getByText("Rendering 1/1 pages", { exact: true }),
  ).toHaveCount(0);
  expect(
    await page
      .locator("canvas")
      .evaluate((canvas: HTMLCanvasElement) => canvas.width),
  ).toBeGreaterThan(0);
  await page
    .getByRole("button", { name: "Remove viewer", exact: true })
    .click();
  await expect(page.locator("canvas")).toHaveCount(0);
  // Remove immediately after starting another load. Late worker resolution must
  // not restore a canvas or surface an unhandled error after owner disposal.
  await page.getByRole("button", { name: "Show PDF", exact: true }).click();
  await page
    .getByRole("button", { name: "Remove viewer", exact: true })
    .click();
  await expect(page.locator("canvas")).toHaveCount(0);
  expect(errors).toEqual([]);
});
