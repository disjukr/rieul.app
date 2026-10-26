#!/usr/bin/env bash
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "$SCRIPT_DIR/kill-desktop.sh"
SYSTEM_EXE='/fixture/한글 공백/target/debug/rieul-macos-system'
GUI_EXE='/fixture/한글 공백/Contents/MacOS/rieul-gui'
GUI_ROOT='/fixture/한글 공백/Contents/Resources/pairing'
CONFIG_PATH='/fixture/한글 공백/tmp/dev/rieul.yaml'
VITE_SCRIPT='/fixture/한글 공백/web/node_modules/vite/bin/vite.js'
expect_kind() {
  local expected="$1" command="$2" actual
  actual="$(classify_dev_command "$command" || true)"
  [[ "$actual" == "$expected" ]] || { echo "Scope predicate failure: expected $expected, got $actual" >&2; exit 1; }
}
expect_kind system "sudo env RUST_LOG=info $SYSTEM_EXE run --config $CONFIG_PATH"
expect_kind gui "\"$GUI_EXE\" --config \"$CONFIG_PATH\" --show"
expect_kind gui "$GUI_ROOT/runtime/node $GUI_ROOT/app/dist/host.js --config $CONFIG_PATH"
expect_kind web "node $VITE_SCRIPT --port 5179 --strictPort"
expect_kind '' "$GUI_ROOT/runtime/node $GUI_ROOT/app/dist/host.js --config $CONFIG_PATH.other"
expect_kind '' "/other-task/rieul-macos-system run --config $CONFIG_PATH"
expect_kind '' "node $VITE_SCRIPT --port 51790"
expect_kind '' "$SYSTEM_EXE run --config /actual-user/rieul.yaml"
echo 'macOS development predicates preserve other profiles/tasks; no process started/stopped'
