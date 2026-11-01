import test from "node:test";
import assert from "node:assert/strict";
import {
  mkdtemp,
  mkdir,
  writeFile,
  chmod,
  stat,
  symlink,
  link,
  rm,
} from "node:fs/promises";
import { execFileSync } from "node:child_process";
import os from "node:os";
import path from "node:path";
import { bundlePermissions } from "../scripts/bundle-permissions.mjs";

const posix = { skip: process.platform === "win32" };
async function fixture(run) {
  const base = await mkdtemp(path.join(os.tmpdir(), "rieul-permissions-"));
  const root = path.join(base, "app");
  await mkdir(root);
  try {
    await run(root, base);
  } finally {
    await rm(base, { recursive: true, force: true });
  }
}
const mode = async (file) => (await stat(file)).mode & 0o777;

test(
  "normalizes writable files/directories and preserves executable bits",
  posix,
  async () =>
    fixture(async (root) => {
      const nested = path.join(root, "nested");
      await mkdir(nested);
      await chmod(nested, 0o777);
      for (const value of [0o666, 0o664, 0o777, 0o776, 0o755]) {
        const file = path.join(nested, String(value));
        await writeFile(file, "fixture");
        await chmod(file, value);
      }
      await assert.rejects(bundlePermissions(root), /Group\/world-writable/);
      await bundlePermissions(root, true);
      assert.equal(await mode(nested), 0o755);
      for (const value of [0o666, 0o664, 0o777, 0o776, 0o755])
        assert.equal(
          await mode(path.join(nested, String(value))),
          value & ~0o022,
        );
      await bundlePermissions(root);
      await chmod(path.join(nested, String(0o666)), 0o664);
      await assert.rejects(bundlePermissions(root), /Group\/world-writable/);
    }),
);

test(
  "internal links work but escaped and root symlinks fail without touching targets",
  posix,
  async () =>
    fixture(async (root, base) => {
      const outside = path.join(base, "outside");
      await writeFile(outside, "external");
      await chmod(outside, 0o666);
      await symlink("../outside", path.join(root, "escape"));
      await assert.rejects(bundlePermissions(root, true), /escapes root/);
      assert.equal(await mode(outside), 0o666);
      await rm(path.join(root, "escape"));
      await writeFile(path.join(root, "file"), "internal");
      await symlink("file", path.join(root, "internal"));
      await bundlePermissions(root, true);
      await bundlePermissions(root);
      await symlink(root, path.join(base, "root-link"));
      await assert.rejects(
        bundlePermissions(path.join(base, "root-link"), true),
        /real directory/,
      );
    }),
);

test(
  "special files, dangling links, and hard links fail closed",
  posix,
  async () =>
    fixture(async (root, base) => {
      const fifo = path.join(root, "fifo");
      execFileSync("mkfifo", [fifo]);
      await assert.rejects(bundlePermissions(root, true), /special file/);
      await assert.rejects(bundlePermissions(root), /special file/);
      await rm(fifo);
      await symlink("missing", path.join(root, "dangling"));
      await assert.rejects(bundlePermissions(root, true), { code: "ENOENT" });
      await rm(path.join(root, "dangling"));
      const outside = path.join(base, "outside");
      await writeFile(outside, "external");
      await chmod(outside, 0o666);
      await link(outside, path.join(root, "hard-link"));
      await assert.rejects(bundlePermissions(root, true), /Hard-linked/);
      assert.equal(await mode(outside), 0o666);
    }),
);
