import test from "node:test";
import assert from "node:assert/strict";
import {
  mkdtemp,
  mkdir,
  writeFile,
  readFile,
  rename,
  rm,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { publishReplacement } from "../scripts/publish.mjs";

async function fixture(run) {
  const root = await mkdtemp(path.join(os.tmpdir(), "rieul-publish-"));
  const destination = path.join(root, "current"),
    output = path.join(root, "new"),
    previous = path.join(root, "previous");
  try {
    for (const [dir, data] of [
      [destination, "old"],
      [output, "verified new"],
    ]) {
      await mkdir(dir);
      await writeFile(path.join(dir, "payload"), data);
    }
    await run({ destination, output, previous });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

test("transient Windows publication locks preserve old payload and publish verified replacement", async () => {
  await fixture(async ({ destination, output, previous }) => {
    let blocks = 0;
    await publishReplacement(output, destination, previous, {
      platform: "win32",
      pause: async () => {},
      rename: async (from, to) => {
        if (from === output && blocks++ < 3)
          throw Object.assign(new Error("scanner lock"), { code: "EPERM" });
        await rename(from, to);
      },
    });
    assert.equal(blocks, 4);
    assert.equal(
      await readFile(path.join(destination, "payload"), "utf8"),
      "verified new",
    );
    assert.equal(await readFile(path.join(previous, "payload"), "utf8"), "old");
  });
});

test("persistent publication failure is bounded and restores old payload without deleting new payload", async () => {
  await fixture(async ({ destination, output, previous }) => {
    let blocks = 0;
    await assert.rejects(
      publishReplacement(output, destination, previous, {
        platform: "win32",
        pause: async () => {},
        rename: async (from, to) => {
          if (from === output) {
            blocks++;
            throw Object.assign(new Error("persistent lock"), {
              code: "EACCES",
            });
          }
          await rename(from, to);
        },
      }),
      { code: "EACCES" },
    );
    assert.equal(blocks, 20);
    assert.equal(
      await readFile(path.join(destination, "payload"), "utf8"),
      "old",
    );
    assert.equal(
      await readFile(path.join(output, "payload"), "utf8"),
      "verified new",
    );
  });
});
