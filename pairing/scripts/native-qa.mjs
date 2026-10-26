import { connectStdio } from "@gpuix/native/automation";
import { spawn, execFileSync } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import { appendFileSync } from "node:fs";
import assert from "node:assert/strict";
import net from "node:net";
import path from "node:path";
import { profile, endpoint } from "../src/profile.ts";
import {
  encodeCbor,
  decodeCborSequencePrefix,
} from "../../web/src/protocol/cbor.ts";
import * as wire from "../../web/src/protocol/socket-ipc.ts";
const bun = process.env.RIEUL_PAIRING_BUN ?? "bun";
if (process.env.NAPI_RS_NATIVE_LIBRARY_PATH)
  throw new Error(
    "Native QA requires the released addon; unset NAPI_RS_NATIVE_LIBRARY_PATH",
  );
const dir = `${process.cwd()}/artifacts/qa-${Date.now()}`;
await mkdir(dir, { recursive: true });
const config = `${dir}/rieul.yaml`;
await writeFile(
  config,
  "listenAddr: 127.0.0.1:19019\ndomain: fixture.invalid\n",
);
const host = process.env.RIEUL_PAIRING_HOST ?? "src/host.ts";
const executable = process.env.RIEUL_GUI_EXECUTABLE;
const launchArgs = executable
  ? ["--config", path.relative(process.cwd(), config), "--show"]
  : [host, "--config", config, "--show"];
const isolated = process.env.RIEUL_PAIRING_EMPTY_PATH === "1";
const home = `${dir}/empty-home`;
await mkdir(home, { recursive: true });
const childEnv = {
  ...process.env,
  RIEUL_PAIRING_BUN: bun,
  RIEUL_PAIRING_AUTOMATION: "1",
};
if (isolated)
  Object.assign(childEnv, {
    PATH:
      process.platform === "win32"
        ? `${process.env.SystemRoot}/System32`
        : "/usr/bin:/bin",
    HOME: home,
    USERPROFILE: home,
    APPDATA: home,
    LOCALAPPDATA: home,
    BUN_INSTALL_CACHE_DIR: `${home}/bun-cache`,
  });
const child = spawn(executable ?? process.execPath, launchArgs, {
  cwd: process.cwd(),
  env: childEnv,
  stdio: ["pipe", "pipe", "pipe"],
  windowsHide: true,
});
const ownedChildren = new Set([child]);
child.stderr.on("data", (b) => {
  appendFileSync(`${dir}/stderr.log`, b);
  process.stderr.write(b);
});
const deadline = setTimeout(() => {
  for (const owned of ownedChildren) owned.kill();
  throw new Error("Native QA timed out");
}, 60000);
const app = await connectStdio({
  write: (c) => child.stdin.write(c),
  feed: (cb) => child.stdout.on("data", (b) => cb(b.toString())),
  close: async () => {
    child.kill();
  },
});
const address = endpoint((await profile(config)).profileId);
function request(procId, payload, destination = address) {
  const socket = net.createConnection(destination),
    chunks = [];
  const result = new Promise((resolve, reject) => {
    socket.on("error", reject);
    socket.on("data", (b) => chunks.push(b));
    socket.on("end", () => resolve(Buffer.concat(chunks)));
    socket.on("connect", () =>
      socket.write(wire.encodeSocketUnaryRequest(1, procId, payload)),
    );
  });
  return { socket, result };
}
const confirm = (code) =>
  request(
    2,
    encodeCbor(
      new Map([
        [1, "https://fixture.invalid:19019"],
        [2, code],
        [3, "Disposable QA client"],
      ]),
    ),
  );
const accepted = (bytes) =>
  decodeCborSequencePrefix(
    decodeCborSequencePrefix(bytes)[1].value.get(2),
  )[0].value.get(1);
