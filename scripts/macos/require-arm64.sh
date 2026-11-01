#!/usr/bin/env bash
# Build/development must use a native Apple Silicon shell, including under Rosetta.
if [[ "$(uname -s)" != "Darwin" || "$(uname -m)" != "arm64" ]]; then
  echo "Unsupported platform: Rieul macOS requires Apple Silicon (arm64). Intel Macs and x86_64/Rosetta build shells are not supported." >&2
  exit 1
fi
