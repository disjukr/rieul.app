import { expect, test } from "@playwright/test";

test("compiled styles retain dynamic values, compound variants and interaction states", async ({
  page,
}) => {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto("/tests/fixtures/styling.html");
  const button = page.getByTestId("button");
  await expect(button).toHaveCSS("min-height", "34px");
  await expect(button).toHaveCSS("background-color", "rgb(255, 255, 255)");
  await expect(page.getByTestId("bar")).toHaveCSS("width", "40px");
  await button.hover();
  await expect(button).toHaveCSS("background-color", "rgb(247, 250, 255)");
  await page.getByRole("button", { name: "Change styles" }).click();
  await expect(button).toHaveCSS("min-height", "28px");
  await expect(button).toHaveCSS("background-color", "rgb(255, 244, 242)");
  await expect(page.getByTestId("bar")).toHaveCSS("width", "120px");
  await expect(page.getByTestId("badge")).toHaveCSS("color", "rgb(2, 122, 72)");
  await expect(page.getByTestId("disabled")).toBeDisabled();
  await expect(page.getByTestId("disabled")).toHaveCSS("opacity", "0.48");
  await page.keyboard.press("Tab");
  await expect(button).toBeFocused();
  await expect(button).toHaveCSS("outline-width", "2px");
  expect(errors).toEqual([]);
});
