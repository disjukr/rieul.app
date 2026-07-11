#!/usr/bin/env bash
set -euo pipefail

VERSION=""
OUT_DIR=""
APP_NAME="Rieul"
PACKAGE_IDENTIFIER="app.rieul.desktop"
APP_SIGN_IDENTITY=""
INSTALLER_SIGN_IDENTITY=""
SKIP_BUILD=0

usage() {
  cat <<'EOF'
Usage: scripts/macos/package-desktop-pkg.sh [options]

Options:
  --version VERSION              Package version. Defaults to daemon/macos/Cargo.toml.
  --out-dir DIR                 Output directory. Defaults to dist/macos.
  --identifier IDENTIFIER       Installer package identifier. Defaults to app.rieul.desktop.
  --app-sign IDENTITY           Developer ID Application identity for the app bundle.
  --installer-sign IDENTITY     Developer ID Installer identity for the PKG.
  --skip-build                  Reuse target/release daemon binaries and Deno Desktop app.
  -h, --help                    Show this help.
EOF
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --version)
      VERSION="${2:?missing value for --version}"
      shift 2
      ;;
    --out-dir)
      OUT_DIR="${2:?missing value for --out-dir}"
      shift 2
      ;;
    --identifier)
      PACKAGE_IDENTIFIER="${2:?missing value for --identifier}"
      shift 2
      ;;
    --app-sign)
      APP_SIGN_IDENTITY="${2:?missing value for --app-sign}"
      shift 2
      ;;
    --installer-sign)
      INSTALLER_SIGN_IDENTITY="${2:?missing value for --installer-sign}"
      shift 2
      ;;
    --skip-build)
      SKIP_BUILD=1
      shift
      ;;
    -h | --help)
      usage
      exit 0
      ;;
    *)
      echo "Unknown option: $1" >&2
      usage >&2
      exit 2
      ;;
  esac
done

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"

if [[ "$(uname -s)" != "Darwin" ]]; then
  echo "macOS PKG packaging must be built on macOS." >&2
  exit 1
fi
if ! command -v pkgbuild >/dev/null 2>&1; then
  echo "pkgbuild was not found. Install the Xcode command-line tools." >&2
  exit 1
fi
if ! command -v pkgutil >/dev/null 2>&1; then
  echo "pkgutil was not found." >&2
  exit 1
fi
if [[ ! "$PACKAGE_IDENTIFIER" =~ ^[A-Za-z0-9][A-Za-z0-9.-]+$ ]]; then
  echo "Invalid package identifier: $PACKAGE_IDENTIFIER" >&2
  exit 2
fi

if [[ -z "$VERSION" ]]; then
  VERSION="$(
    sed -nE 's/^version[[:space:]]*=[[:space:]]*"([^"]+)".*/\1/p' \
      "$REPO_ROOT/daemon/macos/Cargo.toml" |
      head -n 1
  )"
fi
if [[ -z "$VERSION" ]]; then
  echo "Could not infer package version from daemon/macos/Cargo.toml." >&2
  exit 1
fi
if [[ -z "$OUT_DIR" ]]; then
  OUT_DIR="$REPO_ROOT/dist/macos"
fi

app_build_args=(
  --version "$VERSION"
  --out-dir "$OUT_DIR"
  --app-name "$APP_NAME"
  --skip-dmg
)
if [[ "$SKIP_BUILD" == "1" ]]; then
  app_build_args+=(--skip-build)
fi
if [[ -n "$APP_SIGN_IDENTITY" ]]; then
  app_build_args+=(--sign "$APP_SIGN_IDENTITY")
fi
"$SCRIPT_DIR/package-desktop-dmg.sh" "${app_build_args[@]}"

PACKAGE_BASE_NAME="rieul-macos-desktop-$VERSION"
APP_PATH="$OUT_DIR/$PACKAGE_BASE_NAME-app/$APP_NAME.app"
PKG_STAGING_DIR="$OUT_DIR/$PACKAGE_BASE_NAME-pkg"
PKG_ROOT="$PKG_STAGING_DIR/root"
PKG_SCRIPTS="$SCRIPT_DIR/pkg-scripts"
COMPONENT_PLIST="$PKG_STAGING_DIR/components.plist"
PKG_PATH="$OUT_DIR/$PACKAGE_BASE_NAME.pkg"

if [[ ! -d "$APP_PATH" ]]; then
  echo "Missing desktop app bundle: $APP_PATH" >&2
  exit 1
fi

rm -rf "$PKG_STAGING_DIR"
mkdir -p "$PKG_ROOT/Applications"
/usr/bin/ditto "$APP_PATH" "$PKG_ROOT/Applications/$APP_NAME.app"

if [[ ! -x "$PKG_SCRIPTS/postinstall" ]]; then
  echo "PKG scripts must be executable: $PKG_SCRIPTS" >&2
  exit 1
fi
/bin/bash -n "$PKG_SCRIPTS/postinstall"

pkgbuild --analyze --root "$PKG_ROOT" "$COMPONENT_PLIST"
component_index=""
index=0
while root_relative_bundle_path="$(
  /usr/libexec/PlistBuddy \
    -c "Print :$index:RootRelativeBundlePath" \
    "$COMPONENT_PLIST" 2>/dev/null
)"; do
  if [[ "$root_relative_bundle_path" == "Applications/$APP_NAME.app" ]]; then
    component_index="$index"
    break
  fi
  index=$((index + 1))
done
if [[ -z "$component_index" ]]; then
  echo "pkgbuild did not detect the Rieul app bundle in the package root." >&2
  exit 1
fi
if ! /usr/libexec/PlistBuddy \
  -c "Set :$component_index:BundleIsRelocatable false" \
  "$COMPONENT_PLIST"; then
  /usr/libexec/PlistBuddy \
    -c "Add :$component_index:BundleIsRelocatable bool false" \
    "$COMPONENT_PLIST"
fi

pkgbuild_args=(
  --root "$PKG_ROOT"
  --identifier "$PACKAGE_IDENTIFIER"
  --version "$VERSION"
  --install-location /
  --scripts "$PKG_SCRIPTS"
  --component-plist "$COMPONENT_PLIST"
  --ownership recommended
)
if [[ -n "$INSTALLER_SIGN_IDENTITY" ]]; then
  pkgbuild_args+=(--sign "$INSTALLER_SIGN_IDENTITY")
fi

rm -f "$PKG_PATH"
pkgbuild "${pkgbuild_args[@]}" "$PKG_PATH"
payload_files="$(pkgutil --payload-files "$PKG_PATH")"
if ! grep -Fq "Applications/$APP_NAME.app/Contents/MacOS/install" <<<"$payload_files"; then
  echo "PKG payload is missing the bundled Rieul install command." >&2
  exit 1
fi
if [[ -n "$INSTALLER_SIGN_IDENTITY" ]]; then
  pkgutil --check-signature "$PKG_PATH" >/dev/null
fi

echo "Wrote app: $APP_PATH"
echo "Wrote pkg: $PKG_PATH"
echo "Staging directory: $PKG_STAGING_DIR"
