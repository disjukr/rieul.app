import { execFileSync } from "node:child_process";
import { readdir } from "node:fs/promises";
import path from "node:path";
import assert from "node:assert/strict";
import { deploymentTargets } from "./macos-target.mjs";

// Check the actual binaries, rather than trusting Info.plist's advertised floor.
assert.equal(process.platform, "darwin");
const root = path.resolve(process.argv[2]);
let checked = 0;
const unsupported = [];
async function visit(directory) {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const file = path.join(directory, entry.name);
    if (entry.isDirectory()) await visit(file);
    else if (entry.isFile()) {
      const kind = execFileSync("/usr/bin/file", ["-b", file], {
        encoding: "utf8",
      });
      if (!kind.includes("Mach-O")) continue;
      const headers = execFileSync("/usr/bin/otool", ["-l", file], {
        encoding: "utf8",
      });
      const targets = deploymentTargets(headers);
      assert.ok(targets.length, `Missing deployment target: ${file}`);
      for (const [major, minor] of targets)
        if (!(major < 13 || (major === 13 && minor === 0)))
          unsupported.push(`${file}: ${major}.${minor}`);
      checked++;
    }
  }
}
await visit(root);
assert.ok(checked >= 5, `Incomplete native bundle: ${checked} Mach-O images`);
assert.deepEqual(
  unsupported,
  [],
  "Mach-O deployment targets must preserve macOS 13.0",
);
console.log(
  JSON.stringify({
    root,
    machoImages: checked,
    maximumDeploymentTarget: "13.0",
  }),
);
