import { connectStdio } from "@gpuix/native/automation";
import { spawn } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import assert from "node:assert/strict";
import net from "node:net";
import path from "node:path";
import { profile, endpoint } from "../src/profile.ts";
import { encodeCbor, decodeCborSequence } from "../../web/src/protocol/cbor.ts";
import * as wire from "../../web/src/protocol/socket-ipc.ts";
const dir = `${process.cwd()}/artifacts/macos-${Date.now()}`;
await mkdir(dir, { recursive: true });
const config = `${dir}/rieul.yaml`;
await writeFile(
  config,
  "listenAddr: 127.0.0.1:19019\ndomain: fixture.invalid\n",
);
const executable = process.env.RIEUL_GUI_EXECUTABLE;
const child = spawn(
  executable ?? process.execPath,
  [
    ...(executable ? [] : ["src/host.ts"]),
    "--config",
    executable ? path.relative(process.cwd(), config) : config,
    "--show",
  ],
  {
    cwd: process.cwd(),
    env: {
      ...process.env,
      RIEUL_PAIRING_AUTOMATION: "1",
      PATH: "/usr/bin:/bin",
      HOME: dir,
      BUN_INSTALL_CACHE_DIR: `${dir}/empty-cache`,
    },
    stdio: ["pipe", "pipe", "pipe"],
  },
);
const ownedChildren = new Set([child]);
let uiPid;
child.stderr.on("data", (data) => {
  process.stderr.write(data);
  const found = data.toString().match(/rieul-ui-ready:(\d+)/);
  if (found) uiPid = Number(found[1]);
});
const deadline = setTimeout(() => {
  for (const owned of ownedChildren) owned.kill();
  throw new Error("macOS native QA deadline");
}, 60000);
const app = await connectStdio({
  write: (chunk) => child.stdin.write(chunk),
  feed: (callback) =>
    child.stdout.on("data", (bytes) => callback(bytes.toString())),
  close: async () => {
    child.kill();
  },
});
const address = endpoint((await profile(config)).profileId);
const request = (procId, payload, destination = address) =>
  new Promise((resolve, reject) => {
    const socket = net.createConnection(destination),
      chunks = [];
    socket.on("error", reject);
    socket.on("data", (chunk) => chunks.push(chunk));
    socket.on("end", () => resolve(Buffer.concat(chunks)));
    socket.on("connect", () =>
      socket.write(wire.encodeSocketUnaryRequest(1, procId, payload)),
    );
  });
const confirm = (code) =>
  request(
    2,
    encodeCbor(
      new Map([
        [1, "https://fixture.invalid:19019"],
        [2, code],
        [3, "Disposable macOS fixture"],
      ]),
    ),
  );
const accepted = (bytes) =>
  decodeCborSequence(decodeCborSequence(bytes)[1].get(2))[0].get(1);
