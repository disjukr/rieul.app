#!/usr/bin/env bash
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
TMP_DIR="$REPO_ROOT/tmp/dev"
CONFIG_PATH="$TMP_DIR/rieul.yaml"
SYSTEM_EXE="$REPO_ROOT/target/debug/rieul-macos-system"
GUI_APP="$REPO_ROOT/target/release/Rieul-desktop.app"
GUI_EXE="$GUI_APP/Contents/MacOS/rieul-gui"
GUI_ROOT="$GUI_APP/Contents/Resources/pairing"
VITE_SCRIPT="$REPO_ROOT/web/node_modules/vite/bin/vite.js"
WEB_PORT="${WEB_PORT:-5179}"

has_argument() {
  local command="$1" expected="$2"
  case " $command " in
    *" $expected "*|*" \"$expected\" "*) return 0 ;;
    *) return 1 ;;
  esac
}
classify_dev_command() {
  local command="$1"
  if has_argument "$command" "$SYSTEM_EXE" && has_argument "$command" "$CONFIG_PATH"; then
    printf system
  elif has_argument "$command" "$CONFIG_PATH" && {
    has_argument "$command" "$GUI_EXE" || {
      has_argument "$command" "$GUI_ROOT/runtime/node" && has_argument "$command" "$GUI_ROOT/app/dist/host.js"
    }
  }; then
    printf gui
  elif has_argument "$command" "$VITE_SCRIPT" && has_argument "$command" "$WEB_PORT"; then
    printf web
  else
    return 1
  fi
}
stop_dev_pid() {
  local pid="$1" kind="$2" expected="$3" current
  [[ "$pid" =~ ^[0-9]+$ && "$pid" -gt 1 ]] || return 0
  current="$(ps -p "$pid" -o command= 2>/dev/null || true)"
  [[ "$current" == "$expected" ]] || return 0
  echo "Stopping this checkout's $kind development process pid=$pid"
  if [[ "$kind" == system ]]; then sudo /bin/kill "$pid" 2>/dev/null || true
  else /bin/kill "$pid" 2>/dev/null || true; fi
  for _ in {1..30}; do
    current="$(ps -p "$pid" -o command= 2>/dev/null || true)"
    [[ "$current" == "$expected" ]] || return 0
    sleep 0.1
  done
  if [[ "$kind" == system ]]; then sudo /bin/kill -9 "$pid" 2>/dev/null || true
  else /bin/kill -9 "$pid" 2>/dev/null || true; fi
}
main() {
  local pid command kind
  while read -r pid command; do
    kind="$(classify_dev_command "$command")" || continue
    stop_dev_pid "$pid" "$kind" "$command"
  done < <(ps -axo pid=,command=)
  rm -f "$TMP_DIR/macos-system.pid" "$TMP_DIR/macos-gui.pid" "$TMP_DIR/macos-web.pid"
}
# Sourcing exposes pure predicates for fixture tests and never stops processes.
if [[ "${BASH_SOURCE[0]}" == "$0" ]]; then main; fi
