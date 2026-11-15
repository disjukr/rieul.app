import { test, expect } from "@playwright/test";
import { rpcCategoryById } from "../../src/protocol/rpc-support";

const screenTotal = Object.values(rpcCategoryById).filter(
  (category) => category === "screen",
).length;
const screenSupported = new Set([66, 66, 67, 68]).size;
const screenUnsupported = screenTotal - screenSupported;
const screenPercent = Math.round((screenSupported / screenTotal) * 100);

test("category donuts expose denominator and every supported/unsupported RPC with keyboard details", async ({
  page,
}, testInfo) => {
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  page.on("console", (m) => {
    if (m.text().includes("STRICT_")) errors.push(m.text());
  });
  for (const width of [1440, 390]) {
    await page.setViewportSize({ width, height: 1000 });
    await page.goto("/tests/fixtures/rpc-support.html");
    const section = page.getByRole("region", {
      name: "RPC support",
      exact: true,
    });
    await expect(section.getByRole("article")).toHaveCount(9);
    const screen = page.getByRole("article", {
      name: "Screen RPC support",
      exact: true,
    });
    await expect(screen.getByText(`${screenPercent}% supported`)).toBeVisible();
    await expect(
      screen.getByText(`${screenSupported} of ${screenTotal} RPCs`),
    ).toBeVisible();
    await expect(
      screen.getByText(`${screenUnsupported} not supported`),
    ).toBeVisible();
    const files = page.getByRole("article", {
      name: "Files RPC support",
      exact: true,
    });
    await expect(files.getByText("80% supported")).toBeVisible();
    await expect(files.getByText("8 of 10 RPCs")).toBeVisible();
    const summary = screen.locator("summary");
    await summary.focus();
    await expect(summary).toBeFocused();
    await summary.hover();
    await page.keyboard.press("Enter");
    await expect(screen.getByRole("listitem")).toHaveCount(screenTotal);
    await expect(screen.getByText("Supported", { exact: true })).toHaveCount(
      screenSupported,
    );
    await expect(
      screen.getByText("Not supported", { exact: true }),
    ).toHaveCount(screenUnsupported);
    await expect(
      screen.getByText("WriteDesktopInput", { exact: true }),
    ).toBeVisible();
    const unknown = page.getByText("Other advertised RPCs (2)", {
      exact: true,
    });
    await unknown.click();
    await expect(page.getByText("RPC 999", { exact: true })).toBeVisible();
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth,
      ),
    ).toBe(true);
    await expect(screen).toMatchAriaSnapshot(`
      - article "Screen RPC support":
        - heading "Screen" [level=3]
        - strong: ${screenPercent}% supported
        - text: ${screenSupported} of ${screenTotal} RPCs ${screenUnsupported} not supported
        - group:
          - text: View Screen RPCs
          - list:
            - listitem:
              - code: GetDesktopCapabilities
              - text: RPC 66 Supported
            - listitem:
              - code: AttachDesktop
              - text: RPC 67 Supported
            - listitem:
              - code: ConfigureDesktopViewports
              - text: RPC 68 Supported
            - listitem:
              - code: SetDesktopControl
              - text: RPC 69 Not supported
            - listitem:
              - code: RenewDesktopLease
              - text: RPC 70 Not supported
            - listitem:
              - code: DetachDesktop
              - text: RPC 71 Not supported
            - listitem:
              - code: WriteDesktopInput
              - text: RPC 72 Not supported
            - listitem:
              - code: GetDesktopLayoutCapabilities
              - text: RPC 101 Not supported
            - listitem:
              - code: AttachDesktopWithLayout
              - text: RPC 102 Not supported
            - listitem:
              - code: ConfigureDesktopLayout
              - text: RPC 103 Not supported
            - listitem:
              - code: AttachExistingDesktop
              - text: RPC 104 Not supported
            - listitem:
              - code: QueryDesktopQualitySupport
              - text: RPC 105 Not supported
            - listitem:
              - code: SetDesktopQuality
              - text: RPC 106 Not supported
            - listitem:
              - code: SelectExistingDesktop
              - text: RPC 107 Not supported
    `);
    await screen.scrollIntoViewIfNeeded();
    await screen.screenshot({
      path: testInfo.outputPath(`screen-rpcs-${width}.png`),
    });
    await page.screenshot({
      path: testInfo.outputPath(`rpc-support-${width}.png`),
      fullPage: true,
    });
  }
  expect(errors).toEqual([]);
});

test("unknown, zero and full support stay distinct across reactive changes", async ({
  page,
}) => {
  await page.goto("/tests/fixtures/rpc-support.html");
  const screen = page.getByRole("article", {
    name: "Screen RPC support",
    exact: true,
  });
  await page.getByRole("button", { name: "Information unavailable" }).click();
  await expect(page.getByRole("status")).toContainText("not available yet");
  await expect(
    screen.getByText("Unknown", { exact: true }).first(),
  ).toBeVisible();
  await expect(screen.getByText("0% supported", { exact: true })).toHaveCount(
    0,
  );
  await page.getByRole("button", { name: "None supported" }).click();
  await expect(screen.getByText(`0 of ${screenTotal} RPCs`)).toBeVisible();
  await screen.locator("summary").click();
  await expect(screen.getByText("Not supported", { exact: true })).toHaveCount(
    screenTotal,
  );
  await page.getByRole("button", { name: "All supported" }).click();
  await expect(screen.getByText("100% supported")).toBeVisible();
  await expect(
    screen.getByText(`${screenTotal} of ${screenTotal} RPCs`),
  ).toBeVisible();
  await screen.locator("summary").click();
  await expect(screen.getByText("Supported", { exact: true })).toHaveCount(
    screenTotal,
  );
  await expect(page.getByText(/Other advertised RPCs/)).toHaveCount(0);
});
