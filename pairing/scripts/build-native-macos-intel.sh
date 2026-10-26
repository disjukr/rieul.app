#!/bin/sh
set -eu
[ "$(uname -s)" = Darwin ] && [ "$(uname -m)" = x86_64 ] || { echo 'Requires Intel macOS' >&2; exit 1; }
root=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
source_dir="$(mktemp -d "${RUNNER_TEMP:-${TMPDIR:-/tmp}}/rieul-gpuix-intel.XXXXXX")/source"
[ ! -e "$source_dir" ] || { echo 'Choose a fresh checkout for the pinned native build' >&2; exit 1; }
git clone --no-checkout https://github.com/remorses/gpuix.git "$source_dir"
git -C "$source_dir" checkout --detach 2e31b47ff6432ceebe70e7fc7b0f51a76d7d30cf
git -C "$source_dir" submodule update --init --depth 1 zed
cd "$source_dir"
bun install --frozen-lockfile
cd packages/native
MACOSX_DEPLOYMENT_TARGET=13.0 bun run build
test -f gpuix-native.darwin-x64.node
output="$root/../target/native/gpuix-0.11.0/gpuix-native.darwin-x64.node"
mkdir -p "$(dirname "$output")"
cp gpuix-native.darwin-x64.node "$output"
(cd "$(dirname "$output")" && shasum -a 256 gpuix-native.darwin-x64.node > addon.sha256)
printf '%s\n' 2e31b47ff6432ceebe70e7fc7b0f51a76d7d30cf > "$(dirname "$output")/source-commit.txt"
cat "$(dirname "$output")/addon.sha256"
printf 'RIEUL_NATIVE_ADDON=%s\n' "$output"
if [ -n "${GITHUB_ENV:-}" ]; then
  printf 'RIEUL_NATIVE_ADDON=%s\n' "$output" >> "$GITHUB_ENV"
fi
