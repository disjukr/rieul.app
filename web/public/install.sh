#!/bin/sh
set -eu

release_base_url="https://github.com/disjukr/rieul.app/releases/latest/download"
installer_name="rieul-macos-desktop.pkg"
checksum_name="$installer_name.sha256"

if [ "$(uname -s)" != "Darwin" ]; then
  echo "Rieul's shell installer currently supports macOS only." >&2
  echo "On Windows, run: irm https://rieul.app/install.ps1 | iex" >&2
  exit 1
fi

for command_name in curl shasum pkgutil spctl sudo; do
  if ! command -v "$command_name" >/dev/null 2>&1; then
    echo "Required command was not found: $command_name" >&2
    exit 1
  fi
done

temp_dir="$(mktemp -d "${TMPDIR:-/tmp}/rieul-install.XXXXXX")"
cleanup() {
  rm -rf "$temp_dir"
}
trap cleanup EXIT HUP INT TERM

installer_path="$temp_dir/$installer_name"
checksum_path="$temp_dir/$checksum_name"

echo "Downloading Rieul for macOS..."
curl -fsSL "$release_base_url/$installer_name" -o "$installer_path"
curl -fsSL "$release_base_url/$checksum_name" -o "$checksum_path"

expected_checksum="$(awk 'NR == 1 { print $1 }' "$checksum_path")"
case "$expected_checksum" in
  *[!0-9A-Fa-f]* | "")
    echo "The downloaded SHA-256 checksum is invalid." >&2
    exit 1
    ;;
esac
if [ "${#expected_checksum}" -ne 64 ]; then
  echo "The downloaded SHA-256 checksum is invalid." >&2
  exit 1
fi

actual_checksum="$(shasum -a 256 "$installer_path" | awk '{ print $1 }')"
expected_checksum="$(printf '%s' "$expected_checksum" | tr '[:upper:]' '[:lower:]')"
if [ "$actual_checksum" != "$expected_checksum" ]; then
  echo "SHA-256 checksum verification failed." >&2
  exit 1
fi

echo "Verifying the installer signature and notarization..."
pkgutil --check-signature "$installer_path"
spctl --assess --type install "$installer_path"

echo "Installing Rieul..."
sudo /usr/sbin/installer -pkg "$installer_path" -target /
echo "Rieul was installed successfully."
