#!/usr/bin/env bash
set -euo pipefail

LISTEN="${LISTEN:-0.0.0.0:9019}"
URL="${URL:-}"
BUILD="${BUILD:-0}"

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
CONFIG_PATH="$REPO_ROOT/tmp/dev/rieul.yaml"
SYSTEM_EXE="$REPO_ROOT/target/debug/rieul-macos-system"

if [[ "$BUILD" == "1" || ! -x "$SYSTEM_EXE" ]]; then
  cargo build -p rieul-macos-daemon --bin rieul-macos-system
fi

ARGS=(pair --listen "$LISTEN" --config "$CONFIG_PATH")
if [[ -n "$URL" ]]; then
  ARGS+=(--url "$URL")
fi

sudo "$SYSTEM_EXE" "${ARGS[@]}"
