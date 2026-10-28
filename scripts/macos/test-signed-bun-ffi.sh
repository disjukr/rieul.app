#!/usr/bin/env bash
set -euo pipefail

# Run against the final signed app, before notarization/upload. This does not
# launch the GUI, daemon, installer, or access pairing/user configuration.
APP_PATH="${1:?usage: test-signed-bun-ffi.sh /path/to/Rieul.app}"
BUN_PATH="$APP_PATH/Contents/Resources/pairing/runtime/bun"
codesign --verify --deep --strict "$APP_PATH"
"$APP_PATH/Contents/MacOS/rieul-gui" --verify-bundle
python3 - "$APP_PATH" <<'PY'
import pathlib, plistlib, re, subprocess, sys

app = pathlib.Path(sys.argv[1]).resolve()
prefix = "com.apple.security.cs."
jit = {prefix + "allow-jit": True}
bun = dict(jit, **{prefix + "allow-unsigned-executable-memory": True})
pairing = app / "Contents/Resources/pairing"
targets = {
    pairing / "runtime/bun": bun,
    pairing / "runtime/node": jit,
    pairing / "app/native/bin/librieul_pairing_macos.dylib": (jit, {}),
    app / "Contents/MacOS/rieul-gui": jit,
    app / "Contents/MacOS/rieul-macos-launcher": {},
    app / "Contents/Library/LaunchServices/rieul-macos-system": {},
    app: {},
}
addons = list((pairing / "app/node_modules/@gpuix").glob("**/*.node"))
if not addons:
    raise SystemExit("Missing GPUiX native addon")
targets.update({p: (jit, {}) for p in addons})
for binary, expected in targets.items():
    result = subprocess.run(["codesign", "-d", "--entitlements", "-", str(binary)],
                            check=True, capture_output=True)
    raw = result.stdout.strip()
    if not raw:
        actual = {}
    elif raw.startswith(b"[Dict]"):
        # Newer macOS displays DER entitlements as an abstract dictionary.
        body = raw.decode().removeprefix("[Dict]").strip()
        entry = r"\[Key\]\s+(\S+)\s+\[Value\]\s+\[Bool\]\s+(true|false)"
        matches = re.findall(entry, body)
        if re.sub(entry, "", body).strip() or len({k for k, _ in matches}) != len(matches):
            raise SystemExit("Unexpected entitlement representation")
        actual = {key: value == "true" for key, value in matches}
    else:
        actual = plistlib.loads(raw)
    allowed = expected if isinstance(expected, tuple) else (expected,)
    if actual not in allowed:
        raise SystemExit("Unexpected entitlements: " + str(binary.relative_to(app)))
    details = subprocess.run(["codesign", "-dv", str(binary)],
                             check=True, capture_output=True, text=True).stderr
    if not re.search(r"^CodeDirectory .*flags=.*\bruntime\b", details, re.MULTILINE):
        raise SystemExit("Missing hardened runtime: " + str(binary.relative_to(app)))
print("Signed bundle entitlement scope and integrity verified")
PY
"$BUN_PATH" -e '
import { dlopen, FFIType } from "bun:ffi";
const library = dlopen("/usr/lib/libSystem.B.dylib", {
  abs: { args: [FFIType.i32], returns: FFIType.i32 },
});
if (library.symbols.abs(-7) !== 7) throw new Error("FFI result mismatch");
library.close();
console.log("Signed Bun FFI smoke test passed");
'
