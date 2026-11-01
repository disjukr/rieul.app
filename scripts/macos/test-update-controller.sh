#!/usr/bin/env bash
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
OUT="$ROOT/tmp/update-controller-tests"
mkdir -p "$OUT/modules"
swiftc -swift-version 5 -module-cache-path "$OUT/modules" \
  "$ROOT/daemon/macos/updater/Coordinator.swift" \
  "$ROOT/daemon/macos/updater/Configuration.swift" \
  "$ROOT/daemon/macos/updater/Journal.swift" \
  "$ROOT/daemon/macos/updater/Migration.swift" \
  "$ROOT/daemon/macos/updater/Tests.swift" -o "$OUT/tests"
"$OUT/tests"
