#!/usr/bin/env bash
set -euo pipefail

LISTEN="${LISTEN:-0.0.0.0:9019}"
SKIP_BUILD="${SKIP_BUILD:-0}"
RUST_LOG="${RUST_LOG:-info}"
WEB_PORT="${WEB_PORT:-5179}"
WEB_URL="http://127.0.0.1:$WEB_PORT"

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
TMP_DIR="$REPO_ROOT/tmp/dev"
LOG_DIR="$REPO_ROOT/tmp/log"
CONFIG_PATH="$TMP_DIR/rieul.yaml"
SYSTEM_PID_FILE="$TMP_DIR/macos-system.pid"
GUI_PID_FILE="$TMP_DIR/macos-gui.pid"
WEB_PID_FILE="$TMP_DIR/macos-web.pid"
SYSTEM_OUT_LOG="$LOG_DIR/macos-system.out.log"
SYSTEM_ERR_LOG="$LOG_DIR/macos-system.err.log"
GUI_OUT_LOG="$LOG_DIR/macos-gui.out.log"
GUI_ERR_LOG="$LOG_DIR/macos-gui.err.log"
WEB_OUT_LOG="$LOG_DIR/macos-web.out.log"
WEB_ERR_LOG="$LOG_DIR/macos-web.err.log"
SYSTEM_EXE="$REPO_ROOT/target/debug/rieul-macos-system"
GUI_EXE="$REPO_ROOT/target/release/Rieul-desktop.app/Contents/MacOS/rieul-gui"

mkdir -p "$TMP_DIR" "$LOG_DIR"

if ! command -v node >/dev/null 2>&1; then
  echo "Node.js build tooling is required" >&2; exit 1
fi

show_log_tail() {
  local label="$1"
  local path="$2"
  echo
  echo "[$label] last 80 lines: $path"
  if [[ -f "$path" ]]; then
    tail -n 80 "$path" || true
  else
    echo "(missing)"
  fi
}

cleanup() {
  "$SCRIPT_DIR/kill-desktop.sh"
}

trap cleanup EXIT INT TERM

"$SCRIPT_DIR/kill-desktop.sh"

if [[ "$SKIP_BUILD" != "1" ]]; then
  cargo build -p rieul-macos-daemon --bin rieul-macos-system
  (cd "$REPO_ROOT" && node pairing/scripts/package.mjs --replace)
fi

if [[ ! -x "$SYSTEM_EXE" ]]; then
  echo "Missing $SYSTEM_EXE. Run without SKIP_BUILD=1 first." >&2
  exit 1
fi

[[ -x "$GUI_EXE" ]] || { echo "Missing $GUI_EXE. Build first." >&2; exit 1; }

sudo -v

echo "Starting rieul macOS system daemon on $LISTEN"
sudo env RUST_LOG="$RUST_LOG" "$SYSTEM_EXE" run --listen "$LISTEN" --config "$CONFIG_PATH" \
  >"$SYSTEM_OUT_LOG" 2>"$SYSTEM_ERR_LOG" &
SYSTEM_PID="$!"
echo "$SYSTEM_PID" >"$SYSTEM_PID_FILE"

echo "Starting Rieul web dev server on $WEB_URL"
(
  cd "$REPO_ROOT/web"
  exec node "$REPO_ROOT/web/node_modules/vite/bin/vite.js" --host 127.0.0.1 --port "$WEB_PORT" --strictPort
) >"$WEB_OUT_LOG" 2>"$WEB_ERR_LOG" &
WEB_PID="$!"
echo "$WEB_PID" >"$WEB_PID_FILE"

WEB_READY=0
for _ in {1..120}; do
  if curl --fail --silent --output /dev/null "$WEB_URL"; then
    WEB_READY=1
    break
  fi
  if ! kill -0 "$WEB_PID" 2>/dev/null; then
    show_log_tail "web stdout" "$WEB_OUT_LOG"
    show_log_tail "web stderr" "$WEB_ERR_LOG"
    exit 1
  fi
  sleep 0.25
done
if [[ "$WEB_READY" != "1" ]]; then
  show_log_tail "web stdout" "$WEB_OUT_LOG"
  show_log_tail "web stderr" "$WEB_ERR_LOG"
  echo "Web dev server did not become ready at $WEB_URL" >&2
  exit 1
fi

echo "Starting rieul macOS GPUiX pairing utility"
"$GUI_EXE" --config "$CONFIG_PATH" --show >"$GUI_OUT_LOG" 2>"$GUI_ERR_LOG" &
GUI_PID="$!"
echo "$GUI_PID" >"$GUI_PID_FILE"

echo
echo "System daemon pid=$SYSTEM_PID"
echo "Web dev server pid=$WEB_PID"
echo "GUI daemon pid=$GUI_PID"
echo "Dev config: $CONFIG_PATH"
echo "Logs: $LOG_DIR"
echo "WebTransport endpoint: https://$LISTEN/rieul/rpc"
echo "Press Ctrl+C to stop the desktop dev environment."

while true; do
  if ! kill -0 "$SYSTEM_PID" 2>/dev/null; then
    show_log_tail "system stdout" "$SYSTEM_OUT_LOG"
    show_log_tail "system stderr" "$SYSTEM_ERR_LOG"
    exit 1
  fi
  if ! kill -0 "$WEB_PID" 2>/dev/null; then
    show_log_tail "web stdout" "$WEB_OUT_LOG"
    show_log_tail "web stderr" "$WEB_ERR_LOG"
    exit 1
  fi
  if ! kill -0 "$GUI_PID" 2>/dev/null; then
    show_log_tail "GUI stdout" "$GUI_OUT_LOG"
    show_log_tail "GUI stderr" "$GUI_ERR_LOG"
    exit 1
  fi
  sleep 1
done