const evidence = {
  platform: process.platform,
  arch: process.arch,
  scope: "GPUiX/AppKit integration, not OS user selection",
  dir,
};
try {
  await app.getByTestId("daemon-url").waitFor({ timeoutMs: 20000 });
  await app.screenshot({ path: `${dir}/info.png` });
  for (let i = 0; i < 3; i++) {
    const first = confirm("42");
    await app.getByTestId("candidate-42").waitFor();
    const second = confirm("73");
    assert.equal(accepted(await first), false);
    await app.getByTestId("candidate-73").waitFor();
    await app.getByTestId("candidate-73").click();
    assert.equal(accepted(await second), true);
    await app.getByTestId("accepted").waitFor();
    assert.equal(
      await app.getByTestId("accepted").textContent(),
      "Approval sent.",
    );
    const cancelled = confirm("28");
    await app.getByTestId("candidate-28").waitFor();
    await app.getByTestId("cancel").click();
    assert.equal(accepted(await cancelled), false);
    await app.getByTestId("cancelled").waitFor();
    assert.equal(
      await app.getByTestId("cancelled").textContent(),
      "Pairing cancelled.",
    );
    assert.equal(await app.getByTestId("accepted").count(), 0);
    const close = confirm("19");
    await app.getByTestId("candidate-19").waitFor();
    await app.getByTestId("hide").click();
    assert.equal(accepted(await close), false);
    await request(4, wire.encodeActivateGuiReq("fixture reopen"));
    await app.getByTestId("daemon-url").waitFor();
  }
  evidence.repeatCloseReplaceReopen = 3;
  evidence.distinctApprovalAndCancellationFeedback = true;
  const duplicate = spawn(
    executable ?? process.execPath,
    [...(executable ? [] : ["src/host.ts"]), "--config", config],
    { env: process.env, stdio: "ignore" },
  );
  assert.equal(
    await new Promise((resolve) => duplicate.once("exit", resolve)),
    0,
  );
  evidence.duplicate = true;
  if (executable) {
    const otherConfig = `${dir}/second.yaml`;
    await writeFile(
      otherConfig,
      "listenAddr: 127.0.0.1:19020\ndomain: fixture-second.invalid\n",
    );
    const otherAddress = endpoint((await profile(otherConfig)).profileId);
    const other = spawn(executable, ["--config", otherConfig, "--show"], {
      env: {
        ...process.env,
        RIEUL_PAIRING_AUTOMATION: "1",
        PATH: "/usr/bin:/bin",
        HOME: dir,
        BUN_INSTALL_CACHE_DIR: `${dir}/empty-cache`,
      },
      stdio: ["pipe", "pipe", "pipe"],
    });
    ownedChildren.add(other);
    other.stderr.on("data", (bytes) => process.stderr.write(bytes));
    let otherApp;
    try {
      otherApp = await connectStdio({
        write: (bytes) => other.stdin.write(bytes),
        feed: (callback) =>
          other.stdout.on("data", (bytes) => callback(bytes.toString())),
        close: async () => {
          other.kill();
        },
      });
      await otherApp.getByTestId("daemon-url").waitFor();
      assert.equal(
        await otherApp.getByTestId("daemon-url").textContent(),
        "https://fixture-second.invalid:19020",
      );
      const first = confirm("31");
      let settled = false;
      void first.then(
        () => {
          settled = true;
        },
        () => {
          settled = true;
        },
      );
      await app.getByTestId("candidate-31").waitFor();
      const second = request(
        2,
        encodeCbor(
          new Map([
            [1, "https://fixture-second.invalid:19020"],
            [2, "86"],
            [3, "Second disposable profile"],
          ]),
        ),
        otherAddress,
      );
      await otherApp.getByTestId("candidate-86").waitFor();
      await otherApp.getByTestId("candidate-86").click();
      assert.equal(accepted(await second), true);
      assert.equal(settled, false);
      const stopped = new Promise((resolve) => other.once("exit", resolve));
      other.kill();
      await stopped;
      await app.getByTestId("candidate-31").waitFor();
      await app.getByTestId("hide").click();
      assert.equal(accepted(await first), false);
      await request(
        4,
        wire.encodeActivateGuiReq("primary survives second profile exit"),
      );
      await app.getByTestId("daemon-url").waitFor();
      evidence.twoNativeProfilesAndIndependentExit = true;
    } finally {
      if (other.pid && other.exitCode === null && other.signalCode === null) {
        const stopped = new Promise((resolve) => other.once("exit", resolve));
        other.kill();
        await stopped;
      }
      ownedChildren.delete(other);
      await otherApp?.close();
    }
  }
  evidence.relativeConfigUsesCallerDirectory = !!executable;
  const quitRequest = confirm("62");
  await app.getByTestId("candidate-62").waitFor();
  const exited = new Promise((resolve) => child.once("exit", resolve));
  child.kill("SIGTERM");
  assert.equal(accepted(await quitRequest), false);
  evidence.quitRejectsPending = true;
  assert.equal(await exited, 0);
  if (uiPid) {
    let alive = true;
    for (let i = 0; i < 100 && alive; i++) {
      try {
        process.kill(uiPid, 0);
        await new Promise((resolve) => setTimeout(resolve, 20));
      } catch {
        alive = false;
      }
    }
    assert.equal(alive, false);
  }
  evidence.shutdown = true;
  console.log(JSON.stringify(evidence));
} finally {
  await writeFile(`${dir}/evidence.json`, JSON.stringify(evidence, null, 2));
  await app.close();
  clearTimeout(deadline);
}
