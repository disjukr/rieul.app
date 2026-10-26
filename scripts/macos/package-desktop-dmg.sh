#!/usr/bin/env bash
set -euo pipefail

VERSION=""
OUT_DIR=""
APP_NAME="Rieul"
SIGN_IDENTITY=""
SKIP_BUILD=0
SKIP_DMG=0
GUI_APP_OVERRIDE=""

usage() {
  cat <<'EOF'
Usage: scripts/macos/package-desktop-dmg.sh [options]

Options:
  --version VERSION      Package version. Defaults to daemon/macos/Cargo.toml.
  --out-dir DIR         Output directory. Defaults to dist/macos.
  --app-name NAME       App bundle display name. Defaults to "Rieul".
  --sign IDENTITY       Code signing identity for codesign.
  --skip-build          Reuse target/release daemon binaries and GPUiX pairing app.
  --skip-dmg            Build only the .app bundle.
  --gui-app PATH        Use an already built candidate app (requires --skip-build).
  -h, --help            Show this help.
EOF
}

new_icns_from_svg() {
  local source_svg="$1"
  local destination_icns="$2"
  local iconset_dir="$3"

  if ! command -v node >/dev/null 2>&1; then
    echo "Warning: node was not found; skipping macOS app icon rendering." >&2
    return 1
  fi
  if ! command -v iconutil >/dev/null 2>&1; then
    echo "Warning: iconutil was not found; skipping macOS app icon rendering." >&2
    return 1
  fi

  rm -rf "$iconset_dir"
  mkdir -p "$iconset_dir"

  if ! node "$REPO_ROOT/scripts/macos/render-icon.mjs" "$source_svg" "$iconset_dir" >/dev/null 2>&1; then
    echo "Warning: failed to render macOS app icon; continuing without .icns." >&2
    return 1
  fi
  if ! iconutil -c icns "$iconset_dir" -o "$destination_icns"; then
    echo "Warning: failed to build macOS .icns; continuing without app icon." >&2
    return 1
  fi
}

layout_dmg_volume() {
  local volume_name="$1"
  local mount_dir="$2"
  local app_name="$3"

  osascript <<EOF || return 1
tell application "Finder"
  tell disk "$volume_name"
    open
    set current view of container window to icon view
    set toolbar visible of container window to false
    set statusbar visible of container window to false
    set bounds of container window to {120, 120, 700, 440}
    set view_options to the icon view options of container window
    set arrangement of view_options to not arranged
    set icon size of view_options to 112
    set text size of view_options to 13
    set position of item "$app_name.app" of container window to {165, 160}
    set position of item "Applications" of container window to {415, 160}
    update without registering applications
    delay 1
    close
  end tell
end tell
EOF

  SetFile -a C "$mount_dir" >/dev/null 2>&1 || true
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
    --app-name)
      APP_NAME="${2:?missing value for --app-name}"
      shift 2
      ;;
    --sign)
      SIGN_IDENTITY="${2:?missing value for --sign}"
      shift 2
      ;;
    --skip-build)
      SKIP_BUILD=1
      shift
      ;;
    --skip-dmg)
      SKIP_DMG=1
      shift
      ;;
    --gui-app)
      GUI_APP_OVERRIDE="${2:?missing value for --gui-app}"
      shift 2
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
  echo "macOS app/dmg packaging must be built on macOS." >&2
  exit 1
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

if [[ "$SKIP_BUILD" != "1" ]]; then
  (cd "$REPO_ROOT" && cargo build -p rieul-macos-daemon --release --bin rieul-macos-system --bin rieul-macos-launcher --locked)
  (cd "$REPO_ROOT" && node pairing/scripts/package.mjs --replace)
fi

