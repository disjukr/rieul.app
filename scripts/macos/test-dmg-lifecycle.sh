#!/usr/bin/env bash
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
# Load only the lifecycle function, never execute packaging or any OS operation.
# macOS Bash 3.2 cannot reliably source a process-substitution pipe.
# A regular file also lets extraction finish before the fixture is loaded.
fixture_source="$(mktemp "${TMPDIR:-/tmp}/rieul-dmg-fixture.XXXXXX")"
trap 'rm -f "$fixture_source"' EXIT
awk '/^detach_build_image\(\) \{/ {copy=1} copy {print} copy && /^}/ {exit}' "$ROOT/scripts/macos/package-desktop-dmg.sh" > "$fixture_source"
source "$fixture_source"
declare -F detach_build_image >/dev/null
dmg_image_attached() {
  checks=$((checks + 1))
  case "$scenario:$checks" in
    absent:*|timeout:2|force-timeout:4) return 1 ;;
    unknown:*) return 2 ;;
    *) return 0 ;;
  esac
}
hdiutil() { calls=$((calls + 1)); log="$log|$*"; return "$detach_result"; }
sleep() { :; }
check() { if ! "$@"; then echo "DMG fixture failed: $scenario" >&2; exit 1; fi; }
run_case() {
  scenario="$1" CI="$2" detach_result="$3"
  local expected="$4" expected_calls="$5" expected_mounted="$6" result
  dmg_mounted=1 dmg_device=/dev/disk7 calls=0 checks=0 log=""
  if detach_build_image; then result=0; else result=$?; fi
  check test "$result" = "$expected"
  check test "$calls" = "$expected_calls"
  check test "$dmg_mounted" = "$expected_mounted"
  case "$scenario" in
    persistent|force-timeout) check test "$log" = '|detach /dev/disk7|detach /dev/disk7|detach /dev/disk7 -force' ;;
    user) check test "$log" = '|detach /dev/disk7|detach /dev/disk7' ;;
    *) if [[ "$log" == *-force* ]]; then exit 1; fi ;;
  esac
}
run_case absent true 1 0 0 0
run_case unknown true 1 1 0 1
run_case timeout true 1 0 1 0
run_case persistent true 1 1 3 1
run_case force-timeout true 1 0 3 0
run_case user false 1 1 2 1
run_case success true 0 0 1 0
dmg_mounted=0 calls=0
detach_build_image
check test "$calls" = 0
echo "8 scoped DMG lifecycle fixtures passed; no OS commands executed."
