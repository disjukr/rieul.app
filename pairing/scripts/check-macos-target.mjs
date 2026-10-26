import { execFileSync } from "node:child_process";
import { readdir } from "node:fs/promises";
import path from "node:path";
import assert from "node:assert/strict";

// Check the actual binaries, rather than trusting Info.plist's advertised floor.
assert.equal(process.platform, "darwin");
const root = path.resolve(process.argv[2]);
let checked = 0;
async function visit(directory) {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const file = path.join(directory, entry.name);
    if (entry.isDirectory()) await visit(file);
    else if (entry.isFile()) {
      const kind = execFileSync("/usr/bin/file", ["-b", file], { encoding: "utf8" });
      if (!kind.includes("Mach-O")) continue;
      const headers = execFileSync("/usr/bin/otool", ["-l", file], { encoding: "utf8" });
      const deployment = headers.split(/Load command \d+/).filter((block) =>
        /cmd LC_(?:BUILD_VERSION|VERSION_MIN_MACOSX)\b/.test(block));
      const targets = deployment.flatMap((block) =>
        [...block.matchAll(/(?:minos|version)\s+(\d+)\.(\d+)(?:\.\d+)?/g)]);
      assert.ok(targets.length, `Missing deployment target: ${file}`);
      for (const [, major, minor] of targets)
        assert.ok(Number(major) < 13 || (Number(major) === 13 && Number(minor) === 0),
          `macOS deployment target exceeds 13.0: ${file}: ${major}.${minor}`);
      checked++;
    }
  }
}
await visit(root);
assert.ok(checked >= 5, `Incomplete native bundle: ${checked} Mach-O images`);
console.log(JSON.stringify({ root, machoImages: checked, maximumDeploymentTarget: "13.0" }));
