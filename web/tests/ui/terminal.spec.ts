import { expect, test, type Page } from "@playwright/test";

// Only the terminal rendering dependency is substituted. The real production
// component and static Bunja graph run without a daemon or real credentials.
const xtermModule = `
const metrics = window.terminalFixture;
export class Terminal {
  cols = 80; rows = 24;
  parser = { registerCsiHandler: () => ({ dispose() { metrics.parserDisposals++; } }) };
  constructor() { metrics.created++; }
  loadAddon() {}
  open(host) { metrics.opened++; host.dataset.terminalOpened = "true"; }
  onData() { return { dispose() { metrics.inputDisposals++; } }; }
  attachCustomKeyEventHandler() {}
  reset() {}
  dispose() { metrics.disposed++; }
}
export default { Terminal };
`;
const metrics = (page: Page) =>
  page.evaluate(
    () =>
      (
        window as unknown as {
          terminalFixture: {
            created: number;
            opened: number;
            disposed: number;
            inputDisposals: number;
            parserDisposals: number;
          };
        }
      ).terminalFixture,
  );
async function fixture(page: Page, delayed = false, query = "") {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  let requested!: () => void;
  const request = new Promise<void>((resolve) => {
    requested = resolve;
  });
  await page.addInitScript(() =>
    Object.assign(window, {
      terminalFixture: {
        created: 0,
        opened: 0,
        disposed: 0,
        inputDisposals: 0,
        parserDisposals: 0,
      },
    }),
  );
  await page.route(/@xterm.*\.js(?:\?|$)/, async (route) => {
    if (route.request().url().includes("addon")) {
      await route.fulfill({
        contentType: "application/javascript",
        body: "export class FitAddon { fit() {} }; export default { FitAddon };",
      });
      return;
    }
    requested();
    if (delayed) await gate;
    await route.fulfill({
      contentType: "application/javascript",
      body: xtermModule,
    });
  });
  await page.goto(`/tests/fixtures/terminal.html${query}`);
  return { request, release };
}

test("terminal initializes after conditional host insertion and disposes on selection loss and final removal", async ({
  page,
}) => {
  const errors: string[] = [];
  page.on("pageerror", (error) => {
    errors.push(error.message);
  });
  await fixture(page);
  await expect(
    page.getByText("No machine selected", { exact: true }),
  ).toBeVisible();
  expect((await metrics(page)).created).toBe(0);
  await page
    .getByRole("button", { name: "Select paired machine", exact: true })
    .click();
  await expect(page.locator('[data-terminal-opened="true"]')).toHaveCount(1);
  expect((await metrics(page)).created).toBe(1);
  await page
    .getByRole("button", { name: "Clear selection", exact: true })
    .click();
  await expect.poll(async () => (await metrics(page)).disposed).toBe(1);
  await page
    .getByRole("button", { name: "Select paired machine", exact: true })
    .click();
  await expect.poll(async () => (await metrics(page)).opened).toBe(2);
  await page
    .getByRole("button", { name: "Remove terminal", exact: true })
    .click();
  await expect.poll(metrics.bind(null, page)).toEqual({
    created: 2,
    opened: 2,
    disposed: 2,
    inputDisposals: 2,
    parserDisposals: 10,
  });
  expect(errors).toEqual([]);
});

test("late xterm import cannot initialize a removed host and remount creates one live runtime", async ({
  page,
}) => {
  const errors: string[] = [];
  page.on("pageerror", (error) => {
    errors.push(error.message);
  });
  const { request, release } = await fixture(page, true);
  await page
    .getByRole("button", { name: "Select paired machine", exact: true })
    .click();
  await request;
  await page
    .getByRole("button", { name: "Remove terminal", exact: true })
    .click();
  release();
  await page
    .getByRole("button", { name: "Remount terminal", exact: true })
    .click();
  await expect.poll(async () => (await metrics(page)).opened).toBe(1);
  expect((await metrics(page)).created).toBe(1);
  await page
    .getByRole("button", { name: "Remove terminal", exact: true })
    .click();
  await expect.poll(async () => (await metrics(page)).disposed).toBe(1);
  expect(errors).toEqual([]);
});

test("late terminal creation after unmount closes the orphan session without updating the tab", async ({
  page,
}) => {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await fixture(page, false, "?late-create");
  const rpc = () =>
    page.evaluate(
      () =>
        (
          window as unknown as {
            terminalRpcFixture: {
              creates: number;
              closes: number;
              tabWrites: number;
            };
          }
        ).terminalRpcFixture,
    );
  await page
    .getByRole("button", { name: "Select paired machine", exact: true })
    .click();
  await expect.poll(async () => (await rpc()).creates).toBe(1);
  await page
    .getByRole("button", { name: "Remove terminal", exact: true })
    .click();
  await page
    .getByRole("button", { name: "Resolve pending creation", exact: true })
    .click();
  await expect
    .poll(rpc)
    .toEqual({ creates: 1, closes: 1, tabWrites: 0, attaches: 0 });
  expect(errors).toEqual([]);
});

test("terminal session persistence and title updates do not restart the current attachment", async ({
  page,
}) => {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await fixture(page, false, "?late-create");
  const rpc = () =>
    page.evaluate(
      () =>
        (
          window as unknown as {
            terminalRpcFixture: {
              creates: number;
              closes: number;
              tabWrites: number;
              attaches: number;
            };
          }
        ).terminalRpcFixture,
    );
  await page
    .getByRole("button", { name: "Select paired machine", exact: true })
    .click();
  await expect.poll(async () => (await rpc()).creates).toBe(1);
  await page
    .getByRole("button", { name: "Resolve pending creation", exact: true })
    .click();
  await expect
    .poll(rpc)
    .toEqual({ creates: 1, closes: 0, tabWrites: 1, attaches: 1 });
  await page
    .getByRole("button", { name: "Publish terminal title", exact: true })
    .click();
  // Two animation frames let atom writes and dependent effects settle.
  await page.evaluate(
    () =>
      new Promise<void>((resolve) =>
        requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
      ),
  );
  expect(await rpc()).toEqual({
    creates: 1,
    closes: 0,
    tabWrites: 1,
    attaches: 1,
  });
  expect((await metrics(page)).created).toBe(1);
  await page
    .getByRole("button", { name: "Remove terminal", exact: true })
    .click();
  await expect.poll(async () => (await metrics(page)).disposed).toBe(1);
  expect(errors).toEqual([]);
});
