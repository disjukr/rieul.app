#!/bin/sh
set -eu
[ "$(uname -s)" = Darwin ] || { echo 'AppKit bridge must be built on macOS' >&2; exit 1; }
root=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
mkdir -p "$root/native/bin"
clang -fobjc-arc -std=c11 -Wall -Wextra -dynamiclib -framework Cocoa \
  "$root/native/macos.m" -o "$root/native/bin/librieul_pairing_macos.dylib"
