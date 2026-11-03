// Only invoked by the ignored Rust test: synthetic fixture keys, fresh Chrome profile.
import { chromium, expect } from "@playwright/test";
import { readFile, writeFile } from "node:fs/promises";
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
  // Actual server-process restart with persisted certificate/key/database.
  await writeFile(fixture.restartRequest, "restart");
  let restarted;
  for (let i = 0; i < 200; i++) {
    try {
      const next = JSON.parse(await readFile(fixture.readyFile, "utf8"));
      if (next.pid !== fixture.pid) {
        restarted = next;
        break;
      }
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  assert.ok(restarted, "synthetic server process did not restart");
  assert.deepEqual(restarted.certificateHashes, fixture.certificateHashes);
  assert.equal(restarted.a, fixture.a);
  assert.equal(restarted.b, fixture.b);
  await expect
    .poll(
      async () =>
        page.evaluate(async (a) => {
          const machine = JSON.parse(
            localStorage.getItem("rieul.machines.v1"),
          ).find((m) => m.cluster && m.baseUrl === a.replace("/rieul/rpc", ""));
          const p = await import("/src/protocol/client.ts"),
            c = await import("/src/cluster/connection.ts"),
            r = await import("/src/protocol/generated/client.ts");
          let transport;
          try {
            transport = await p.openWebTransport(machine);
            const record = await c.authenticateCluster(transport, machine);
            await r.getDaemonEnvironment(transport);
            return Array.from(record.publicKey);
          } catch {
            return null;
          } finally {
            transport?.close();
          }
        }, fixture.a),
      { timeout: 20000 },
    )
    .toEqual(outcome.public);
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
  // Move management to B through the product helper, then exercise the actual
  // B UI to transfer it back to A. Ordinary member access remains independent.
  await page.evaluate(async (a) => {
    const list = JSON.parse(localStorage.getItem("rieul.machines.v1"));
    const source = list.find((m) => m.baseUrl === a.replace("/rieul/rpc", ""));
    const local = list.find((m) => m.clientSecret);
    const p = await import("/src/protocol/client.ts"),
      c = await import("/src/cluster/connection.ts"),
      r = await import("/src/protocol/generated/client.ts"),
      manage = await import("/src/cluster/manage.ts"),
      trust = await import("/src/cluster/trust.ts");
    const target = await p.openWebTransport(local);
    await p.authenticateWebTransport(
      target,
      local.clientId,
      local.clientSecret,
    );
    const state = await r.getClusterState(target);
    target.close();
    local.cluster = {
      id: trust.hex(state.head.clusterId),
      admissionId: trust.hex(state.localAdmissionId),
    };
    const transport = await p.openWebTransport(source);
    try {
      await c.authenticateCluster(transport, source);
      await manage.transferPrimary(transport, local);
    } finally {
      transport.close();
    }
  }, fixture.a);
  const region = page.getByRole("region", { name: "Cluster", exact: true });
  await expect(region).toContainText("This daemon is the primary", {
    timeout: 15000,
  });
  await page
    .getByRole("button", { name: "Transfer primary…", exact: true })
    .click();
  await region
    .getByRole("combobox", { name: "Cluster member" })
    .selectOption({ index: 1 });
  await expect(region).toContainText("Once sealed");
  await region.getByRole("button", { name: "Confirm", exact: true }).click();
  await expect(
    region.getByRole("button", { name: "Confirm", exact: true }),
  ).toHaveCount(0, { timeout: 15000 });
  await expect(region).toContainText("Management is sealed");
  await expect(region).toContainText("Local pairings are managed separately");
  // Also cover the typed ClusterGrant forwarding principal, separately from
  // the locally paired UI request below. Approve a disposable synthetic key,
  // then revoke it using the existing cluster grant on a fresh B connection.
  await page.evaluate(async () => {
    const local = JSON.parse(localStorage.getItem("rieul.machines.v1")).find(
      (m) => m.clientSecret,
    );
    const p = await import("/src/protocol/client.ts"),
      r = await import("/src/protocol/generated/client.ts"),
      c = await import("/src/cluster/connection.ts"),
      trust = await import("/src/cluster/trust.ts");
    const paired = await p.openWebTransport(local);
    let granted;
    try {
      await p.authenticateWebTransport(
        paired,
        local.clientId,
        local.clientSecret,
      );
      const key = await crypto.subtle.generateKey("Ed25519", false, [
        "sign",
        "verify",
      ]);
      const publicKey = new Uint8Array(
        await crypto.subtle.exportKey("raw", key.publicKey),
      );
      const challenge = await r.beginClusterClientAdoption(paired, {
        clientPublicKey: publicKey,
      });
      await r.completeClusterClientAdoption(paired, {
        grantId: challenge.grantId,
        clientProof: await trust.sign(
          key.privateKey,
          trust.adoptionBody(challenge),
        ),
      });
      let accepted = false;
      for (let i = 0; i < 100; i++) {
        const adoption = await r.getClusterClientAdoption(paired, {
          grantId: challenge.grantId,
        });
        if (adoption.type === "accepted") {
          accepted = true;
          break;
        }
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
      if (!accepted)
        throw new Error("disposable fixture grant was not adopted");
      granted = await p.openWebTransport(local);
      // This explicitly uses grant proof, never the local credential on paired.
      await c.authenticateCluster(granted, local);
      const state = await r.getClusterState(granted);
      if (state.primaryTransition.type === "active")
        throw new Error("forwarding fixture must be replica");
      await r.revokeClusterClientGrant(granted, {
        operationId: crypto.getRandomValues(new Uint8Array(32)),
        expectedManagementEpoch: state.head.managementEpoch,
        grantId: challenge.grantId,
      });
      let revoked = false;
      for (let i = 0; i < 100; i++) {
        const history = await r.readClusterHistory(paired, {
          clusterId: state.head.clusterId,
        });
        const verified = await trust.verifyHistory(history);
        if (
          history.entries.some(
            (entry) =>
              entry.mutation[0] === 4 &&
              trust.same(entry.mutation.slice(1), challenge.grantId),
          )
        ) {
          if (verified.grants.has(trust.hex(challenge.grantId)))
            throw new Error("revoked fixture grant remained active");
          revoked = true;
          break;
        }
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
      if (!revoked)
        throw new Error("primary revocation did not synchronize to replica");
    } finally {
      granted?.close();
      paired.close();
    }
  });
  await region
    .getByRole("button", { name: "Refresh cluster status", exact: true })
    .click();
  await expect(
    region.getByRole("button", { name: "Revoke cluster approval…" }),
  ).toHaveCount(1);
  // Stay on B: after handoff its local UI must forward Revoke over the real
  // production with_system_roots TLS path to A. Only the child process trusts
  // the fixture PEM; the browser never sends this mutation directly to A.
  await expect(region).toContainText("Management is sealed");
  await region
    .getByRole("button", { name: "Revoke cluster approval…" })
    .first()
    .click();
  await expect(region).toContainText("This does not remove a local pairing");
  await region.getByRole("button", { name: "Confirm", exact: true }).click();
  try {
    await page.waitForFunction(
      () =>
        !JSON.parse(localStorage.getItem("rieul.machines.v1")).some(
          (m) => m.cluster && !m.clientSecret,
        ),
      null,
      { timeout: 15000 },
    );
  } catch (error) {
    console.error(
      "post-revoke UI:",
      (await page.locator("body").innerText()).slice(-6000),
    );
    console.error(
      "post-revoke state:",
      await page.evaluate(async (id) => {
        const s = await import("/src/cluster/storage.ts"),
          t = await import("/src/cluster/trust.ts");
        const record = await s.readCluster(id),
          verified = await t.verifyHistory(record.history);
        return {
          grant: t.hex(record.grantId),
          grants: Array.from(verified.grants.keys()),
          head: verified.head.sequence,
          machines: JSON.parse(localStorage.getItem("rieul.machines.v1")).map(
            (m) => ({
              id: m.id,
              cluster: m.cluster,
              local: Boolean(m.clientSecret),
            }),
          ),
        };
      }, outcome.cluster),
    );
    throw error;
  }
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
    "PASS: browser pairing → automatic adoption/discovery → second-node RPC; nonextractable key, concurrent tabs, reload, actual synthetic process restart, narrow UI, storage failure, leave, cancel/rejoin, primary transfer UI, grant-authenticated and local-pairing replica → primary TLS approval revocation without automatic re-adoption",
  );
} finally {
  await browser?.close();
  try {
    process.kill(-vite.pid, "SIGTERM");
  } catch {}
}
