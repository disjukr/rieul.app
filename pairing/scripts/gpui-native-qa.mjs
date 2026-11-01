import { spawn } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import { createInterface } from "node:readline";
import { createHash } from "node:crypto";
import net from "node:net";
import path from "node:path";
import assert from "node:assert/strict";
import { encodeCbor, decodeCborSequence } from "../../web/src/protocol/cbor.ts";
import * as wire from "../../web/src/protocol/socket-ipc.ts";
const dir = path.resolve(
  "pairing/artifacts",
  `gpui-${process.platform}-${process.arch}-${Date.now()}`,
);
await mkdir(dir, { recursive: true });
const executable = process.env.RIEUL_GUI_EXECUTABLE;
assert(executable, "RIEUL_GUI_EXECUTABLE is required");
const owned = new Set();
const delay = (ms) => new Promise((r) => setTimeout(r, ms));
function endpoint(config) {
  const hash = createHash("sha256").update(config).digest("hex").slice(0, 24);
  return process.platform === "win32"
    ? `\\\\.\\pipe\\rieul-gui-profile-${hash}`
    : `/tmp/rieul-gui-profile-${hash}-${process.getuid()}.sock`;
}
async function launch(name) {
  const home = path.join(dir, name);
  await mkdir(home, { recursive: true });
  const config = path.join(home, "rieul.yaml");
  await writeFile(
    config,
    "domain: fixture.invalid\nlistenAddr: 127.0.0.1:19019\n",
  );
  const child = spawn(
    executable,
    ["--config", path.relative(process.cwd(), config), "--show"],
    {
      env: {
        ...process.env,
        RIEUL_PAIRING_AUTOMATION: "1",
        PATH:
          process.platform === "win32"
            ? `${process.env.SystemRoot}\\System32`
            : "/usr/bin:/bin",
        HOME: home,
      },
      stdio: ["pipe", "pipe", "pipe"],
    },
  );
  owned.add(child);
  let serial = 0,
    stderr = "";
  const pending = new Map();
  child.stderr.on("data", (b) => {
    stderr += b;
    process.stderr.write(b);
  });
  createInterface({ input: child.stdout }).on("line", (line) => {
    let value;
    try {
      value = JSON.parse(line);
    } catch {
      return;
    }
    const p = pending.get(value.id);
    if (!p) return;
    pending.delete(value.id);
    clearTimeout(p.timer);
    value.error ? p.reject(Error(value.error)) : p.resolve(value.result);
  });
  child.on("exit", (code, signal) => {
    for (const p of pending.values()) {
      clearTimeout(p.timer);
      p.reject(Error(`native GUI exited ${code}/${signal}: ${stderr}`));
    }
    pending.clear();
  });
  const call = (method, args = {}) =>
    new Promise((resolve, reject) => {
      const id = ++serial;
      const timer = setTimeout(() => {
        pending.delete(id);
        reject(Error(`QA ${method} timed out`));
      }, 20000);
      pending.set(id, { resolve, reject, timer });
      child.stdin.write(JSON.stringify({ id, method, ...args }) + "\n");
    });
  const snapshot = () => call("snapshot");
  const wait = async (predicate) => {
    for (let i = 0; i < 150; i++) {
      const state = await snapshot();
      if (predicate(state)) return state;
      await delay(40);
    }
    throw Error("native state wait timed out");
  };
  const request = (procId, payload) => {
    let socket;
    const result = new Promise((resolve, reject) => {
      const chunks = [];
      socket = net.createConnection(endpoint(config));
      socket.on("error", reject);
      socket.on("data", (b) => chunks.push(b));
      socket.on("end", () => resolve(Buffer.concat(chunks)));
      socket.on("connect", () =>
        socket.write(wire.encodeSocketUnaryRequest(1, procId, payload)),
      );
    });
    return {
      result,
      get socket() {
        return socket;
      },
    };
  };
  const confirm = (code = "42") =>
    request(
      2,
      encodeCbor(
        new Map([
          [1, "https://fixture.invalid:19019"],
          [2, code],
          [3, "Disposable fixture"],
        ]),
      ),
    );
  const activate = () =>
    request(4, wire.encodeActivateGuiReq("fixture")).result;
  const screenshot = async (name) => {
    await delay(150);
    await call("screenshot", { path: path.join(home, `${name}.png`) });
  };
  await wait((s) => s.route.kind === "daemonInfo" && s.visible);
  return {
    child,
    config,
    home,
    call,
    snapshot,
    wait,
    request,
    confirm,
    activate,
    screenshot,
    stderr: () => stderr,
  };
}
const accepted = (bytes) =>
  decodeCborSequence(decodeCborSequence(bytes)[1].get(2))[0].get(1);
