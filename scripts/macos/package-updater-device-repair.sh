#!/usr/bin/env bash
# Build only. Official signing, notarization and a signed VM fixture are
# required before distributing this one-time, no-payload administrative repair.
set -euo pipefail
if [[ $# -ne 3 || "$(uname -s)" != Darwin || "$(uname -m)" != arm64 ]]; then
  echo 'Usage on arm64 macOS: package-updater-device-repair.sh SIGNED_DAEMON INSTALLER_ID OUTPUT.pkg' >&2
  exit 2
fi
daemon="$1"
installer="$2"
output="$3"
[[ "$output" == *.pkg && ! -e "$output" && ! -L "$output" && -n "$installer" ]]
repo="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd -P)"
stage="$(mktemp -d)"
trap 'rm -rf -- "$stage"' EXIT
/bin/mkdir -m 700 "$stage/scripts"
/usr/bin/install -m 0755 "$daemon" "$stage/scripts/rieul-repair-bootstrap"
/usr/bin/install -m 0755 "$repo/scripts/macos/pkg-scripts-device-repair/postinstall" "$stage/scripts/postinstall"
/usr/bin/codesign --verify --strict -R '=anchor apple generic and identifier "rieul-macos-system" and certificate 1[field.1.2.840.113635.100.6.2.6] exists and certificate leaf[field.1.2.840.113635.100.6.1.13] exists and certificate leaf[subject.OU] = "D379GLRLPV"' "$stage/scripts/rieul-repair-bootstrap"
/bin/bash -n "$stage/scripts/postinstall"
"$stage/scripts/rieul-repair-bootstrap" repair-prepared-device --help >/dev/null
# The bootstrap travels in signed Installer Scripts and is not installed or
# invoked from a user-writable path. No DMG/regular installer is modified.
/usr/bin/pkgbuild --nopayload --identifier app.rieul.updater-device-repair --version 1.0.0 \
  --scripts "$stage/scripts" --sign "$installer" "$output"
/usr/sbin/pkgutil --check-signature "$output"
echo 'Notarize with the official CI identity, then staple and verify before testing.'