RELEASE_DIR="$REPO_ROOT/target/release"
SYSTEM_EXE="$RELEASE_DIR/rieul-macos-system"
LAUNCHER_EXE="$RELEASE_DIR/rieul-macos-launcher"
GUI_APP="$RELEASE_DIR/Rieul-desktop.app"
if [[ -n "$GUI_APP_OVERRIDE" ]]; then
  [[ "$SKIP_BUILD" == "1" ]] || { echo '--gui-app requires --skip-build' >&2; exit 2; }
  GUI_APP="$GUI_APP_OVERRIDE"
fi
if [[ ! -x "$SYSTEM_EXE" ]]; then
  echo "Missing release binary: $SYSTEM_EXE" >&2
  exit 1
fi
if [[ ! -x "$LAUNCHER_EXE" ]]; then
  echo "Missing release binary: $LAUNCHER_EXE" >&2
  exit 1
fi
if [[ ! -d "$GUI_APP" ]]; then
  echo "Missing GPUiX pairing app: $GUI_APP" >&2
  exit 1
fi
if [[ ! -f "$GUI_APP/Contents/Resources/pairing/bundle.json" ]]; then
  echo "Missing native pairing bundle manifest" >&2; exit 1
fi
"$GUI_APP/Contents/MacOS/rieul-gui" --verify-bundle

SYSTEM_LABEL="app.rieul.daemon"
GUI_LABEL="app.rieul.gui"
# Remove the external pre-embedded LaunchDaemon when upgrading.
LEGACY_SYSTEM_LABEL="app.rieul.system"
# Remove the previous GUI LaunchAgent when upgrading an existing installation.
LEGACY_LAUNCH_AGENT_LABEL="app.rieul.user"
APP_SUPPORT_DIR="/Library/Application Support/rieul"
BIN_DIR="$APP_SUPPORT_DIR/bin"
LOG_DIR="/Library/Logs/rieul"
SYSTEM_PLIST="/Library/LaunchDaemons/$SYSTEM_LABEL.plist"
LEGACY_SYSTEM_PLIST="/Library/LaunchDaemons/$LEGACY_SYSTEM_LABEL.plist"
GUI_PLIST="/Library/LaunchAgents/$GUI_LABEL.plist"
LEGACY_LAUNCH_AGENT_PLIST="/Library/LaunchAgents/$LEGACY_LAUNCH_AGENT_LABEL.plist"
APP_DEST="/Applications/$APP_NAME.app"
LEGACY_SYSTEM_DAEMON_EXE="$BIN_DIR/rieul-macos-system"
SYSTEM_DAEMON_EXE="$APP_DEST/Contents/Library/LaunchServices/rieul-macos-system"
APP_GUI_LAUNCHER="$APP_DEST/Contents/MacOS/rieul-macos-launcher"

PACKAGE_BASE_NAME="rieul-macos-desktop-$VERSION"
STAGING_DIR="$OUT_DIR/$PACKAGE_BASE_NAME-app"
APP_PATH="$STAGING_DIR/$APP_NAME.app"
DMG_ROOT="$STAGING_DIR/dmg"
DMG_PATH="$OUT_DIR/$PACKAGE_BASE_NAME.dmg"
TMP_DMG_PATH="$OUT_DIR/$PACKAGE_BASE_NAME.tmp.dmg"
RW_DMG_PATH="$OUT_DIR/$PACKAGE_BASE_NAME.rw.dmg"
MOUNT_DIR="$STAGING_DIR/mount"
VOLUME_NAME="$APP_NAME $VERSION"

rm -rf "$STAGING_DIR"
mkdir -p "$STAGING_DIR" "$DMG_ROOT"
/usr/bin/ditto "$GUI_APP" "$APP_PATH"
mkdir -p "$APP_PATH/Contents/Library/LaunchServices"

GUI_EXECUTABLE_NAME="$(/usr/libexec/PlistBuddy -c 'Print :CFBundleExecutable' "$APP_PATH/Contents/Info.plist")"
if [[ -z "$GUI_EXECUTABLE_NAME" || ! -x "$APP_PATH/Contents/MacOS/$GUI_EXECUTABLE_NAME" ]]; then
  echo "GPUiX pairing app has no executable CFBundleExecutable." >&2
  exit 1
