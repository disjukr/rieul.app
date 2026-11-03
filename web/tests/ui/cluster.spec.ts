import { test, expect } from "@playwright/test";
test("cluster creation names full trust before confirmation; unsupported enrollment exposes no action", async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/tests/fixtures/cluster.html");
  const create = page.getByRole("button", { name: "Create cluster…" });
  await create.focus();
  await expect(create).toBeFocused();
  await create.hover();
  await create.click();
  await expect(
    page.getByRole("region", { name: "Cluster", exact: true }),
  ).toContainText(
    "Clients paired with any member receive full access to all members",
  );
  await expect(
    page.getByRole("region", { name: "Cluster", exact: true }),
  ).toContainText("Existing local pairings will be adopted automatically");
  await page.getByRole("button", { name: "Cancel", exact: true }).click();
  await expect(
    page.getByRole("button", { name: "Confirm", exact: true }),
  ).toHaveCount(0);
  await page.evaluate(() =>
    (
      window as unknown as { clusterFixture: { unsupported(): void } }
    ).clusterFixture.unsupported(),
  );
  await expect(
    page.getByRole("region", { name: "Cluster", exact: true }),
  ).toContainText("not supported");
  await expect(page.getByRole("button")).toHaveCount(0);
});
