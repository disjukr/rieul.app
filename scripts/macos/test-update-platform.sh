#!/usr/bin/env bash
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
OUT="$ROOT/tmp/update-platform-tests"
mkdir -p "$OUT/modules"
swiftc -swift-version 5 -target "$(uname -m)-apple-macos13.0" \
  -module-cache-path "$OUT/modules" -framework Security -framework ServiceManagement \
  "$ROOT/daemon/macos/updater/Coordinator.swift" \
  "$ROOT/daemon/macos/updater/Platform.swift" \
  "$ROOT/daemon/macos/updater/PlatformTests.swift" -o "$OUT/tests"
"$OUT/tests"
