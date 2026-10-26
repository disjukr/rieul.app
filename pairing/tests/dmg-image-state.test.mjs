import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { ownImageAttached } from "../scripts/dmg-image-state.mjs";

async function fixture(run) {
  const root = await mkdtemp(path.join(os.tmpdir(), "rieul-dmg-state-"));
  try {
    const own = path.join(root, "own image.dmg"),
      other = path.join(root, "other.dmg");
    await mkdir(path.join(root, "sub"));
    await writeFile(own, "fixture");
    await writeFile(other, "fixture");
    await run({ own, other, alias: `${root}/sub/../own image.dmg` });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

test("canonical owned image and exact attached device remain attached", async () => {
  await fixture(async ({ own, alias, other }) => {
    assert.equal(
      ownImageAttached(own, "/dev/disk7", [
        { image: other, device: "/dev/disk8" },
        { image: alias, device: "/dev/disk7" },
      ]),
      true,
    );
  });
});
test("authoritative absence permits completion without touching a reused device", async () => {
  await fixture(async ({ own, other }) => {
    assert.equal(ownImageAttached(own, "/dev/disk7", []), false);
    assert.equal(
      ownImageAttached(own, "/dev/disk7", [
        { image: other, device: "/dev/disk7" },
      ]),
      false,
    );
  });
});
test("rebound image, malformed or unreadable inventory fail closed", async () => {
  await fixture(async ({ own, other }) => {
    assert.throws(() =>
      ownImageAttached(own, "/dev/disk7", [
        { image: own, device: "/dev/disk9" },
      ]),
    );
    assert.throws(() => ownImageAttached(own, "/dev/disk7", null));
    assert.throws(() => ownImageAttached(own, "/dev/disk7", [{}]));
    assert.throws(() =>
      ownImageAttached(own, "/dev/disk7", [{ image: `${other}.missing` }]),
    );
  });
});
