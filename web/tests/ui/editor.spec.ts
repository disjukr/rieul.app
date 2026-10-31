import { expect, test } from "@playwright/test";
test("Monaco preserves its model through editing and prop updates and disposes on unmount", async ({
  page,
}) => {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto("/tests/fixtures/editor.html");
  const models = () =>
    page.evaluate(() =>
      (
        window as unknown as {
          editorFixture: {
            models(): { id: string; text: string; language: string }[];
          };
        }
      ).editorFixture.models(),
    );
  await expect.poll(async () => (await models()).length).toBe(1);
  const id = (await models())[0].id;
  await page.evaluate(() =>
    (
      window as unknown as { editorFixture: { edit(text: string): void } }
    ).editorFixture.edit("typed text"),
  );
  await expect(page.getByLabel("draft", { exact: true })).toHaveText(
    "typed text",
  );
  expect((await models())[0].id).toBe(id);
  await page.getByRole("button", { name: "Replace text", exact: true }).click();
  await expect
    .poll(async () => (await models())[0].text)
    .toBe("external update");
  await page.getByRole("button", { name: "Replace path", exact: true }).click();
  await expect.poll(async () => (await models())[0].language).toBe("json");
  expect((await models())[0].id).toBe(id);
  await page
    .getByRole("button", { name: "Remove editor", exact: true })
    .click();
  await expect.poll(models).toEqual([]);
  expect(errors).toEqual([]);
});