fi

install -m 0755 "$LAUNCHER_EXE" "$APP_PATH/Contents/MacOS/rieul-macos-launcher"
install -m 0755 "$SYSTEM_EXE" "$APP_PATH/Contents/Library/LaunchServices/rieul-macos-system"
install -m 0644 "$REPO_ROOT/rieul.svg" "$APP_PATH/Contents/Resources/rieul.svg"
APP_ICON_PLIST=""
if new_icns_from_svg \
  "$REPO_ROOT/rieul.svg" \
  "$APP_PATH/Contents/Resources/rieul.icns" \
  "$STAGING_DIR/rieul.iconset"; then
  APP_ICON_PLIST="  <key>CFBundleIconFile</key>
  <string>rieul</string>"
fi

cat >"$APP_PATH/Contents/Resources/install" <<EOF
#!/usr/bin/env bash
set -euo pipefail

if [[ "\${EUID:-\$(/usr/bin/id -u)}" -ne 0 ]]; then
  exec /usr/bin/sudo /bin/bash "\$0" "\$@"
fi

SOURCE_APP="\$(cd "\$(dirname "\$0")/../.." && pwd)"
DEST_APP="$APP_DEST"
SYSTEM_LABEL="$SYSTEM_LABEL"
LEGACY_SYSTEM_LABEL="$LEGACY_SYSTEM_LABEL"
GUI_LABEL="$GUI_LABEL"
APP_SUPPORT_DIR="$APP_SUPPORT_DIR"
BIN_DIR="$BIN_DIR"
LEGACY_SYSTEM_DAEMON_EXE="$LEGACY_SYSTEM_DAEMON_EXE"
LOG_DIR="$LOG_DIR"
SYSTEM_PLIST="$SYSTEM_PLIST"
LEGACY_SYSTEM_PLIST="$LEGACY_SYSTEM_PLIST"
GUI_PLIST="$GUI_PLIST"
LEGACY_LAUNCH_AGENT_PLIST="$LEGACY_LAUNCH_AGENT_PLIST"
SYSTEM_DAEMON_EXE="$SYSTEM_DAEMON_EXE"

if [[ ! -d "\$SOURCE_APP" ]]; then
  echo "Missing source app: \$SOURCE_APP" >&2
  exit 1
fi

echo "Installing \$DEST_APP"
/bin/mkdir -p "\$APP_SUPPORT_DIR" "\$LOG_DIR"
/usr/sbin/chown -R root:wheel "\$APP_SUPPORT_DIR"
/bin/chmod 0755 "\$APP_SUPPORT_DIR"
/usr/sbin/chown root:wheel "\$LOG_DIR"
/bin/chmod 1777 "\$LOG_DIR"

/bin/launchctl bootout system "\$SYSTEM_PLIST" >/dev/null 2>&1 || true
/bin/launchctl bootout system "\$LEGACY_SYSTEM_PLIST" >/dev/null 2>&1 || true
/bin/rm -f "\$LEGACY_SYSTEM_PLIST"

console_user="\$(/usr/bin/stat -f %Su /dev/console 2>/dev/null || true)"
console_uid=""
if [[ -n "\$console_user" && "\$console_user" != "root" ]]; then
  console_uid="\$(/usr/bin/id -u "\$console_user" 2>/dev/null || true)"
  if [[ -n "\$console_uid" ]]; then
    /bin/launchctl asuser "\$console_uid" /bin/launchctl bootout "gui/\$console_uid" "\$GUI_PLIST" >/dev/null 2>&1 || true
    /bin/launchctl asuser "\$console_uid" /bin/launchctl bootout "gui/\$console_uid" "\$LEGACY_LAUNCH_AGENT_PLIST" >/dev/null 2>&1 || true
  fi
fi

