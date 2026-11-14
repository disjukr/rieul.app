import { expect, test, type Page } from "@playwright/test";

// Only the terminal rendering dependency is substituted. The real production
// component and static Bunja graph run without a daemon or real credentials.
const xtermModule = `
const metrics = window.terminalFixture;
export class Terminal {
  cols = 80; rows = 24;
  parser = { registerCsiHandler: () => ({ dispose() { metrics.parserDisposals++; } }) };
  constructor() { metrics.created++; }
  loadAddon(addon) { addon.activate?.(this); }
  open(host) { metrics.opened++; host.dataset.terminalOpened = "true"; }
  onData(callback) {
    window.terminalFixtureKey = callback;
    return { dispose() {
      metrics.inputDisposals++;
      if (window.terminalFixtureKey === callback) delete window.terminalFixtureKey;
    } };
  }
  attachCustomKeyEventHandler() {}
  reset() { this.output = ""; }
  resize(cols, rows) { this.cols = cols; this.rows = rows; }
  write(bytes, callback) {
    this.output = (this.output || "") + new TextDecoder().decode(bytes);
    window.terminalFixtureOutput = this.output;
    if (window.terminalFixtureHoldWrite) window.terminalFixtureApplyWrite = callback;
    else callback();
  }
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
        body: `
          export class FitAddon {
            activate(terminal) { this.terminal = terminal; }
            fit() {
              const size = window.terminalFixtureSize;
              if (size) this.terminal.resize(size.cols, size.rows);
              window.terminalFixtureFitCount = (window.terminalFixtureFitCount || 0) + 1;
            }
          }
          export default { FitAddon };
        `,
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
  page.on("console", (message) => {
    if (message.type() === "error") errors.push(message.text());
  });
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
  page.on("console", (message) => {
    if (message.type() === "error") errors.push(message.text());
  });
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
  page.on("console", (message) => {
    if (message.type() === "error") errors.push(message.text());
  });
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
  page.on("console", (message) => {
    if (message.type() === "error") errors.push(message.text());
  });
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

test("reattach uses the applied sequence and live lag requests a fresh screen", async ({
  page,
}) => {
  await fixture(page, false, "?resume");
  await expect(
    page.getByText("No machine selected", { exact: true }),
  ).toBeVisible();
  await page.getByRole("button", { name: "Select paired machine" }).click();
  await expect.poll(async () => (await metrics(page)).opened).toBe(1);
  const cursors = () =>
    page.evaluate(() => Reflect.get(window, "terminalResumeCursors"));
  const output = () =>
    page.evaluate(() => Reflect.get(window, "terminalFixtureOutput"));
  await expect.poll(cursors).toEqual([undefined]);
  await page.getByRole("button", { name: "Send snapshot" }).click();
  await expect.poll(output).toEqual("S");
  await page.evaluate(() =>
    Reflect.set(window, "terminalFixtureHoldWrite", true),
  );
  await page.getByRole("button", { name: "Send output" }).click();
  await expect.poll(output).toEqual("SR");
  await page.getByRole("button", { name: "Disconnect terminal" }).click();
  expect(await cursors()).toEqual([undefined]);
  await page.evaluate(() => Reflect.get(window, "terminalFixtureApplyWrite")());
  await expect.poll(cursors).toEqual([undefined, 6]);
  await expect.poll(output).toEqual("SR");
  await page.getByRole("button", { name: "Lag terminal" }).click();
  await expect.poll(cursors).toEqual([undefined, 6, undefined]);
});

interface TerminalControlFixture {
  attachRequests: Array<{ requestControl?: boolean }>;
  controlRequests: Array<{ viewportCols: number; viewportRows: number }>;
  inputRequests: Array<{ type: string }>;
  setFocused: (focused: boolean) => void;
  resize: (cols: number, rows: number) => void;
  completeAttach: (result: "granted" | "notAttempted" | "rejected") => void;
  completeControl: () => void;
  holdNextTransport: () => void;
  transportWaits: number;
  sendEvent: (event: Record<string, string | number>) => void;
}

async function controlFixture(page: Page) {
  await fixture(page, false, "?control");
  await page.getByRole("button", { name: "Select paired machine" }).click();
  await expect
    .poll(() =>
      page.evaluate(() =>
        (
          Reflect.get(
            window,
            "terminalControlFixture",
          ) as TerminalControlFixture
        ).attachRequests.map((request) => request.requestControl),
      ),
    )
    .toEqual([true]);
}

const controlRequests = (page: Page) =>
  page.evaluate(() => {
    const rpc: TerminalControlFixture = Reflect.get(
      window,
      "terminalControlFixture",
    );
    return rpc.controlRequests.map(({ viewportCols, viewportRows }) => [
      viewportCols,
      viewportRows,
    ]);
  });
const inputRequests = (page: Page) =>
  page.evaluate(() => {
    const rpc: TerminalControlFixture = Reflect.get(
      window,
      "terminalControlFixture",
    );
    return rpc.inputRequests.map(({ type }) => type);
  });

test("resize during delayed fallback reconciles the current pane size once", async ({
  page,
}) => {
  await controlFixture(page);
  await page.evaluate(() =>
    Reflect.get(window, "terminalControlFixture").completeAttach(
      "notAttempted",
    ),
  );
  await expect.poll(() => controlRequests(page)).toEqual([[80, 24]]);
  const oldFits = await page.evaluate(() =>
    Reflect.get(window, "terminalFixtureFitCount"),
  );
  await page.evaluate(() =>
    Reflect.get(window, "terminalControlFixture").resize(100, 30),
  );
  await expect
    .poll(() =>
      page.evaluate(() => Reflect.get(window, "terminalFixtureFitCount")),
    )
    .toBeGreaterThan(oldFits);
  expect(await controlRequests(page)).toEqual([[80, 24]]);
  await page.evaluate(() => {
    const rpc: TerminalControlFixture = Reflect.get(
      window,
      "terminalControlFixture",
    );
    rpc.sendEvent({ type: "pseudoTerminalResized", cols: 80, rows: 24 });
    rpc.completeControl();
  });
  await expect
    .poll(() => controlRequests(page))
    .toEqual([
      [80, 24],
      [100, 30],
    ]);
  await page.evaluate(() =>
    Reflect.get(window, "terminalControlFixture").completeControl(),
  );
  await expect(page.getByText("100 x 30")).toBeVisible();
  expect(await controlRequests(page)).toEqual([
    [80, 24],
    [100, 30],
  ]);
});

test("active matching attach grant starts input without taking control again", async ({
  page,
}) => {
  await controlFixture(page);
  await page.evaluate(() => {
    const rpc: TerminalControlFixture = Reflect.get(
      window,
      "terminalControlFixture",
    );
    rpc.completeAttach("granted");
  });
  await expect(
    page.getByText("Waiting for terminal", { exact: true }),
  ).toHaveCount(0);
  await page.evaluate(() => Reflect.get(window, "terminalFixtureKey")("x"));
  await expect
    .poll(() => inputRequests(page))
    .toEqual(["writeTerminalInputStart", "writeTerminalInputChunk"]);
  expect(await controlRequests(page)).toEqual([]);
});

test("attach refusal survives focus, resize and xterm input", async ({
  page,
}) => {
  await controlFixture(page);
  await page.evaluate(() =>
    Reflect.get(window, "terminalControlFixture").completeAttach("rejected"),
  );
  await expect(
    page.getByText("Fixture refused terminal control"),
  ).toBeVisible();
  await page.evaluate(() =>
    Reflect.get(window, "terminalControlFixture").setFocused(false),
  );
  await page.evaluate(() =>
    Reflect.get(window, "terminalControlFixture").setFocused(true),
  );
  const oldFits = await page.evaluate(() =>
    Reflect.get(window, "terminalFixtureFitCount"),
  );
  await page.evaluate(() => {
    Reflect.get(window, "terminalControlFixture").resize(100, 30);
    Reflect.get(window, "terminalFixtureKey")("x");
  });
  await expect
    .poll(() =>
      page.evaluate(() => Reflect.get(window, "terminalFixtureFitCount")),
    )
    .toBeGreaterThan(oldFits);
  await expect(
    page.getByText("Fixture refused terminal control"),
  ).toBeVisible();
  expect(await inputRequests(page)).toEqual([]);
  expect(await controlRequests(page)).toEqual([]);
});

for (const cancel of [false, true]) {
  test(`${cancel ? "canceled" : "blurred"} pending attach grant never sends queued input`, async ({
    page,
  }) => {
    await controlFixture(page);
    await page.evaluate(() => {
      Reflect.get(window, "terminalControlFixture").setFocused(false);
      Reflect.get(window, "terminalFixtureKey")("x");
    });
    if (cancel)
      await page.getByRole("button", { name: "Remove terminal" }).click();
    await page.evaluate((unmounted) => {
      const rpc: TerminalControlFixture = Reflect.get(
        window,
        "terminalControlFixture",
      );
      try {
        rpc.completeAttach("granted");
      } catch (error) {
        // Aborting the actual component cancels the mock readable stream.
        if (!unmounted || !(error instanceof TypeError)) throw error;
      }
    }, cancel);
    if (!cancel) {
      await expect(
        page.getByText("Waiting for terminal", { exact: true }),
      ).toHaveCount(0);
      await page.evaluate(() => Reflect.get(window, "terminalFixtureKey")("y"));
    }
    expect(await inputRequests(page)).toEqual([]);
    expect(await controlRequests(page)).toEqual([]);
  });
}

test("a later control stream event wins over a stale unary control response", async ({
  page,
}) => {
  await controlFixture(page);
  await page.evaluate(() =>
    Reflect.get(window, "terminalControlFixture").completeAttach(
      "notAttempted",
    ),
  );
  await expect.poll(() => controlRequests(page)).toEqual([[80, 24]]);
  await page.evaluate(() => {
    const rpc: TerminalControlFixture = Reflect.get(
      window,
      "terminalControlFixture",
    );
    rpc.sendEvent({ type: "controlChanged", primaryAttachId: "another" });
    rpc.sendEvent({ type: "pseudoTerminalResized", cols: 77, rows: 21 });
  });
  await expect(page.getByText("77 x 21")).toBeVisible();
  await page.evaluate(() =>
    Reflect.get(window, "terminalControlFixture").completeControl(),
  );
  await page.evaluate(() => Reflect.get(window, "terminalFixtureKey")("x"));
  await expect
    .poll(() => controlRequests(page))
    .toEqual([
      [80, 24],
      [77, 21],
    ]);
  expect(await inputRequests(page)).toEqual([]);
});

for (const loseOwnershipDuringTransport of [false, true]) {
  test(
    loseOwnershipDuringTransport
      ? "deferred resize survives ownership loss during its transport wait"
      : "deferred resize waits for authoritative self ownership after an ignored unary reply",
    async ({ page }) => {
      await controlFixture(page);
      await page.evaluate(() =>
        Reflect.get(window, "terminalControlFixture").completeAttach(
          "notAttempted",
        ),
      );
      await expect.poll(() => controlRequests(page)).toEqual([[80, 24]]);
      const oldFits = await page.evaluate(() =>
        Reflect.get(window, "terminalFixtureFitCount"),
      );
      await page.evaluate(() =>
        Reflect.get(window, "terminalControlFixture").resize(100, 30),
      );
      await expect
        .poll(() =>
          page.evaluate(() => Reflect.get(window, "terminalFixtureFitCount")),
        )
        .toBeGreaterThan(oldFits);
      await page.evaluate(() => {
        const rpc: TerminalControlFixture = Reflect.get(
          window,
          "terminalControlFixture",
        );
        rpc.sendEvent({ type: "controlChanged", primaryAttachId: "another" });
        rpc.sendEvent({ type: "pseudoTerminalResized", cols: 77, rows: 21 });
      });
      await expect(page.getByText("77 x 21")).toBeVisible();
      await page.evaluate(async () => {
        Reflect.get(window, "terminalControlFixture").completeControl();
        await new Promise(requestAnimationFrame);
      });
      expect(await controlRequests(page)).toEqual([[80, 24]]);
      await expect(page.getByText("77 x 21")).toBeVisible();
      if (loseOwnershipDuringTransport) {
        await page.evaluate(() => {
          const rpc: TerminalControlFixture = Reflect.get(
            window,
            "terminalControlFixture",
          );
          rpc.holdNextTransport();
          rpc.sendEvent({ type: "controlChanged", primaryAttachId: "attach" });
          rpc.sendEvent({ type: "controlChanged", primaryAttachId: "attach" });
        });
        await expect
          .poll(() =>
            page.evaluate(
              () =>
                Reflect.get(window, "terminalControlFixture").transportWaits,
            ),
          )
          .toBe(1);
        expect(await controlRequests(page)).toEqual([[80, 24]]);
        await page.evaluate(() => {
          const rpc: TerminalControlFixture = Reflect.get(
            window,
            "terminalControlFixture",
          );
          rpc.sendEvent({ type: "controlChanged", primaryAttachId: "another" });
          rpc.sendEvent({ type: "pseudoTerminalResized", cols: 66, rows: 20 });
        });
        await expect(page.getByText("66 x 20")).toBeVisible();
        await page.evaluate(async () => {
          Reflect.get(window, "terminalControlFixture").releaseTransport();
          await new Promise(requestAnimationFrame);
        });
        expect(await controlRequests(page)).toEqual([[80, 24]]);
        await expect(page.getByText("66 x 20")).toBeVisible();
      }
      await page.evaluate(() => {
        const rpc: TerminalControlFixture = Reflect.get(
          window,
          "terminalControlFixture",
        );
        rpc.sendEvent({ type: "controlChanged", primaryAttachId: "attach" });
        rpc.sendEvent({ type: "pseudoTerminalResized", cols: 80, rows: 24 });
        rpc.sendEvent({ type: "controlChanged", primaryAttachId: "attach" });
      });
      await expect
        .poll(() => controlRequests(page))
        .toEqual([
          [80, 24],
          [100, 30],
        ]);
      await page.evaluate(() =>
        Reflect.get(window, "terminalControlFixture").completeControl(),
      );
      await expect(page.getByText("100 x 30")).toBeVisible();
      expect(await controlRequests(page)).toEqual([
        [80, 24],
        [100, 30],
      ]);
    },
  );
}
