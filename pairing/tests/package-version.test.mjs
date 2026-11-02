import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, copyFile, writeFile, rm, access } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
const root = fileURLToPath(new URL('../../', import.meta.url));
test('macOS skip-build packaging rejects stale versions before staging', { skip: process.platform !== 'darwin' }, async () => {
  const temp = await mkdtemp(join(tmpdir(), 'rieul-package-version-'));
  try {
    const scripts = join(temp, 'scripts/macos');
    const release = join(temp, 'target/release');
    await mkdir(scripts, { recursive: true });
    await mkdir(release, { recursive: true });
    for (const name of ['package-desktop-dmg.sh', 'require-arm64.sh'])
      await copyFile(join(root, 'scripts/macos', name), join(scripts, name));
    async function binary(name, version) {
      await writeFile(join(release, name), `#!/bin/sh\nprintf '%s\\n' '${name} ${version}'\n`, { mode: 0o755 });
    }
    for (const [system, launcher, expected] of [
      ['9.8.6', '9.8.7', 'Build version mismatch'],
      ['9.8.7', '9.8.6', 'Build version mismatch'],
      ['9.8.7', '9.8.7', 'Missing GPUI pairing app'],
    ]) {
      await binary('rieul-macos-system', system);
      await binary('rieul-macos-launcher', launcher);
      const result = spawnSync('bash', [join(scripts, 'package-desktop-dmg.sh'), '--skip-build', '--version', '9.8.7', '--out-dir', join(temp, 'output')], { encoding: 'utf8', timeout: 10000 });
      assert.notEqual(result.status, 0);
      assert.match(result.stderr, new RegExp(expected));
      await assert.rejects(access(join(temp, 'output')));
    }
  } finally { await rm(temp, { recursive: true, force: true }); }
});
