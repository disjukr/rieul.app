import { test } from "node:test";
import assert from "node:assert/strict";
import { deploymentTargets } from "../scripts/macos-target.mjs";
test("Mach-O floor parser excludes SDK, linker and dylib versions", () => {
  assert.deepEqual(
    deploymentTargets(`Load command 1
    cmd LC_BUILD_VERSION
    platform 1
    minos 13.0
    sdk 15.5
    ntools 1
      tool LD
   version 1167.5
Load command 2
    cmd LC_LOAD_DYLIB
    current version 1336.61.1
Load command 3
    cmd LC_VERSION_MIN_MACOSX
    version 11.0
    sdk 13.0`),
    [
      [13, 0],
      [11, 0],
    ],
  );
});
