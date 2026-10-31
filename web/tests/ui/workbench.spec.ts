import { expect, test, type Page } from "@playwright/test";
const key = "rieul.workbench.A.v1";
test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => {
    Object.defineProperty(window, "WebTransport", {
      configurable: true,
      value: class {
        constructor() {
          throw new Error("offline fixture");
        }
      },
    });
    localStorage.setItem(
      "rieul.machines.v1",
      JSON.stringify([
        { id: "A", name: "Fixture A", baseUrl: "https://a.invalid:9012" },
      ]),
    );
    localStorage.setItem("rieul.selected-machine-id.v1", "A");
    localStorage.setItem(
      "rieul.workbench.A.v1",
      JSON.stringify({
        activePaneId: "p1",
        panes: [
          {
            id: "p1",
            activeTabId: "t1",
            tabs: [
              { id: "t1", tool: "files", title: "Root" },
              { id: "t2", tool: "daemon", title: "Daemon" },
            ],
          },
          {
            id: "p2",
            activeTabId: "t3",
            tabs: [{ id: "t3", tool: "files", title: "Root" }],
          },
        ],
        layout: {
          rootId: "root",
          nodes: {
            root: {
              type: "branch",
              id: "root",
              direction: "horizontal",
              children: ["n1", "n2"],
              ratios: [0.5, 0.5],
            },
            n1: { type: "leaf", id: "n1", paneId: "p1" },
            n2: { type: "leaf", id: "n2", paneId: "p2" },
          },
        },
      }),
    );
  });
});
async function state(page: Page) {
  return page.evaluate((key) => JSON.parse(localStorage.getItem(key)!), key);
}
test("pointer tab reorder and cross-pane drop use final pointer coordinates and preserve mounted tab DOM", async ({
  page,
}) => {
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  page.on("console", (m) => {
    if (m.type() === "warning" && m.text().includes("STRICT_"))
      errors.push(m.text());
  });
  await page.goto("/");
  const first = page.locator('[data-tab-id="t1"] [role="tab"]');
  const second = page.locator('[data-tab-id="t2"] [role="tab"]');
  await expect(first).toBeVisible();
  await first.evaluate(
    (el) => ((el as HTMLElement).dataset.identity = "retained"),
  );
  const a = (await first.boundingBox())!,
    b = (await second.boundingBox())!;
  await page.mouse.move(a.x + a.width / 2, a.y + a.height / 2);
  await page.mouse.down();
  await page.mouse.move(b.x + b.width - 2, b.y + b.height / 2, { steps: 5 });
  await page.mouse.up();
  await expect
    .poll(async () =>
      (await state(page)).panes[0].tabs.map((t: { id: string }) => t.id),
    )
    .toEqual(["t2", "t1"]);
  await expect(first).toHaveAttribute("data-identity", "retained");
  const target = page.locator('[data-tab-id="t3"] [role="tab"]');
  const c = (await first.boundingBox())!,
    d = (await target.boundingBox())!;
  await page.mouse.move(c.x + c.width / 2, c.y + c.height / 2);
  await page.mouse.down();
  await page.mouse.move(d.x + 2, d.y + d.height / 2, { steps: 5 });
  await page.mouse.up();
  await expect
    .poll(async () =>
      (await state(page)).panes[1].tabs.map((t: { id: string }) => t.id),
    )
    .toEqual(["t1", "t3"]);
  expect(errors).toEqual([]);
});
test("touch long press moves tabs and pointer plus keyboard resizing preserve layout ratios", async ({
  page,
}) => {
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  page.on("console", (m) => {
    if (m.type() === "warning" && m.text().includes("STRICT_"))
      errors.push(m.text());
  });
  await page.goto("/");
  const first = page.locator('[data-tab-id="t1"] [role="tab"]');
  const second = page.locator('[data-tab-id="t2"] [role="tab"]');
  await expect(first).toBeVisible();
  const a = (await first.boundingBox())!,
    b = (await second.boundingBox())!;
  await first.dispatchEvent("pointerdown", {
    pointerId: 7,
    pointerType: "touch",
    button: 0,
    clientX: a.x + 10,
    clientY: a.y + 10,
    bubbles: true,
  });
  await expect(page.locator("body")).toHaveClass(/workbench-tab-dnd-active/);
  await page.evaluate(
    ({ x, y }) =>
      document.dispatchEvent(
        new PointerEvent("pointermove", {
          pointerId: 7,
          pointerType: "touch",
          clientX: x,
          clientY: y,
          bubbles: true,
        }),
      ),
    { x: b.x + b.width - 2, y: b.y + b.height / 2 },
  );
  await page.evaluate(
    ({ x, y }) =>
      document.dispatchEvent(
        new PointerEvent("pointerup", {
          pointerId: 7,
          pointerType: "touch",
          clientX: x,
          clientY: y,
          bubbles: true,
        }),
      ),
    { x: b.x + b.width - 2, y: b.y + b.height / 2 },
  );
  await expect
    .poll(async () =>
      (await state(page)).panes[0].tabs.map((t: { id: string }) => t.id),
    )
    .toEqual(["t2", "t1"]);
  await expect(page.locator("body")).not.toHaveClass(
    /workbench-tab-dnd-active/,
  );
  const divider = page.getByRole("separator", { name: "Resize panes" });
  const r = (await divider.boundingBox())!;
  await page.mouse.move(r.x + r.width / 2, r.y + r.height / 2);
  await page.mouse.down();
  await page.mouse.move(r.x + 45, r.y + r.height / 2, { steps: 5 });
  await page.mouse.up();
  await expect
    .poll(async () => (await state(page)).layout.nodes.root.ratios[0])
    .toBeGreaterThan(0.5);
  const before = (await state(page)).layout.nodes.root.ratios[0];
  await divider.focus();
  await divider.press("ArrowLeft");
  await expect
    .poll(async () => (await state(page)).layout.nodes.root.ratios[0])
    .toBeLessThan(before);
  const ratios = (await state(page)).layout.nodes.root.ratios;
  expect(ratios[0] + ratios[1]).toBeCloseTo(1);
  expect(errors).toEqual([]);
});

