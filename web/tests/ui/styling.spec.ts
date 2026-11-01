import { expect, test } from "@playwright/test";

test("production CSS chunks preserve default button variants above the reset", async ({
  page,
}) => {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.addInitScript(() =>
    Object.defineProperty(window, "WebTransport", {
      configurable: true,
      value: class {
        constructor() {
          throw new Error("offline styling fixture");
        }
      },
    }),
  );
  await page.goto("http://127.0.0.1:5186");
  await page
    .getByRole("textbox", { name: "Machine name" })
    .fill("Style fixture");
  await page
    .getByRole("textbox", { name: "Machine URL" })
    .fill("fixture.invalid");
  await page.getByRole("button", { name: "Continue", exact: true }).click();
  const button = page.getByRole("button", { name: "Skip", exact: true });
  await expect(button).toHaveCSS("background-color", "rgb(255, 255, 255)");
  await expect(button).toHaveCSS("min-height", "34px");
  await button.hover();
  await expect(button).toHaveCSS("background-color", "rgb(247, 250, 255)");
  expect(errors).toEqual([]);
});

test("desktop popup receives styles, theme changes and stylesheet updates without retaining observers", async ({
  page,
}) => {
  await page.goto("/tests/fixtures/popup-styles.html");
  const opened = page.waitForEvent("popup");
  await page.getByRole("button", { name: "Open styled popup" }).click();
  const popup = await opened;
  const canvas = popup.getByLabel("Remote display fixture");
  await expect(canvas).toHaveCSS("display", "block");
  await expect(canvas).toHaveCSS("background-color", "rgb(16, 24, 40)");
  await expect(canvas).toHaveCSS("touch-action", "none");
  await page.evaluate(() => {
    document.documentElement.style.setProperty(
      "--rieul-bg-inverse",
      "rgb(20, 30, 40)",
    );
    const style = document.createElement("style");
    style.id = "popup-update";
    style.textContent = ".rieul-desktop-canvas { border: 3px solid red; }";
    document.head.append(style);
  });
  await expect(canvas).toHaveCSS("background-color", "rgb(20, 30, 40)");
  await expect(canvas).toHaveCSS("border-top-width", "3px");
  await page.evaluate(() => document.getElementById("popup-update")!.remove());
  await expect(canvas).toHaveCSS("border-top-width", "0px");
  await page.getByRole("button", { name: "Stop stylesheet sync" }).click();
  await expect(
    popup.locator("head style, head link[rel=stylesheet]"),
  ).toHaveCount(0);
  await page.evaluate(() => {
    document.documentElement.style.setProperty(
      "--rieul-bg-inverse",
      "rgb(50, 60, 70)",
    );
    document.head.append(document.createElement("style"));
  });
  expect(await popup.locator("html").getAttribute("style")).toContain(
    "rgb(20, 30, 40)",
  );
  await expect(
    popup.locator("head style, head link[rel=stylesheet]"),
  ).toHaveCount(0);
  await popup.close();
});

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
