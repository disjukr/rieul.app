#!/usr/bin/env python3
"""Synthetic command/filesystem fixtures; never invokes host launchctl or installs."""
import os
from pathlib import Path
import subprocess
import tempfile

root = Path(__file__).resolve().parents[2]
source = (root / 'scripts/macos/installer-preflight.sh').read_text()
with tempfile.TemporaryDirectory() as name:
    tmp = Path(name).resolve()
    ps = tmp / 'ps'
    ps.write_text('#!/bin/bash\necho 501\n')
    ps.chmod(0o755)
    fake = tmp / 'launchctl'
    fake.write_text('''#!/bin/bash
printf '%s\\n' "$*" >> "$CALLS"
if [[ "$SCENARIO" == legacyjob && "$2" == gui/501/app.rieul.user ]]; then echo registered; exit 0; fi
case "$SCENARIO" in
 running) echo 'state = running'; exit 0;;
 ambiguous) echo 'Operation not permitted'; exit 1;;
 wrong113) echo 'Unexpected error'; exit 113;;
 *) echo 'Bad request. Could not find service'; exit 113;;
esac
''')
    fake.chmod(0o755)
    script = tmp / 'guard'
    script.write_text(source.replace('/bin/ps', str(ps)).replace('/Library/LaunchAgents', str(tmp / 'agents')).replace('/bin/launchctl', str(fake)).replace('/Library/Application Support/rieul', str(tmp / 'data')).replace('/Library/LaunchDaemons', str(tmp / 'launchdaemons')))
    for scenario, expected in [('running', 1), ('ambiguous', 1), ('wrong113', 1), ('absent', 0), ('legacyjob', 1)]:
        calls = tmp / 'calls'
        calls.write_text('')
        result = subprocess.run(['/bin/bash', str(script)], env={**os.environ, 'SCENARIO': scenario, 'CALLS': str(calls)}, capture_output=True, text=True)
        assert result.returncode == expected, (scenario, result.stderr)
        assert all(line.startswith(('print system/app.rieul.', 'print gui/501/app.rieul.user')) for line in calls.read_text().splitlines())
    (tmp / 'launchdaemons').mkdir()
    legacy = tmp / 'launchdaemons/app.rieul.daemon.plist'
    legacy.write_text('stopped legacy registration')
    result = subprocess.run(['/bin/bash', str(script)], env={**os.environ, 'SCENARIO': 'absent', 'CALLS': str(calls)}, capture_output=True)
    assert result.returncode == 1
    legacy.unlink()
    (tmp / 'agents').mkdir()
    legacy = tmp / 'agents/app.rieul.user.plist'
    for dangling in [False, True]:
        if dangling: legacy.symlink_to(tmp / 'missing')
        else: legacy.write_text('old user agent')
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
# The only privileged entry is protected PKG Scripts. Public bundle install is inert.
pkg = (root / 'scripts/macos/package-desktop-pkg.sh').read_text()
assert 'cat "$SCRIPT_DIR/installer-preflight.sh" >> "$PKG_SCRIPTS/preinstall"' in pkg
assert '"$PKG_SCRIPTS/rieul-installer-bootstrap"' in pkg
app = (root / 'scripts/macos/package-desktop-dmg.sh').read_text().split('cat >"$APP_PATH/Contents/Resources/uninstall"')[0]
installer = app.split('cat >"$APP_PATH/Contents/Resources/install"')[1]
assert 'sudo' not in installer and 'migrate-updater' not in installer
assert 'exit 1' in installer
post = (root / 'scripts/macos/pkg-scripts/postinstall').read_text()
assert '"$bootstrap" migrate-updater' in post
assert post.index('/usr/bin/codesign --verify') < post.index('"$bootstrap" migrate-updater')
assert '/Applications/Rieul.app' not in post
assert 'bootstrap="$script_dir/rieul-installer-bootstrap"' in post
# Execute the real postinstall control flow with only OS boundaries redirected.
# A substituted public executable is never invoked; rejected bootstrap signatures
# fail before invoking even the protected candidate. No real launchctl/root calls.
with tempfile.TemporaryDirectory() as name:
    tmp = Path(name).resolve()
    scripts = tmp / 'Scripts'
    scripts.mkdir()
    bootstrap = scripts / 'rieul-installer-bootstrap'
    bootstrap.write_text('#!/bin/bash\necho protected >> "$CALLS"\nexit 42\n')
    bootstrap.chmod(0o755)
    public = tmp / 'Applications/Rieul.app/Contents/MacOS'
    public.mkdir(parents=True)
    (public / 'install').write_text('#!/bin/bash\necho ATTACK >> "$CALLS"\n')
    verifier = tmp / 'codesign'
    verifier.write_text('#!/bin/bash\n[[ "${!#}" == "$EXPECTED_BOOTSTRAP" && "$VERIFY" == yes ]]\n')
    verifier.chmod(0o755)
    stat = tmp / 'stat'
    stat.write_text('#!/bin/bash\necho 0\n')
    stat.chmod(0o755)
    test_post = scripts / 'postinstall'
    test_post.write_text(post.replace('"$EUID"', '"0"').replace('/usr/bin/codesign', str(verifier)).replace('/usr/bin/stat', str(stat)).replace('/Library/Logs/rieul', str(tmp / 'logs')))
    calls = tmp / 'calls'
    for verified, expected in [('yes', 42), ('no', 1)]:
        calls.write_text('')
        result = subprocess.run(['/bin/bash', str(test_post)], env={**os.environ, 'CALLS': str(calls), 'EXPECTED_BOOTSTRAP': str(bootstrap), 'VERIFY': verified}, capture_output=True)
        assert result.returncode == expected, result.stderr
        assert calls.read_text() == ('protected\n' if verified == 'yes' else '')
print('Installer refusal and protected PKG bootstrap wiring fixtures passed')

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
    assert 'sudo' not in text and 'migrate-updater' not in text
    assert 'exit 1' in text
    subprocess.run(['/bin/bash', '-n', str(installer)], check=True)
    print('Actual signed payload manifest/digest, protected registration and inert public installer verified')
