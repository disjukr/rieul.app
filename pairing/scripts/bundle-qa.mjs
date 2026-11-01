import assert from "node:assert/strict";
import path from "node:path";
import { readFile, writeFile, open, mkdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";
import { execute } from "./build-tools.mjs";
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
const hostFile = path.join(bundle, "assets/tray.png");
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
console.log(JSON.stringify(evidence));
