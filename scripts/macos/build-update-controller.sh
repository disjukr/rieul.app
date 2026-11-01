#!/usr/bin/env bash
set -euo pipefail
# Local compilation only. No download, signing, registration or app mutation.
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
SDK="${1:?Usage: build-update-controller.sh /path/to/Sparkle-2.10.0-directory}"
VERSION="$(/usr/libexec/PlistBuddy -c 'Print :CFBundleShortVersionString' "$SDK/Sparkle.framework/Resources/Info.plist")"
[[ "$VERSION" == "2.10.0" ]] || { echo 'Expected Sparkle 2.10.0' >&2; exit 1; }
OUT="$ROOT/tmp/update-controller"
mkdir -p "$OUT/modules"
swiftc -parse-as-library -swift-version 5 -target "$(uname -m)-apple-macos13.0" \
  -module-cache-path "$OUT/modules" -F "$SDK" -framework Sparkle \
  -framework ServiceManagement -framework Security -framework AppKit \
  -Xlinker -rpath -Xlinker @executable_path/../Frameworks \
  "$ROOT/daemon/macos/updater/Coordinator.swift" \
  "$ROOT/daemon/macos/updater/Configuration.swift" \
  "$ROOT/daemon/macos/updater/Journal.swift" \
  "$ROOT/daemon/macos/updater/Platform.swift" \
  "$ROOT/daemon/macos/updater/Migration.swift" \
  "$ROOT/daemon/macos/updater/NativeMigration.swift" \
  "$ROOT/daemon/macos/updater/SparkleHost.swift" \
  "$ROOT/daemon/macos/updater/main.swift" -o "$OUT/rieul-update-controller"
echo "Built $OUT/rieul-update-controller (not installed or signed for distribution)"