if [[ "\$SOURCE_APP" != "\$DEST_APP" ]]; then
  /bin/rm -rf "\$DEST_APP"
  /usr/bin/ditto "\$SOURCE_APP" "\$DEST_APP"
fi
/usr/sbin/chown -R root:wheel "\$DEST_APP"

/bin/rm -f "\$LEGACY_SYSTEM_DAEMON_EXE"
/bin/rmdir "\$BIN_DIR" >/dev/null 2>&1 || true

/bin/cp "\$DEST_APP/Contents/Resources/\$SYSTEM_LABEL.plist" "\$SYSTEM_PLIST"
/usr/sbin/chown root:wheel "\$SYSTEM_PLIST"
/bin/chmod 0644 "\$SYSTEM_PLIST"
/bin/launchctl bootstrap system "\$SYSTEM_PLIST" >/dev/null 2>&1 || true
/bin/launchctl enable "system/\$SYSTEM_LABEL" >/dev/null 2>&1 || true
/bin/launchctl kickstart -k "system/\$SYSTEM_LABEL" >/dev/null 2>&1 || true

/bin/rm -f "\$LEGACY_LAUNCH_AGENT_PLIST"
/bin/cp "\$DEST_APP/Contents/Resources/\$GUI_LABEL.plist" "\$GUI_PLIST"
/usr/sbin/chown root:wheel "\$GUI_PLIST"
/bin/chmod 0644 "\$GUI_PLIST"

if [[ -n "\$console_uid" ]]; then
  /bin/launchctl asuser "\$console_uid" /bin/launchctl bootstrap "gui/\$console_uid" "\$GUI_PLIST" >/dev/null 2>&1 || true
  /bin/launchctl asuser "\$console_uid" /bin/launchctl enable "gui/\$console_uid/\$GUI_LABEL" >/dev/null 2>&1 || true
  /bin/launchctl asuser "\$console_uid" /bin/launchctl kickstart -k "gui/\$console_uid/\$GUI_LABEL" >/dev/null 2>&1 || true
fi

echo "Installed Rieul Desktop."
echo "Config: $APP_SUPPORT_DIR/rieul.yaml"
echo "System daemon: $SYSTEM_DAEMON_EXE"
echo "Logs: $LOG_DIR"
EOF

cat >"$APP_PATH/Contents/Resources/uninstall" <<EOF
#!/usr/bin/env bash
set -euo pipefail

if [[ "\${EUID:-\$(/usr/bin/id -u)}" -ne 0 ]]; then
  exec /usr/bin/sudo /bin/bash "\$0" "\$@"
fi

SYSTEM_LABEL="$SYSTEM_LABEL"
SYSTEM_PLIST="$SYSTEM_PLIST"
LEGACY_SYSTEM_PLIST="$LEGACY_SYSTEM_PLIST"
GUI_PLIST="$GUI_PLIST"
LEGACY_LAUNCH_AGENT_PLIST="$LEGACY_LAUNCH_AGENT_PLIST"
LEGACY_SYSTEM_DAEMON_EXE="$LEGACY_SYSTEM_DAEMON_EXE"

echo "Uninstalling Rieul Desktop"
/bin/launchctl bootout system "\$SYSTEM_PLIST" >/dev/null 2>&1 || true
/bin/launchctl bootout system "\$LEGACY_SYSTEM_PLIST" >/dev/null 2>&1 || true

console_user="\$(/usr/bin/stat -f %Su /dev/console 2>/dev/null || true)"
if [[ -n "\$console_user" && "\$console_user" != "root" ]]; then
  console_uid="\$(/usr/bin/id -u "\$console_user" 2>/dev/null || true)"
  if [[ -n "\$console_uid" ]]; then
    /bin/launchctl asuser "\$console_uid" /bin/launchctl bootout "gui/\$console_uid" "\$GUI_PLIST" >/dev/null 2>&1 || true
    /bin/launchctl asuser "\$console_uid" /bin/launchctl bootout "gui/\$console_uid" "\$LEGACY_LAUNCH_AGENT_PLIST" >/dev/null 2>&1 || true
  fi
