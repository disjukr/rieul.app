#!/usr/bin/env bash
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
fixture="$(mktemp -d "${TMPDIR:-/tmp}/rieul-arch.XXXXXX")"
trap 'rm -rf "$fixture"' EXIT
cat > "$fixture/uname" <<'SH'
#!/bin/sh
case "$1" in
  -s) printf '%s\n' "$ARCH_TEST_OS" ;;
  -m) printf '%s\n' "$ARCH_TEST_MACHINE" ;;
esac
SH
cat > "$fixture/sysctl" <<'SH'
#!/bin/sh
printf '0\n'
SH
chmod +x "$fixture/uname" "$fixture/sysctl"
PATH="$fixture:$PATH" ARCH_TEST_OS=Darwin ARCH_TEST_MACHINE=arm64 /bin/bash "$SCRIPT_DIR/require-arm64.sh"
for os in Darwin Linux; do
  if PATH="$fixture:$PATH" ARCH_TEST_OS="$os" ARCH_TEST_MACHINE=x86_64 /bin/bash "$SCRIPT_DIR/require-arm64.sh" > "$fixture/error" 2>&1; then
    echo 'Unsupported build host was accepted' >&2; exit 1
  fi
  grep -q 'Unsupported platform' "$fixture/error"
done
# Test installer rejection without network, sudo, package writes, or service calls.
# Only the absolute hardware-query path in these disposable copies is replaced.
python3 - "$REPO_ROOT" "$fixture" <<'PY'
from pathlib import Path
import shlex,sys,runpy
repo,fixture=map(Path,sys.argv[1:])
check=runpy.run_path(str(repo/'scripts/macos/update-artifact.py'))['check_macho']
binary=fixture/'binary'
for header,accepted in [('cffaedfe0c000001',True),('cffaedfe07000001',False),('cafebabe00000002',False),('cffaedfe',False)]:
    binary.write_bytes(bytes.fromhex(header))
    try:
        check(binary,required=True)
        assert accepted, 'unsupported update artifact accepted'
    except ValueError:
        assert not accepted

for source,name in [('web/public/install.sh','download-install'),('scripts/macos/pkg-scripts/preinstall','preinstall'),('scripts/macos/pkg-scripts/postinstall','postinstall')]:
    text=(repo/source).read_text().replace('/usr/sbin/sysctl',shlex.quote(str(fixture/'sysctl')))
    (fixture/name).write_text(text)
PY
for script in download-install preinstall postinstall; do
  if PATH="$fixture" ARCH_TEST_OS=Darwin ARCH_TEST_MACHINE=x86_64 /bin/bash "$fixture/$script" > "$fixture/error" 2>&1; then
    echo 'Intel installer host was accepted' >&2; exit 1
  fi
  grep -q 'Intel Macs are not supported' "$fixture/error"
done
echo 'arm64 build and Intel pre-install rejection fixtures passed; no install performed'
