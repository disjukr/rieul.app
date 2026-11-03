import type { ClusterRecord } from "../../src/cluster/storage.ts";
import type { ClusterHistory } from "../../src/protocol/generated/rpc.ts";
declare global {
  interface Window {
    expiryDecision: ClusterRecord;
    revokedHistory: ClusterHistory;
  }
}
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

test("another tab's revocation fences automatic expired-grant renewal", async ({
  page,
  context,
}) => {
  await page.goto("/tests/fixtures/cluster.html");
  const data = await page.evaluate(async () => {
    const { fixture, id, concat } = (await import(
      String("/tests/helpers/cluster-history.ts")
    )) as typeof import("../helpers/cluster-history.ts");
    const storage = (await import(
      String("/src/cluster/storage.ts")
    )) as typeof import("../../src/cluster/storage.ts");
    const { hex } = (await import(
      String("/src/cluster/trust.ts")
    )) as typeof import("../../src/cluster/trust.ts");
    const f = await fixture();
    await f.admit();
    const expired = await f.adopt(1);
    const key = await storage.clusterKey(hex(expired.head.clusterId));
    // Install a controlled, already-expired historical browser record. Product
    // storeHistory correctly refuses selecting an expired grant anew.
    const db = await new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open("rieul.cluster.v1", 1);
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    await new Promise((resolve, reject) => {
      const tx = db.transaction("clusters", "readwrite");
      tx.objectStore("clusters").put({
        ...key,
        publicKey: f.client.public,
        privateKey: f.client.private,
        history: expired,
        grantId: id(5),
      });
      tx.oncomplete = resolve;
      tx.onerror = reject;
    });
    db.close();
    window.expiryDecision = (await storage.readCluster(key.id))!;
    await f.append([4, id(5)], concat(new Uint8Array([4]), id(5)));
    window.revokedHistory = f.history;
    return { id: key.id };
  });
  const other = await context.newPage();
  await other.goto("/tests/fixtures/cluster.html");
  // Structured clone preserves Uint8Array through IndexedDB, unlike Playwright
  // argument serialization. A second tab reads and appends the signed suffix.
  const serialized = await page.evaluate(() =>
    JSON.stringify(window.revokedHistory, (_key, value) =>
      value instanceof Uint8Array ? { bytes: Array.from(value) } : value,
    ),
  );
  await other.evaluate(async (serialized) => {
    const { storeHistory } = (await import(
      String("/src/cluster/storage.ts")
    )) as typeof import("../../src/cluster/storage.ts");
    await storeHistory(
      JSON.parse(serialized, (_key, value) =>
        value?.bytes ? new Uint8Array(value.bytes) : value,
      ),
    );
  }, serialized);
  const result = await page.evaluate(async (id) => {
    const storage = (await import(
      String("/src/cluster/storage.ts")
    )) as typeof import("../../src/cluster/storage.ts");
    const reset = await storage.resetExpiredGrant(window.expiryDecision);
    const current = await storage.readCluster(id);
    const staleWrite = await storage.storeHistory(
      window.expiryDecision.history!,
    );
    const staleReset = await storage.resetExpiredGrant(staleWrite);
    return {
      reset,
      staleReset,
      retained: Boolean(current!.grantId),
      sequence: current!.history!.head.sequence,
    };
  }, data.id);
  expect(result).toEqual({
    reset: false,
    staleReset: false,
    retained: true,
    sequence: 3,
  });
  await other.close();
});
