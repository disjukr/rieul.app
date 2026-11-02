#!/bin/bash
# Read-only guard, embedded verbatim in both the PKG preinstall and app installer.
# An old daemon has no authenticated drain barrier: never guess it is idle.
set -euo pipefail
for target in system/app.rieul.daemon system/app.rieul.system; do
  if output="$(/bin/launchctl print "$target" 2>&1)"; then
    echo "Installation deferred: $target is registered. Close clients and finish work, then stop it in an approved maintenance window before installation." >&2
    exit 1
  else
    code=$?
    if [[ "$code" != 113 || "$output" != *'Could not find service'* ]]; then
      echo "Cannot establish service absence for $target (status $code); refusing installation." >&2
      exit 1
    fi
  fi
done
# Never overwrite an activated updater or an interrupted transaction with PKG.
# Recover an interrupted first migration using the signed migrate-updater CLI.
if [[ -e '/Library/Application Support/rieul/updates' || -L '/Library/Application Support/rieul/updates' || -e '/Library/Application Support/rieul/service' || -L '/Library/Application Support/rieul/service' ]]; then
  echo 'Protected updater state exists. Use updater RPC, or recover the existing migration; do not overwrite it with an installer.' >&2
  exit 1
fi

# A stopped legacy plist could restart from the public bundle after a crash or
# reboot during PKG payload replacement. Maintenance must archive these first.
for plist in /Library/LaunchDaemons/app.rieul.daemon.plist /Library/LaunchDaemons/app.rieul.system.plist; do
  if [[ -e "$plist" || -L "$plist" ]]; then
    echo "Installation deferred: archive the stopped legacy registration $plist outside LaunchDaemons in the approved maintenance window." >&2
    exit 1
  fi
done
