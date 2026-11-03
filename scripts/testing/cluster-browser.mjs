// Only invoked by the ignored Rust test: synthetic fixture keys, fresh Chrome profile.
import { chromium, expect } from "@playwright/test";
import { readFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
const fixture = JSON.parse(await readFile(process.argv[2], "utf8"));
const port = 5191,
  url = `http://127.0.0.1:${port}`;
const vite = spawn(
  "pnpm",
  [
    "--dir",
    "web",
    "exec",
    "vite",
    "--host",
    "127.0.0.1",
    "--port",
    String(port),
    "--strictPort",
  ],
  {
    cwd: fileURLToPath(new URL("../..", import.meta.url)),
    stdio: "ignore",
    detached: true,
  },
);
let browser;
try {
  for (let i = 0; i < 100; i++) {
    try {
      if ((await fetch(url)).ok) break;
    } catch {}
    await new Promise((r) => setTimeout(r, 100));
  }
  browser = await chromium.launch({
    executablePath:
      process.env.RIEUL_TEST_CHROME ??
      "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    headless: true,
  });
  const context = await browser.newContext();
  await context.addInitScript(
    ({ urls, hashes }) => {
      const Native = window.WebTransport;
      window.WebTransport = class extends Native {
        constructor(url, options = {}) {
          const index = urls.indexOf(String(url));
          if (index < 0)
            throw new Error("Transport outside isolated fixture denied");
          const value = Uint8Array.from(hashes[index].match(/../g), (h) =>
            parseInt(h, 16),
          );
          super(url, {
            ...options,
            serverCertificateHashes: [{ algorithm: "sha-256", value }],
          });
        }
      };
    },
    { urls: [fixture.a, fixture.b], hashes: fixture.certificateHashes },
  );
  const page = await context.newPage();
  page.on("pageerror", (error) =>
    console.error("browser error:", error.message),
  );
  await page.goto(url);
  await page.evaluate(async (b) => {
    const protocol = await import("/src/protocol/client.ts"),
      rpc = await import("/src/protocol/generated/client.ts");
    window.fixtureTransport = await protocol.openWebTransport({
      id: "fixture",
      name: "Fixture member",
      baseUrl: b.replace("/rieul/rpc", ""),
    });
    await rpc.startPairing(window.fixtureTransport, {
      confirmationCode: "42",
      clientLabel: "isolated cluster browser",
    });
  }, fixture.b);
  const code = await readFile(fixture.codeFile, "utf8");
  await page.evaluate(
    async ({ code, b }) => {
      const rpc = await import("/src/protocol/generated/client.ts");
      const credentials = await rpc.completePairing(window.fixtureTransport, {
        code,
      });
      const machine = {
        id: "fixture",
        name: "Fixture member",
        baseUrl: b.replace("/rieul/rpc", ""),
        ...credentials,
      };
      localStorage.setItem("rieul.machines.v1", JSON.stringify([machine]));
      localStorage.setItem("rieul.selected-machine-id.v1", machine.id);
      window.fixtureTransport.close();
    },
    { code, b: fixture.b },
  );
  await page.reload();
  try {
    await page.waitForFunction(
      () =>
        JSON.parse(localStorage.getItem("rieul.machines.v1") ?? "[]").some(
          (m) => m.cluster,
        ),
      null,
      { timeout: 25000 },
    );
  } catch (error) {
    console.error(
      "UI state:",
      (await page.locator("body").innerText()).slice(0, 2000),
    );
    console.error(
      "Direct sync:",
      await page.evaluate(async () => {
        const m = JSON.parse(localStorage.getItem("rieul.machines.v1"))[0];
        const p = await import("/src/protocol/client.ts"),
          r = await import("/src/protocol/generated/client.ts"),
          c = await import("/src/cluster/connection.ts");
        let t;
        try {
          t = await p.openWebTransport(m);
          await p.authenticateWebTransport(t, m.clientId, m.clientSecret);
          const info = await r.getDaemonInfo(t);
          return (await c.synchronizeCluster(t, m, info.supportedProcIds))
            .message;
        } catch (e) {
          return e.message;
        } finally {
          t?.close();
        }
      }),
    );
    throw error;
  }
  const outcome = await page.evaluate(async (a) => {
    const machines = JSON.parse(localStorage.getItem("rieul.machines.v1"));
    const machine = machines.find(
      (m) => m.cluster && m.baseUrl === a.replace("/rieul/rpc", ""),
    );
    if (!machine) throw new Error("primary was not automatically discovered");
    const protocol = await import("/src/protocol/client.ts"),
      connection = await import("/src/cluster/connection.ts"),
      rpc = await import("/src/protocol/generated/client.ts"),
      storage = await import("/src/cluster/storage.ts");
    const transport = await protocol.openWebTransport(machine);
    const record = await connection.authenticateCluster(transport, machine);
    const environment = await rpc.getDaemonEnvironment(transport);
    let exported = false;
    try {
      await crypto.subtle.exportKey("pkcs8", record.privateKey);
      exported = true;
    } catch {}
    transport.close();
    return {
      discovered: machines.filter((m) => m.cluster).length,
      home: environment.homeDirectory,
      exported,
      cluster: record.id,
      public: Array.from(record.publicKey),
    };
  }, fixture.a);
  assert.equal(outcome.exported, false);
  assert.ok(outcome.discovered >= 2);
  assert.ok(outcome.home);
  await page.getByRole("button", { name: "Daemon", exact: true }).click();
  await expect(
    page.getByRole("region", { name: "Cluster", exact: true }),
  ).toContainText("Cluster access is ready.");
  await page
    .getByRole("button", { name: "Leave cluster…", exact: true })
    .click();
  await expect(
    page.getByRole("region", { name: "Cluster", exact: true }),
  ).toContainText("primary must transfer its role");
  await page.getByRole("button", { name: "Cancel", exact: true }).click();
  await page.setViewportSize({ width: 390, height: 844 });
  await page.getByRole("region", { name: "Cluster", exact: true }).screenshot({
    path: new URL("../../tmp/cluster-browser-narrow.png", import.meta.url)
      .pathname,
  });
  await page.setViewportSize({ width: 1280, height: 900 });
  const second = await context.newPage();
  await second.goto(url);
  const keys = await Promise.all(
    [page, second].map((p) =>
      p.evaluate(async () => {
        const { clusterKey } = await import("/src/cluster/storage.ts");
        const record = await clusterKey("ab".repeat(32));
        return Array.from(record.publicKey);
      }),
    ),
  );
  assert.deepEqual(keys[0], keys[1]);
  const storageFailure = await second.evaluate(async () => {
    const m = JSON.parse(localStorage.getItem("rieul.machines.v1")).find(
      (m) => m.clientSecret,
    );
    const p = await import("/src/protocol/client.ts"),
      r = await import("/src/protocol/generated/client.ts"),
      c = await import("/src/cluster/connection.ts");
    const t = await p.openWebTransport(m);
    await p.authenticateWebTransport(t, m.clientId, m.clientSecret);
    const info = await r.getDaemonInfo(t);
    Object.defineProperty(window, "indexedDB", {
      configurable: true,
      value: {
        open() {
          throw new Error("fixture storage failure");
        },
      },
    });
    let failed = false;
    try {
      await c.synchronizeCluster(t, m, info.supportedProcIds);
    } catch {
      failed = true;
    }
    const environment = await r.getDaemonEnvironment(t);
    t.close();
    return { failed, localStillWorks: Boolean(environment.homeDirectory) };
  });
  assert.deepEqual(storageFailure, { failed: true, localStillWorks: true });
  await second.close();
  await page.reload();
  const saved = await page.evaluate(async (id) => {
    const { readCluster } = await import("/src/cluster/storage.ts");
    return Array.from((await readCluster(id)).publicKey);
  }, outcome.cluster);
  assert.deepEqual(saved, outcome.public);
  await page.evaluate(async (a) => {
    const list = JSON.parse(localStorage.getItem("rieul.machines.v1"));
    const local = list.find((m) => m.clientSecret),
      source = list.find(
        (m) => m.cluster && m.baseUrl === a.replace("/rieul/rpc", ""),
      );
    const protocol = await import("/src/protocol/client.ts"),
      rpc = await import("/src/protocol/generated/client.ts"),
      manage = await import("/src/cluster/manage.ts"),
      storage = await import("/src/cluster/storage.ts");
    const target = await protocol.openWebTransport(local);
    try {
      await protocol.authenticateWebTransport(
        target,
        local.clientId,
        local.clientSecret,
      );
      const before = await rpc.getClusterState(target);
      await manage.leaveCluster(target);
      for (let i = 0; i < 100; i++) {
        if ((await rpc.getClusterState(target)).type === "removed") break;
        await new Promise((r) => setTimeout(r, 100));
      }
      if ((await rpc.getClusterState(target)).type !== "removed")
        throw new Error("leave did not complete");
      const saved = await storage.readCluster(source.cluster.id);
      const canceled = await rpc.prepareClusterJoin(target, {
        operationId: crypto.getRandomValues(new Uint8Array(32)),
        genesis: saved.history.genesis,
        confirmed: true,
      });
      await manage.cancelJoin(target, source);
      if ((await rpc.getClusterState(target)).type !== "removed")
        throw new Error("cancel cleanup did not complete");
      const joined = await manage.joinCluster(target, source);
      if (
        joined.type !== "member" ||
        String(joined.localAdmissionId) === String(before.localAdmissionId) ||
        String(joined.localAdmissionId) === String(canceled.admissionId)
      )
        throw new Error("rejoin reused old incarnation");
      let staleAccepted = false;
      try {
        await rpc.finishClusterJoin(target, {
          operationId: canceled.operationId,
          history: (await storage.readCluster(source.cluster.id)).history,
        });
        staleAccepted = true;
      } catch {}
      if (staleAccepted) throw new Error("canceled join was resurrected");
    } finally {
      target.close();
    }
  }, fixture.a);
  await page.evaluate(async (a) => {
    const m = JSON.parse(localStorage.getItem("rieul.machines.v1")).find(
      (m) => m.cluster && m.baseUrl === a.replace("/rieul/rpc", ""),
    );
    const p = await import("/src/protocol/client.ts"),
      c = await import("/src/cluster/connection.ts"),
      r = await import("/src/protocol/generated/client.ts");
    const t = await p.openWebTransport(m),
      record = await c.authenticateCluster(t, m);
    await r.revokeClusterClientGrant(t, {
      operationId: crypto.getRandomValues(new Uint8Array(32)),
      expectedManagementEpoch: record.history.head.managementEpoch,
      grantId: record.grantId,
    });
    t.close();
  }, fixture.a);
  await page.waitForFunction(
    () =>
      !JSON.parse(localStorage.getItem("rieul.machines.v1")).some(
        (m) => m.cluster && !m.clientSecret,
      ),
    null,
    { timeout: 15000 },
  );
  await page.waitForTimeout(5500);
  assert.equal(
    await page.evaluate(
      () =>
        JSON.parse(localStorage.getItem("rieul.machines.v1")).filter(
          (m) => m.cluster && !m.clientSecret,
        ).length,
    ),
    0,
  );
  console.log(
    "PASS: browser pairing → automatic adoption/discovery → second-node RPC; nonextractable key, concurrent tabs, reload, narrow UI, storage failure, leave, cancel/rejoin, revocation without automatic re-adoption",
  );
} finally {
  await browser?.close();
  try {
    process.kill(-vite.pid, "SIGTERM");
  } catch {}
}
