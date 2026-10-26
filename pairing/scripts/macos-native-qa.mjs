import { connectStdio } from "@gpuix/native/automation";
import { spawn } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import assert from "node:assert/strict";
import net from "node:net";
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
  [...(executable ? [] : ["src/host.ts"]), "--config", config, "--show"],
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
let uiPid;
child.stderr.on("data", (data) => {
  process.stderr.write(data);
  const found = data.toString().match(/rieul-ui-ready:(\d+)/);
  if (found) uiPid = Number(found[1]);
});
const deadline = setTimeout(() => {
  child.kill();
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
const request = (procId, payload) =>
  new Promise((resolve, reject) => {
    const socket = net.createConnection(address),
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
    const close = confirm("19");
    await app.getByTestId("candidate-19").waitFor();
    await app.getByTestId("hide").click();
    assert.equal(accepted(await close), false);
    await request(4, wire.encodeActivateGuiReq("fixture reopen"));
    await app.getByTestId("daemon-url").waitFor();
  }
  evidence.repeatCloseReplaceReopen = 3;
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
  const exited = new Promise((resolve) => child.once("exit", resolve));
  child.kill("SIGTERM");
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
