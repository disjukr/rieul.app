#!/usr/bin/env bash
set -euo pipefail
REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
mkdir -p "$REPO_ROOT/pairing/artifacts"
STAGING_DIR="$(mktemp -d "$REPO_ROOT/pairing/artifacts/dmg-smoke.XXXXXX")"
RW_DMG_PATH="$STAGING_DIR/fixture.dmg"
MOUNT_DIR="$STAGING_DIR/mount"
# This fixture never forces detachment, including on CI.
CI=false
dmg_mounted=0 dmg_device=""
for name in whole_image_device dmg_image_attached detach_build_image; do
  awk -v name="$name" '$0 == name "() {" {copy=1} copy {print} copy && /^}/ {exit}' "$REPO_ROOT/scripts/macos/package-desktop-dmg.sh"
done > "$STAGING_DIR/functions.sh"
source "$STAGING_DIR/functions.sh"
cleanup() {
  local result=$?
  if [[ "$result" != 0 ]]; then
    for diagnostic in attach.plist dmg-state.plist; do
      if [[ -f "$STAGING_DIR/$diagnostic" ]]; then
        echo "DMG fixture diagnostic: $diagnostic"
        plutil -p "$STAGING_DIR/$diagnostic"
      fi
    done
  fi
  if [[ "$dmg_mounted" == 1 ]]; then detach_build_image || return 1; fi
  return "$result"
}
trap cleanup EXIT
mkdir "$MOUNT_DIR"
hdiutil create -size 16m -fs HFS+ -volname RieulMigrationFixture "$RW_DMG_PATH"
hdiutil attach "$RW_DMG_PATH" -mountpoint "$MOUNT_DIR" -nobrowse -plist > "$STAGING_DIR/attach.plist"
dmg_mounted=1
dmg_device="$(whole_image_device "$STAGING_DIR/attach.plist" system-entities)"
dmg_image_attached
printf 'isolated migration fixture\n' > "$MOUNT_DIR/fixture.txt"
test "$(cat "$MOUNT_DIR/fixture.txt")" = 'isolated migration fixture'
detach_build_image
if dmg_image_attached; then exit 1; else state=$?; fi
test "$state" = 1
hdiutil convert "$RW_DMG_PATH" -format UDZO -o "$STAGING_DIR/verified.dmg"
hdiutil verify "$STAGING_DIR/verified.dmg"
echo 'Real owned-image attach, inventory, payload, detach, absence and checksum passed.'