fi

/bin/rm -f "\$SYSTEM_PLIST" "\$LEGACY_SYSTEM_PLIST" "\$GUI_PLIST" "\$LEGACY_LAUNCH_AGENT_PLIST" "\$LEGACY_SYSTEM_DAEMON_EXE"
/bin/rmdir "$BIN_DIR" >/dev/null 2>&1 || true

echo "Removed Rieul Desktop launchd jobs and system daemon."
echo "The app bundle and configuration files were left in place."
EOF

chmod 0755 \
  "$APP_PATH/Contents/MacOS/rieul-macos-launcher" \
  "$APP_PATH/Contents/Resources/install" \
  "$APP_PATH/Contents/Resources/uninstall"
ln -s ../Resources/install "$APP_PATH/Contents/MacOS/install"
ln -s ../Resources/uninstall "$APP_PATH/Contents/MacOS/uninstall"

set_plist_string() {
  local key="$1"
  local value="$2"
  /usr/libexec/PlistBuddy -c "Set :$key $value" "$APP_PATH/Contents/Info.plist" 2>/dev/null || \
    /usr/libexec/PlistBuddy -c "Add :$key string $value" "$APP_PATH/Contents/Info.plist"
}

set_plist_bool() {
  local key="$1"
  local value="$2"
  /usr/libexec/PlistBuddy -c "Set :$key $value" "$APP_PATH/Contents/Info.plist" 2>/dev/null || \
    /usr/libexec/PlistBuddy -c "Add :$key bool $value" "$APP_PATH/Contents/Info.plist"
}

set_plist_string CFBundleDisplayName "$APP_NAME"
set_plist_string CFBundleExecutable rieul-macos-launcher
set_plist_string CFBundleIdentifier app.rieul
set_plist_string CFBundleName "$APP_NAME"
set_plist_string CFBundleShortVersionString "$VERSION"
set_plist_string CFBundleVersion "$VERSION"
set_plist_string LSMinimumSystemVersion 13.0
set_plist_bool LSUIElement true
set_plist_bool NSHighResolutionCapable true
if [[ -n "$APP_ICON_PLIST" ]]; then
  set_plist_string CFBundleIconFile rieul
fi
plutil -lint "$APP_PATH/Contents/Info.plist" >/dev/null

cat >"$APP_PATH/Contents/Resources/$SYSTEM_LABEL.plist" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>$SYSTEM_LABEL</string>
  <key>AssociatedBundleIdentifiers</key>
  <string>app.rieul</string>
  <key>ProgramArguments</key>
  <array>
    <string>$SYSTEM_DAEMON_EXE</string>
    <string>run</string>
  </array>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>
  <key>StandardOutPath</key>
  <string>$LOG_DIR/system.out.log</string>
  <key>StandardErrorPath</key>
  <string>$LOG_DIR/system.err.log</string>
  <key>EnvironmentVariables</key>
  <dict>
    <key>RUST_LOG</key>
    <string>info</string>
  </dict>
</dict>
</plist>
EOF

cat >"$APP_PATH/Contents/Resources/$GUI_LABEL.plist" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>$GUI_LABEL</string>
  <key>AssociatedBundleIdentifiers</key>
  <string>app.rieul</string>
  <key>ProgramArguments</key>
  <array>
    <string>$APP_GUI_LAUNCHER</string>
  </array>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <dict>
    <key>SuccessfulExit</key>
    <false/>
  </dict>
  <key>LimitLoadToSessionType</key>
  <string>Aqua</string>
  <key>StandardOutPath</key>
  <string>$LOG_DIR/gui.out.log</string>
  <key>StandardErrorPath</key>
  <string>$LOG_DIR/gui.err.log</string>
  <key>EnvironmentVariables</key>
  <dict>
    <key>RUST_LOG</key>
    <string>info</string>
  </dict>