const evidence = {
  dir,
  scope: "GPUiX/Win32 fixture integration; not OS tray popup selection",
};
try {
  await app.getByTestId("daemon-url").waitFor({ timeoutMs: 20000 });
  assert.equal(
    await app.getByTestId("daemon-url").textContent(),
    "https://fixture.invalid:19019",
  );
  await app.screenshot({ path: `${dir}/daemon-info.png` });
  const qr = await app.getByTestId("daemon-qr").bounds();
  assert.equal(qr.width, 154);
  assert.equal(qr.height, 154);
  evidence.qrBounds = qr;
  evidence.initial = true;
  const uiPid = Number(
    execFileSync(
      "powershell.exe",
      [
        "-NoProfile",
        "-Command",
        `$parents=@(${child.pid}); for ($depth=0; $depth -lt 3; $depth++) { $next=@(); foreach ($parent in $parents) { Get-CimInstance Win32_Process -Filter "ParentProcessId = $parent" | ForEach-Object { if ($_.Name -eq 'bun.exe') { $_.ProcessId } else { $next+=$_.ProcessId } } }; $parents=$next }`,
      ],
      { encoding: "utf8", windowsHide: true },
    ).trim(),
  );
  const probe = (operation) =>
    JSON.parse(
      execFileSync(bun, ["scripts/window-probe.ts", String(uiPid), operation], {
        encoding: "utf8",
        windowsHide: true,
      }),
    );
  evidence.uiPid = uiPid;
  evidence.bundledLauncher = !!executable;
  evidence.emptyPathAndCache = isolated;
  evidence.relativeConfigUsesCallerDirectory = !!executable;
  assert.deepEqual(probe("icons").icons, {
    small: true,
    large: true,
    minimize: false,
    maximize: false,
  });
  evidence.nativeWindowIcons = true;
  assert.equal(probe("visible").visible, true);
  probe("close");
  await new Promise((r) => setTimeout(r, 100));
  assert.equal(probe("visible").visible, false);
  probe("tray");
  await new Promise((r) => setTimeout(r, 150));
  assert.equal(probe("visible").visible, true);
  evidence.nativeCloseAndTray = true;
  await request(
    1,
    encodeCbor(
      new Map([
        [1, "https://fixture.invalid:19019"],
        [2, "123456"],
        [3, 60],
      ]),
    ),
  ).result;
  await app.getByTestId("copy-pairing-code").waitFor();
  await app.screenshot({ path: `${dir}/pairing-code.png` });
  await request(6).result;
  await request(4, wire.encodeActivateGuiReq("fixture")).result;
  for (let i = 0; i < 3; ++i) {
    const a = confirm("42");
    await app.getByTestId("candidate-42").waitFor();
    if (i === 0) {
      for (const procId of [1, 2]) {
        const response = await request(procId, encodeCbor(new Map())).result;
        assert.equal(decodeCborSequencePrefix(response)[0].value, 4);
        await app.getByTestId("candidate-42").waitFor();
      }
      evidence.emptyMapsPreservePending = true;
    }
    const b = confirm("73");
    assert.equal(accepted(await a.result), false);
    await app.getByTestId("candidate-73").waitFor();
    await app.getByTestId("candidate-73").click();
    assert.equal(accepted(await b.result), true);
    await app.getByTestId("accepted").waitFor();
    const c = confirm("28");
    await app.getByTestId("candidate-28").waitFor();
    await app.getByTestId("cancel").click();
    assert.equal(accepted(await c.result), false);
  }
  evidence.repeatReplacementAcceptCancel = 3;
  const c = confirm("64");
  await app.getByTestId("candidate-64").waitFor();
  await app.screenshot({ path: `${dir}/confirmation.png` });
  probe("close");
  assert.equal(accepted(await c.result), false);
  assert.equal(probe("visible").visible, false);
  evidence.nativeCloseRejectsPending = true;
  await request(4, wire.encodeActivateGuiReq("fixture reopen")).result;
  await app.getByTestId("daemon-url").waitFor();
  evidence.closeAndReopen = true;
  const d = confirm("19");
  await app.getByTestId("candidate-19").waitFor();
  d.socket.destroy();
  await new Promise((r) => setTimeout(r, 100));
  await request(4, wire.encodeActivateGuiReq("reopen after disconnect")).result;
  await app.getByTestId("daemon-url").waitFor();
  evidence.disconnect = true;
  const duplicate = spawn(
    executable ?? process.execPath,
    executable ? ["--config", config] : [host, "--config", config],
    {
      env: { ...process.env, RIEUL_PAIRING_BUN: bun },
      windowsHide: true,
      stdio: "ignore",
    },
  );
  assert.equal(
    await new Promise((resolve) => duplicate.on("exit", resolve)),
    0,
  );
  evidence.duplicateActivation = true;
  if (executable) {
    const otherConfig = `${dir}/second.yaml`;
    await writeFile(
      otherConfig,
      "listenAddr: 127.0.0.1:19020\ndomain: fixture-second.invalid\n",
    );
    const otherAddress = endpoint((await profile(otherConfig)).profileId);
    const other = spawn(executable, ["--config", otherConfig, "--show"], {
      cwd: process.cwd(),
      env: childEnv,
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
    });
    ownedChildren.add(other);
    other.stderr.on("data", (bytes) =>
      appendFileSync(`${dir}/second-stderr.log`, bytes),
    );
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
      void first.result.then(
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
      assert.equal(accepted(await second.result), true);
      assert.equal(settled, false);
      const stopped = new Promise((resolve) => other.once("exit", resolve));
      other.kill();
      await stopped;
      await app.getByTestId("candidate-31").waitFor();
      await app.getByTestId("hide").click();
      assert.equal(accepted(await first.result), false);
      await request(
        4,
        wire.encodeActivateGuiReq("primary survives second profile exit"),
      ).result;
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
  if (process.env.RIEUL_PAIRING_LAUNCHER) {
    const launcher = spawn(
      "powershell.exe",
      [
        "-NoProfile",
        "-File",
        process.env.RIEUL_PAIRING_LAUNCHER,
        "-Config",
        config,
        ...(executable
          ? ["-Bundle", path.dirname(executable)]
          : ["-Node", process.execPath, "-Bun", bun]),
        "-Show",
      ],
      { windowsHide: true, stdio: "ignore" },
    );
    assert.equal(
      await new Promise((resolve) => launcher.once("exit", resolve)),
      0,
    );
    evidence.powershellLauncher = true;
  }
  const quitRequest = confirm("62");
  await app.getByTestId("candidate-62").waitFor();
  const exit = new Promise((resolve) => child.once("exit", resolve));
  probe("quit");
  assert.equal(accepted(await quitRequest.result), false);
  evidence.quitRejectsPending = true;
  assert.equal(await exit, 0);
  evidence.trayQuitCommand = true;
  console.log(JSON.stringify(evidence));
} finally {
  await writeFile(`${dir}/evidence.json`, JSON.stringify(evidence, null, 2));
  await app.close();
  clearTimeout(deadline);
}
