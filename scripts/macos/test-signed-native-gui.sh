#!/usr/bin/env bash
set -euo pipefail
APP_PATH="${1:?usage: test-signed-native-gui.sh /path/to/Rieul.app}"
"$APP_PATH/Contents/MacOS/rieul-gui" --verify-bundle
codesign --verify --deep --strict "$APP_PATH"
python3 - "$APP_PATH" <<'PY'
import pathlib,plistlib,subprocess,sys
app=pathlib.Path(sys.argv[1])
for binary in [app/'Contents/MacOS/rieul-gui',app/'Contents/MacOS/rieul-macos-launcher',app/'Contents/Library/LaunchServices/rieul-macos-system',app]:
    result=subprocess.run(['codesign','-d','--entitlements','-',str(binary)],capture_output=True,check=True)
    data=result.stdout
    if data.strip():
        if b'<?xml' in data: data=data[data.index(b'<?xml'):]
        entitlements=plistlib.loads(data)
        if entitlements:raise SystemExit('Unexpected entitlements: '+str(binary))
for name in ['runtime','app/node_modules','app/dist']:
    if (app/'Contents/Resources/pairing'/name).exists():raise SystemExit('Legacy runtime payload present: '+name)
print('Native payload signatures, integrity and entitlement scope verified')
PY