test("body edge drops create a pane, whole pane movement preserves tabs, and Escape cancels pending drag", async ({
  page,
}) => {
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await page.goto("/");
  const tab = page.locator('[data-tab-id="t1"] [role="tab"]');
  await expect(tab).toBeVisible();
  const source = (await tab.boundingBox())!,
    pane = (await page.locator('section[data-pane-id="p2"]').boundingBox())!;
  await page.mouse.move(source.x + 15, source.y + 10);
  await page.mouse.down();
  await page.mouse.move(pane.x + pane.width - 15, pane.y + pane.height / 2, {
    steps: 5,
  });
  await page.mouse.up();
  await expect.poll(async () => (await state(page)).panes.length).toBe(3);
  const newPane = (await state(page)).panes.find(
    (p: { tabs: { id: string }[] }) => p.tabs.some((t) => t.id === "t1"),
  );
  expect(newPane.id).not.toBe("p1");
  const moving = page.locator(
    `section[data-pane-id="${newPane.id}"] [data-pane-drag]`,
  );
  const handle = (await moving.boundingBox())!;
  const destination = (await page
    .locator('section[data-pane-id="p1"]')
    .boundingBox())!;
  const previous = JSON.stringify((await state(page)).layout);
  await page.mouse.move(
    handle.x + handle.width / 2,
    handle.y + handle.height / 2,
  );
  await page.mouse.down();
  await page.mouse.move(
    destination.x + destination.width / 2,
    destination.y + destination.height - 20,
    { steps: 5 },
  );
  await page.mouse.up();
  await expect
    .poll(async () => JSON.stringify((await state(page)).layout))
    .not.toBe(previous);
  expect(
    (await state(page)).panes.find((p: { id: string }) => p.id === newPane.id)
      .tabs[0].id,
  ).toBe("t1");
  const updated = (await tab.boundingBox())!;
  const before = JSON.stringify((await state(page)).layout);
  await page.mouse.move(updated.x + 15, updated.y + 10);
  await page.mouse.down();
  await page.mouse.move(updated.x + 30, updated.y + 10);
  await expect(page.locator("body")).toHaveClass(/workbench-tab-dnd-active/);
  await page.keyboard.press("Escape");
  await page.mouse.up();
  await expect(page.locator("body")).not.toHaveClass(
    /workbench-tab-dnd-active/,
  );
  expect(JSON.stringify((await state(page)).layout)).toBe(before);
  expect(errors).toEqual([]);
});
