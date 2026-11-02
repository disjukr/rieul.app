#!/usr/bin/env python3
"""Synthetic command/filesystem fixtures; never invokes host launchctl or installs."""
import os
from pathlib import Path
import subprocess
import tempfile

root = Path(__file__).resolve().parents[2]
source = (root / 'scripts/macos/installer-preflight.sh').read_text()
with tempfile.TemporaryDirectory() as name:
    tmp = Path(name)
    fake = tmp / 'launchctl'
    fake.write_text('''#!/bin/bash
printf '%s\\n' "$*" >> "$CALLS"
case "$SCENARIO" in
 running) echo 'state = running'; exit 0;;
 ambiguous) echo 'Operation not permitted'; exit 1;;
 wrong113) echo 'Unexpected error'; exit 113;;
 *) echo 'Bad request. Could not find service'; exit 113;;
esac
''')
    fake.chmod(0o755)
    script = tmp / 'guard'
    script.write_text(source.replace('/bin/launchctl', str(fake)).replace('/Library/Application Support/rieul', str(tmp / 'data')).replace('/Library/LaunchDaemons', str(tmp / 'launchdaemons')))
    for scenario, expected in [('running', 1), ('ambiguous', 1), ('wrong113', 1), ('absent', 0)]:
        calls = tmp / 'calls'
        calls.write_text('')
        result = subprocess.run(['/bin/bash', str(script)], env={**os.environ, 'SCENARIO': scenario, 'CALLS': str(calls)}, capture_output=True, text=True)
        assert result.returncode == expected, (scenario, result.stderr)
        assert all(line.startswith('print system/app.rieul.') for line in calls.read_text().splitlines())
    (tmp / 'launchdaemons').mkdir()
    legacy = tmp / 'launchdaemons/app.rieul.daemon.plist'
    legacy.write_text('stopped legacy registration')
    result = subprocess.run(['/bin/bash', str(script)], env={**os.environ, 'SCENARIO': 'absent', 'CALLS': str(calls)}, capture_output=True)
    assert result.returncode == 1
    legacy.unlink()
    (tmp / 'data').mkdir()
    for entry in ['updates', 'service']:
        path = tmp / 'data' / entry
        path.symlink_to(tmp / 'missing')
        result = subprocess.run(['/bin/bash', str(script)], env={**os.environ, 'SCENARIO': 'absent', 'CALLS': str(calls)}, capture_output=True)
        assert result.returncode == 1
        path.unlink()
# Ensure both mutation entry points embed the tested guard before payload writes.
pkg = (root / 'scripts/macos/package-desktop-pkg.sh').read_text()
assert 'cat "$SCRIPT_DIR/installer-preflight.sh" >> "$PKG_SCRIPTS/preinstall"' in pkg
app = (root / 'scripts/macos/package-desktop-dmg.sh').read_text().split('cat >"$APP_PATH/Contents/Resources/uninstall"')[0]
assert app.index('$INSTALL_PREFLIGHT') < app.index('echo "Installing')
assert '/bin/launchctl bootout system' not in app
assert '/bin/launchctl bootstrap system' not in app
assert 'migrate-updater' in app and 'migration-result.json' in app
assert 'chown -R root:wheel "\\$APP_SUPPORT_DIR"' not in app
print('Installer busy/unknown/state/symlink refusal and migration wiring fixtures passed')

assert '<string>$APP_SUPPORT_DIR/service/rieul-macos-system</string>' in (root / 'scripts/macos/package-desktop-dmg.sh').read_text()

# Optional actual expanded package check used by macOS CI.
import hashlib
import json
import plistlib
import sys
if len(sys.argv) == 2:
    app = Path(sys.argv[1])
    manifest = json.loads((app / 'Contents/Resources/rieul-update.json').read_text())
    info = plistlib.loads((app / 'Contents/Info.plist').read_bytes())
    assert manifest['version'] == info['CFBundleShortVersionString']
    daemon = app / 'Contents/Library/LaunchServices/rieul-macos-system'
    assert manifest['daemon_sha256'] == hashlib.sha256(daemon.read_bytes()).hexdigest()
    plist = plistlib.loads((app / 'Contents/Resources/app.rieul.daemon.plist').read_bytes())
    assert plist['ProgramArguments'] == ['/Library/Application Support/rieul/service/rieul-macos-system', 'run']
    installer = app / 'Contents/Resources/install'
    text = installer.read_text()
    assert text.index('Installation deferred') < text.index('echo "Installing')
    assert 'bootstrap system' not in text and 'bootout system' not in text
    assert 'migrate-updater' in text and 'migration-result.json' in text
    subprocess.run(['/bin/bash', '-n', str(installer)], check=True)
    print('Actual signed payload manifest/digest, protected registration and guarded migration verified')
