#!/usr/bin/env bash
# Disposable GitHub-hosted ARM64 VM only. No signing credentials or live daemon.
set -euo pipefail
umask 077
if [[ $# -ne 3 || "${GITHUB_ACTIONS:-}" != true ||
      "${GITHUB_REPOSITORY:-}" != disjukr/rieul.app ||
      "${GITHUB_REF:-}" != refs/heads/main ||
      "${GITHUB_EVENT_NAME:-}" != workflow_dispatch ||
      "${RUNNER_ENVIRONMENT:-}" != github-hosted ||
      "$(uname -m)" != arm64 || "$(/usr/sbin/sysctl -n hw.model)" != VirtualMac* ||
      "$(/usr/bin/stat -f %u /dev/console)" != "$(/usr/bin/id -u)" ||
      "$(sudo -n /usr/bin/id -u)" != 0 ]]; then
  echo 'Refusing test outside guarded disposable hosted ARM64 VM.' >&2
  exit 1
fi
console_uid="$(/usr/bin/stat -f %u /dev/console)"
/bin/launchctl print "gui/$console_uid" >/dev/null 2>&1
for label in system/app.rieul.daemon system/app.rieul.system system/app.rieul.update-worker \
  "gui/$console_uid/app.rieul.gui" "gui/$console_uid/app.rieul.user"; do
  if output="$(sudo -n /bin/launchctl print "$label" 2>&1)"; then
    echo 'Refusing test: existing Rieul service or GUI registration.' >&2
    exit 1
  else
    rc=$?
    [[ "$rc" == 113 && "$output" == *'Could not find service'* ]] || {
      echo 'Cannot establish absence of Rieul registration.' >&2
      exit 1
    }
  fi
done
fixtures='/Library/Application Support/rieul-vm-fixtures'
for target in "$fixtures" '/Applications/Rieul.app' '/Library/Application Support/rieul' \
    /Library/LaunchDaemons/app.rieul.daemon.plist /Library/LaunchDaemons/app.rieul.system.plist \
    /Library/LaunchAgents/app.rieul.gui.plist /Library/LaunchAgents/app.rieul.user.plist; do
  [[ ! -e "$target" && ! -L "$target" ]] || { echo 'Refusing test: existing Rieul paths.' >&2; exit 1; }
done
repair_pkg="$1"
test_binary="$2"
repair_sha="$3"
[[ "$repair_sha" =~ ^[a-f0-9]{64}$ ]]
[[ -f "$repair_pkg" && ! -L "$repair_pkg" && -f "$test_binary" && -x "$test_binary" && ! -L "$test_binary" ]]
work="$(mktemp -d "${RUNNER_TEMP:?}/rieul-repair-assets.XXXXXXXX")"
trap '/bin/rm -rf -- "$work"' EXIT
asset() {
  local version="$1" file="$2" sha="$3" target="$4"
  curl --fail --silent --show-error --location --retry 2 --proto '=https' --proto-redir '=https' \
    --output "$target" "https://github.com/disjukr/rieul.app/releases/download/desktop-$version/$file"
  printf '%s  %s\n' "$sha" "$target" | /usr/bin/shasum -a 256 -c - >/dev/null
}
pkg_verified() {
  local package="$1" signature
  signature="$(/usr/sbin/pkgutil --check-signature "$package")"
  [[ "$signature" == *'Developer ID Installer:'* && "$signature" == *'(D379GLRLPV)'* ]]
  /usr/sbin/spctl --assess --type install "$package"
  xcrun stapler validate "$package" >/dev/null
}

# Verify both package identities before any privileged fixture writes. The old
# PKG is only inspected; using its matching notarized update archive below
# avoids booting a real auto-checking daemon before the test can seed the journal.
asset 0.6.23 rieul-macos-desktop.pkg cf943516a51adfad1e78c203d6f12cda2a6ef18bf3eedac6f56184a30ea40132 "$work/old.pkg"
pkg_verified "$work/old.pkg"
pkg_verified "$repair_pkg"
printf '%s  %s\n' "$repair_sha" "$repair_pkg" | /usr/bin/shasum -a 256 -c - >/dev/null
/usr/sbin/pkgutil --expand-full "$repair_pkg" "$work/repair-expanded"
script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"
python3 "$script_dir/check-device-repair-package-shape.py" "$work/repair-expanded"
/usr/bin/codesign --verify --strict -R '=anchor apple generic and identifier "rieul-macos-system" and certificate 1[field.1.2.840.113635.100.6.2.6] exists and certificate leaf[field.1.2.840.113635.100.6.1.13] exists and certificate leaf[subject.OU] = "D379GLRLPV"' "$work/repair-expanded/Scripts/rieul-repair-bootstrap"
asset 0.6.23 rieul-macos-update.tar e4396c367ea226eb07e8234c75df021ac6d706a90a71b43554b8bb9f9847ebd6 "$work/0.6.23.tar"
asset 0.6.24 rieul-macos-update.tar 4493af6a4bbb56a1dbcb99be200c27526ed2be77335b5451d7df48560d667b63 "$work/0.6.24.tar"
asset 0.6.25 rieul-macos-update.tar 23d803088106bea7ef6ce05f3d470b64431a5e8edc53bf5b7a1e35dc9f4a9ba6 "$work/0.6.25.tar"

sudo -n /bin/mkdir -m 700 "$fixtures"
for version in 0.6.23 0.6.24 0.6.25; do
  sudo -n /bin/mkdir -m 700 "$fixtures/$version"
  sudo -n /usr/bin/install -m 600 "$work/$version.tar" "$fixtures/$version/rieul-macos-update.tar"
done
printf 'rieul-issue-45-isolated-vm\n' > "$work/guest-only.txt"
sudo -n /usr/bin/install -m 600 "$work/guest-only.txt" "$fixtures/guest-only.txt"
test_operation() {
  sudo -n /usr/bin/env RIEUL_DISPOSABLE_HOSTED_REPAIR=confirmed "RIEUL_VM_TEST_OPERATION=$1" \
    "$test_binary" --ignored --exact root_update::vm_integration::signed_native_guest_operation --nocapture
}
test_operation seed-device-churn-fixture
sudo -n /usr/sbin/installer -pkg "$repair_pkg" -target /
test_operation verify-device-repair-and-prepare-0.6.25
# Deliberately no launchd registration, dispatch, service stop/start,
# internet-facing listener, production DB, or pairing. The runner is discarded.
