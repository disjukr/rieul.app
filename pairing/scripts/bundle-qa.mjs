import assert from "node:assert/strict";
import path from "node:path";
import { readFile, writeFile, open, mkdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";
import { execute } from "./runtimes.mjs";
const repo = fileURLToPath(new URL("../..", import.meta.url));
const argument = process.argv.indexOf("--bundle");
if (argument < 0)
  throw new Error("--bundle requires a disposable repo tmp/ or target/ bundle");
const outer = path.resolve(process.argv[argument + 1]);
const relative = path.relative(repo, outer);
if (!["tmp", "target"].some((prefix) => relative.startsWith(prefix + path.sep)))
  throw new Error(
    "Bundle QA modifies only disposable workspace tmp/target bundles",
  );
const windows = process.platform === "win32";
const bundle = windows ? outer : path.join(outer, "Contents/Resources/pairing");
const executable = windows
  ? path.join(outer, "rieul-windows-gui.exe")
  : path.join(outer, "Contents/MacOS/rieul-gui");
const manifestFile = path.join(bundle, "bundle.json");
const manifest = await readFile(manifestFile);
const hostFile = path.join(bundle, "app/dist/host.js");
const host = await readFile(hostFile);
await execute(executable, ["--verify-bundle"], { windowsHide: true });
try {
  await writeFile(
    hostFile,
    Buffer.concat([host, Buffer.from("\n// fixture corruption\n")]),
  );
  await assert.rejects(
    execute(executable, ["--verify-bundle"], { windowsHide: true }),
    /bundle integrity failed/,
  );
} finally {
  await writeFile(hostFile, host);
}
try {
  const changed = JSON.parse(manifest);
  changed.files["../outside"] = "0".repeat(64);
  await writeFile(manifestFile, JSON.stringify(changed));
  await assert.rejects(
    execute(executable, ["--verify-bundle"], { windowsHide: true }),
    /unsafe bundle path/,
  );
} finally {
  await writeFile(manifestFile, manifest);
}
await execute(executable, ["--verify-bundle"], { windowsHide: true });
const evidence = {
  integrity: true,
  traversalRejected: true,
  installedNodeOrBunRequired: false,
};
if (windows && process.argv.includes("--lifecycle")) {
  const dir = path.join(repo, "tmp", `bundle-lifecycle-${Date.now()}`);
  await mkdir(dir, { recursive: true });
  const config = path.join(dir, "rieul.yaml");
  await writeFile(
    config,
    "listenAddr: 127.0.0.1:19019\ndomain: fixture.invalid\n",
  );
  const child = spawn(executable, ["--config", config], {
    windowsHide: true,
    stdio: ["pipe", "pipe", "pipe"],
    env: {
      ...process.env,
      PATH: `${process.env.SystemRoot}/System32`,
      HOME: dir,
      USERPROFILE: dir,
      APPDATA: dir,
      LOCALAPPDATA: dir,
      BUN_INSTALL_CACHE_DIR: path.join(dir, "empty-cache"),
      RIEUL_PAIRING_AUTOMATION: "1",
    },
  });
  let uiPid;
  const ready = new Promise((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error("Fixture UI startup deadline")),
      20000,
    );
    child.once("error", reject);
    child.once("exit", (code) => {
      clearTimeout(timer);
      reject(new Error(`Fixture exited before ready (${code})`));
    });
    child.stderr.on("data", (data) => {
      const match = data.toString().match(/rieul-ui-ready:(\d+)/);
      if (match) {
        uiPid = Number(match[1]);
        clearTimeout(timer);
        resolve();
      }
    });
  });
  try {
    await ready;
    const exited = new Promise((resolve) => child.once("exit", resolve));
    child.kill();
    await exited;
    let alive = true;
    for (let attempt = 0; attempt < 100 && alive; attempt++) {
      try {
        process.kill(uiPid, 0);
        await new Promise((resolve) => setTimeout(resolve, 30));
      } catch {
        alive = false;
      }
    }
    assert.equal(
      alive,
      false,
      "Launcher job must kill its UI descendant on forced exit",
    );
    const unlockingStarted = Date.now();
    for (const name of ["node.exe", "bun.exe"]) {
      let unlocked = false;
      for (let attempt = 0; attempt < 160 && !unlocked; attempt++) {
        try {
          const file = await open(path.join(bundle, "runtime", name), "r+");
          await file.close();
          unlocked = true;
        } catch (error) {
          if (!["EBUSY", "EACCES"].includes(error.code)) throw error;
          await new Promise((resolve) => setTimeout(resolve, 50));
        }
      }
      assert.equal(
        unlocked,
        true,
        `Runtime image lock remained after fixture process termination: ${name}`,
      );
    }
    evidence.imageUnlockWaitMs = Date.now() - unlockingStarted;
    evidence.forcedLauncherExitKillsUi = true;
    evidence.runtimeUpgradeLocksReleased = true;
  } finally {
    child.kill();
  }
}
console.log(JSON.stringify(evidence));
