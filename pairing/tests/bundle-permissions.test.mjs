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

test("public macOS payload fixes restrictive upstream modes without exposing private files", posix, async () =>
  fixture(async (root) => {
    const resources = path.join(root, "Contents/Resources");
    const licenses = path.join(resources, "pairing/licenses/fnv-1.0.7");
    const assets = path.join(resources, "pairing/assets");
    await mkdir(licenses, { recursive: true });
    await mkdir(assets);
    const files = [path.join(licenses, "LICENSE-APACHE"), path.join(licenses, "LICENSE-MIT"), path.join(assets, "tray.png"), path.join(resources, "pairing/bundle.json")];
    for (const file of files) {
      await writeFile(file, "public fixture");
      await chmod(file, 0o640);
    }
    await chmod(licenses, 0o700);
    const privateFile = path.join(resources, "private-key.pem");
    await writeFile(privateFile, "PRIVATE FIXTURE ONLY");
    await chmod(privateFile, 0o600);
    await assert.rejects(bundlePermissions(root, false, true), /Public bundle entry/);
    await bundlePermissions(root, true, true);
    for (const file of files) assert.equal(await mode(file), 0o644);
    assert.equal(await mode(licenses), 0o755);
    assert.equal(await mode(privateFile), 0o600);
    await bundlePermissions(root, false, true);
    await chmod(files[0], 0o640);
    await assert.rejects(bundlePermissions(root, false, true), /Public bundle entry/);
  }),
);

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
