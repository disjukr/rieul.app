import { test, expect, type Page } from "@playwright/test";
const metrics = (page: Page) =>
  page.evaluate(
    () =>
      (
        window as unknown as {
          agentFixture: {
            transports: number;
            subscriptions: number;
            tabWrites: number;
          };
        }
      ).agentFixture,
  );
test("agent does not subscribe when a pending transport resolves after removal", async ({
  page,
}) => {
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await page.goto("/tests/fixtures/agent.html");
  await expect.poll(async () => (await metrics(page)).transports).toBe(1);
  await page.getByRole("button", { name: "Remove agent", exact: true }).click();
  await page
    .getByRole("button", { name: "Resolve oldest transport", exact: true })
    .click();
  expect((await metrics(page)).subscriptions).toBe(0);
  expect(errors).toEqual([]);
});
test("agent session replacement rejects old transport and composer input updates before blur", async ({
  page,
}) => {
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await page.goto("/tests/fixtures/agent.html");
  await expect.poll(async () => (await metrics(page)).transports).toBe(1);
  await page
    .getByRole("button", { name: "Select session B", exact: true })
    .click();
  await expect.poll(async () => (await metrics(page)).transports).toBe(2);
  await page
    .getByRole("button", { name: "Resolve oldest transport", exact: true })
    .click();
  expect((await metrics(page)).subscriptions).toBe(0);
  await page
    .getByRole("button", { name: "Resolve oldest transport", exact: true })
    .click();
  await expect.poll(async () => (await metrics(page)).subscriptions).toBe(1);
  const composer = page.getByRole("textbox", {
    name: "Message agent",
    exact: true,
  });
  await expect(composer).toBeEnabled();
  await composer.fill("Draft before blur");
  await expect(composer).toBeFocused();
  await expect(
    page.getByRole("button", { name: "Send message", exact: true }),
  ).toBeEnabled();
  expect(errors).toEqual([]);
});