</dict>
</plist>
EOF
plutil -lint \
  "$APP_PATH/Contents/Resources/$SYSTEM_LABEL.plist" \
  "$APP_PATH/Contents/Resources/$GUI_LABEL.plist" >/dev/null

RUNTIME_ENTITLEMENTS="$STAGING_DIR/runtime.entitlements"
cat >"$RUNTIME_ENTITLEMENTS" <<'EOF'
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>com.apple.security.cs.allow-jit</key>
  <true/>
</dict>
</plist>
EOF
plutil -lint "$RUNTIME_ENTITLEMENTS" >/dev/null

if [[ -n "$SIGN_IDENTITY" && "$SIGN_IDENTITY" != "-" ]]; then
  codesign_args=(--force --options runtime --timestamp --sign "$SIGN_IDENTITY")
elif [[ -n "$SIGN_IDENTITY" ]]; then
  codesign_args=(--force --options runtime --sign -)
else
  codesign_args=(--force --sign -)
fi
runtime_codesign_args=("${codesign_args[@]}")
if [[ -n "$SIGN_IDENTITY" ]]; then
  runtime_codesign_args+=(--entitlements "$RUNTIME_ENTITLEMENTS")
fi

# Every runtime/addon/bridge is signed before the enclosing app.
while IFS= read -r -d '' native_file; do
  if /usr/bin/file -b "$native_file" | grep -q 'Mach-O'; then
    codesign "${runtime_codesign_args[@]}" "$native_file"
  fi
done < <(find "$APP_PATH/Contents/Resources/pairing" -type f -print0)
# Signing modifies Mach-O bytes. Refresh hashes before signing the outer app.
node "$REPO_ROOT/pairing/scripts/refresh-manifest.mjs" "$APP_PATH/Contents/Resources/pairing"

codesign "${runtime_codesign_args[@]}" \
  --preserve-metadata=identifier \
  "$APP_PATH/Contents/MacOS/$GUI_EXECUTABLE_NAME"
codesign "${codesign_args[@]}" \
  "$APP_PATH/Contents/Library/LaunchServices/rieul-macos-system"
codesign "${codesign_args[@]}" \
  "$APP_PATH/Contents/MacOS/rieul-macos-launcher"
codesign "${codesign_args[@]}" "$APP_PATH"
"$APP_PATH/Contents/MacOS/rieul-gui" --verify-bundle
codesign --verify --deep --strict --verbose=2 "$APP_PATH"

if [[ "$SKIP_DMG" == "1" ]]; then
  echo "Wrote app: $APP_PATH"
  exit 0
fi

cp -R "$APP_PATH" "$DMG_ROOT/$APP_NAME.app"
ln -s /Applications "$DMG_ROOT/Applications"

