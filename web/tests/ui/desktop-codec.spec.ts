import { test, expect } from "@playwright/test";
test("VideoToolbox synthetic hardware H.264 traverses group framing and real WebCodecs", async ({
  page,
}) => {
  await page.goto("/tests/fixtures/desktop-codec.html");
  const result = page.getByLabel("Decoder result");
  await expect(result).not.toHaveText("pending");
  test.skip(
    (await result.textContent()) === "unsupported",
    "This browser does not implement the fixture H.264 codec; production negotiation reports unsupported.",
  );
  await expect(result).toContainText('"count":2');
  const decoded = JSON.parse((await result.textContent())!);
  expect(decoded.width).toBe(640);
  expect(decoded.height).toBe(480);
  expect(decoded.pixel[3]).toBe(255);
  expect(Math.max(...decoded.pixel.slice(0, 3))).toBeLessThan(8);
});
