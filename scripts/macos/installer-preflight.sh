#!/bin/bash
# Read-only guard embedded verbatim in the protected PKG preinstall.
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

# Never silently leave an old per-user daemon running alongside the new runtime.
legacy_agent='/Library/LaunchAgents/app.rieul.user.plist'
if [[ -e "$legacy_agent" || -L "$legacy_agent" ]]; then
  echo "Installation deferred: explicitly retire $legacy_agent in the maintenance window." >&2
  exit 1
fi
uids="$(/bin/ps -axo uid=)"
for uid in $(printf '%s\n' "$uids" | /usr/bin/sort -un); do
  [[ "$uid" =~ ^[0-9]+$ ]] || exit 1
  [[ "$uid" != 0 ]] || continue
  target="gui/$uid/app.rieul.user"
  if output="$(/bin/launchctl print "$target" 2>&1)"; then
    echo "Installation deferred: explicitly retire registered $target in the maintenance window." >&2
    exit 1
  else
    code=$?
    if [[ "$code" == 113 && "$output" == *'Could not find service'* ]]; then
      continue
    fi
    if [[ ( "$code" == 112 || "$code" == 113 ) && "$output" == "$(printf 'Bad request.\nCould not find domain for user gui: %s' "$uid")" ]]; then
      continue
    fi
    echo "Cannot establish legacy user-agent absence for $target (status $code); refusing installation." >&2
    exit 1
  fi
done