rm -f "$TMP_DMG_PATH"
rm -f "$RW_DMG_PATH"
rm -rf "$MOUNT_DIR"
mkdir -p "$MOUNT_DIR"
DMG_SIZE_MB="$(du -sm "$DMG_ROOT" | awk '{ print $1 + 64 }')"
dmg_mounted=0
dmg_device=""
whole_image_device() {
  local entities
  entities="$(/usr/bin/plutil -extract "$2" json -o - "$1")" || return 2
  printf '%s' "$entities" | node "$REPO_ROOT/pairing/scripts/dmg-image-state.mjs" --device-json
}
dmg_image_attached() {
  local info="$STAGING_DIR/dmg-state.plist" index=0 image device
  set -- "$RW_DMG_PATH" "$dmg_device"
  hdiutil info -plist >"$info" || return 2
  [[ "$(/usr/bin/plutil -type images "$info")" == array ]] || return 2
  while /usr/libexec/PlistBuddy -c "Print :images:$index" "$info" >/dev/null 2>&1; do
    image="$(/usr/libexec/PlistBuddy -c "Print :images:$index:image-path" "$info")" || return 2
    device="$(whole_image_device "$info" "images.$index.system-entities")" || return 2
    set -- "$@" "$image" "$device"
    index=$((index + 1))
  done
  node "$REPO_ROOT/pairing/scripts/dmg-image-state.mjs" "$@"
}
detach_build_image() {
  local attempt state
  [[ "$dmg_mounted" == 1 ]] || return 0
  for attempt in 1 2 3; do
    if dmg_image_attached; then
      if [[ "$attempt" == 3 ]]; then
        [[ "${CI:-}" == true ]] || return 1
        echo "CI: detaching this build's verified image device $dmg_device"
        if hdiutil detach "$dmg_device" -force; then dmg_mounted=0; return 0; fi
      elif hdiutil detach "$dmg_device"; then dmg_mounted=0; return 0; fi
    else
      state=$?
      if [[ "$state" == 1 ]]; then
        echo "Owned image is no longer attached; detachment confirmed by OS inventory."
        dmg_mounted=0
        return 0
      fi
      return 1
    fi
    sleep 1
  done
  # DiskArbitration can time out after the image actually detached.
  # Confirm the postcondition rather than trusting a vanished mount directory.
  if dmg_image_attached; then return 1; else state=$?; fi
  if [[ "$state" == 1 ]]; then dmg_mounted=0; return 0; fi
  return 1
}
cleanup_dmg_mount() {
  if [[ "$dmg_mounted" == 1 ]]; then
    detach_build_image || echo "Could not detach temporary image at $MOUNT_DIR" >&2
  fi
}
trap cleanup_dmg_mount EXIT
hdiutil create \
  -size "${DMG_SIZE_MB}m" \
  -fs HFS+ \
  -volname "$VOLUME_NAME" \
  "$RW_DMG_PATH"
hdiutil attach "$RW_DMG_PATH" -mountpoint "$MOUNT_DIR" -nobrowse -plist >"$STAGING_DIR/dmg-attach.plist"
dmg_mounted=1
dmg_device="$(whole_image_device "$STAGING_DIR/dmg-attach.plist" system-entities)"
[[ "$dmg_device" =~ ^/dev/disk[0-9]+$ ]] || { echo "Invalid owned image device" >&2; exit 1; }
/usr/bin/ditto "$DMG_ROOT" "$MOUNT_DIR"
if [[ "${CI:-}" == true ]]; then
  # Headless runners cannot reliably resolve the new Finder disk and can retain
  # its mount after AppleScript fails. Keep interactive layout for user builds.
  echo "CI: skipping interactive Finder layout; mounted payload checks remain enabled."
elif ! layout_dmg_volume "$VOLUME_NAME" "$MOUNT_DIR" "$APP_NAME"; then
  echo "Warning: failed to apply Finder DMG layout; continuing with default layout." >&2
fi
"$MOUNT_DIR/$APP_NAME.app/Contents/MacOS/rieul-gui" --verify-bundle
codesign --verify --deep --strict "$MOUNT_DIR/$APP_NAME.app"
detach_build_image
hdiutil convert "$RW_DMG_PATH" \
  -ov \
  -format UDZO \
  -imagekey zlib-level=9 \
  -o "$TMP_DMG_PATH"
mv -f "$TMP_DMG_PATH" "$DMG_PATH"
rm -f "$RW_DMG_PATH"

if [[ -n "$SIGN_IDENTITY" ]]; then
  dmg_codesign_args=(--force --sign "$SIGN_IDENTITY")
  if [[ "$SIGN_IDENTITY" != "-" ]]; then dmg_codesign_args+=(--timestamp); fi
  codesign "${dmg_codesign_args[@]}" "$DMG_PATH"
  codesign --verify --verbose=2 "$DMG_PATH"
fi

echo "Wrote app: $APP_PATH"
echo "Wrote dmg: $DMG_PATH"