const deadline = setTimeout(() => {
  for (const child of owned) child.kill();
}, 120000);
const evidence = {
  platform: process.platform,
  arch: process.arch,
  scope: "native GPUI input and renderer; not an OS-input audit",
  checks: [],
};
try {
  const app = await launch("primary");
  await app.screenshot("info");
  const info = await app.snapshot();
  assert.equal(info.route.daemonUrl, "https://fixture.invalid:19019");
  const duplicate = spawn(executable, ["--config", app.config], {
    stdio: "pipe",
  });
  owned.add(duplicate);
  const exit = await new Promise((r) => duplicate.on("exit", r));
  assert.equal(exit, 0);
  evidence.checks.push("duplicate activation");
  await app.request(
    1,
    encodeCbor(
      new Map([
        [1, info.route.daemonUrl],
        [2, "123456"],
        [3, 60],
      ]),
    ),
  ).result;
  await app.wait((s) => s.route.kind === "pairingCode");
  await app.screenshot("code");
  for (let cycle = 0; cycle < 3; cycle++) {
    const old = app.confirm("42");
    const first = await app.wait((s) => s.route.kind === "confirmPairing");
    const fresh = app.confirm("73");
    const state = await app.wait((s) => s.route.confirmationCode === "73");
    assert.equal(accepted(await old.result), false);
    await assert.rejects(
      app.call("resolve", { accepted: true, generation: first.generation }),
    );
    const index = state.route.candidates.indexOf("73");
    assert(index >= 0);
    if (cycle === 0) await app.screenshot("confirm");
    await app.call("click", { x: 100 + index * 143, y: 204 });
    assert.equal(accepted(await fresh.result), true);
    await app.wait((s) => s.feedback === "Approval sent.");
    if (cycle === 0) await app.screenshot("approved");
    const wrong = app.confirm();
    const bad = await app.wait(
      (s) =>
        s.route.confirmationCode === "42" && s.generation > state.generation,
    );
    const badIndex = bad.route.candidates.findIndex((c) => c !== "42");
    await app.call("click", { x: 100 + badIndex * 143, y: 204 });
    assert.equal(accepted(await wrong.result), false);
    await app.wait((s) => s.feedback.includes("did not match"));
    if (cycle === 0) await app.screenshot("rejected");
    const cancel = app.confirm();
    await app.wait(
      (s) => s.route.kind === "confirmPairing" && s.feedback === "",
    );
    await app.call("click", { x: 65, y: 312 });
    assert.equal(accepted(await cancel.result), false);
    await app.wait((s) => s.feedback === "Pairing cancelled.");
    const closing = app.confirm();
    await app.wait(
      (s) => s.route.kind === "confirmPairing" && s.feedback === "",
    );
    await app.call("close");
    assert.equal(accepted(await closing.result), false);
    await app.wait((s) => !s.visible);
    await app.activate();
    await app.wait((s) => s.visible);
  }
  evidence.checks.push(
    "three native mouse approval/rejection/cancel/close/reopen cycles",
    "stale generation rejection",
  );
  const second = await launch("secondary");
  const pending = second.confirm("99");
  await second.wait((s) => s.route.kind === "confirmPairing");
  const ownPending = app.confirm();
  await app.wait((s) => s.route.kind === "confirmPairing");
  await app.call("quit");
  assert.equal(accepted(await ownPending.result), false);
  await new Promise((r) => app.child.on("exit", r));
  assert.equal(app.child.exitCode, 0);
  assert.equal((await second.snapshot()).route.confirmationCode, "99");
  await second.call("close");
  assert.equal(accepted(await pending.result), false);
  await second.call("quit");
  await new Promise((r) => second.child.on("exit", r));
  assert.equal(second.child.exitCode, 0);
  evidence.checks.push(
    "independent profile shutdown and pending rejection",
    "empty PATH/runtime cache",
  );
  evidence.passed = true;
} finally {
  clearTimeout(deadline);
  for (const child of owned) if (child.exitCode === null) child.kill();
  await writeFile(
    path.join(dir, "evidence.json"),
    JSON.stringify(evidence, null, 2),
  );
  console.log(JSON.stringify(evidence, null, 2));
}
