# macOS automatic updates — issue #45

Status: architecture proposal and read-only preflight. Automatic updates are
**not implemented or enabled** by this change. Do not close #45 or advertise
unattended installation yet. This checkpoint is intended for review before
changing the privileged service lifecycle or release packaging.

## Current installation

At main `71512313da0306bfbfa8b9cb4b2dbf4e3deb0a8f`, the product already requires
macOS 13 (`LSMinimumSystemVersion`). The system daemon is embedded at
`Contents/Library/LaunchServices/rieul-macos-system`, not copied to the old
`/Library/Application Support/rieul/bin` location. The installer removes that
old copy, writes legacy LaunchDaemon/LaunchAgent plists, makes the app root-owned,
and restarts both services. The plists launch code from the root-owned app.

The installed product is a system-wide remote administration service: filesystem
RPC and process inspection operate in the system daemon; terminal support also
handles the root process context. Moving the entire daemon to the current user
would change access and pre-login availability. Do not make that product change
as a shortcut to updating. A later privilege separation project can reduce this
surface independently.

## Proposed implementation boundary

Use Sparkle 2 for a **regular app-bundle update**, with the existing Developer ID
team `D379GLRLPV` and bundle ID `app.rieul`. Use Apple's SMAppService for the
existing daemon and GUI registration. Do not add a permanent privileged updater,
custom root install RPC, password cache, or passwordless sudo rule.

Keep the current daemon binary inside the app. Move its plist into
`Contents/Library/LaunchDaemons`, and the GUI plist into
`Contents/Library/LaunchAgents`; use `BundleProgram` paths relative to the app.
Register the daemon first, then the agent. Show the actual SMAppService status,
including `requiresApproval`, and let the user approve it in System Settings.
Respect later revocation. An absent or disabled service is not an invitation to
silently recreate a legacy root job.

Host Sparkle in the existing native GUI bridge, using its AppKit run loop. The
Rust launcher currently replaces itself with the GUI, so it cannot own a
long-lived updater object. Sparkle handles download, extraction, signature
validation, replacement, and relaunch. The GUI/daemon update coordinator must
handle service quiescence, version negotiation, and recovery around that flow.

Use a pinned official Sparkle release, HTTPS appcast, an approved Ed25519 public
key in the signed bundle, and validation before extraction. Reject a candidate
whose app or daemon has a different expected identity, even if the archive's
EdDSA signature is valid. Do not allow arbitrary commands, executable paths,
download URLs, or signing requirements to cross a privileged IPC boundary.
An initial status probe is not proof that a later staged artifact is safe.

App-bundle updates can still require authorization when the installed location
is protected. Determine whether the approved SMAppService configuration can use
an app owned by its installing user on each supported macOS version. Verify that
tampering with its daemon, plist, or enclosing bundle prevents privileged
execution. Do not change ownership until these tests pass and legacy root
launchd jobs are removed. If the supported configuration needs a root-owned app,
retain interactive updates and report that limit instead of adding a root helper.

## Existing root-owned installation migration

This is a one-time, explicitly authorized installer transaction, not code run
automatically at GUI launch:

1. Validate the existing app and staged replacement against the expected Apple
   Developer ID identities. Refuse symlinked install/service paths, unexpected
   labels, or ambiguous ownership. Use root-controlled staging for any elevated
   operation; do not validate a user-writable artifact and subsequently execute
   it as root. Keep the old app and job configuration for recovery.
2. Preflight the replacement bundle, registration availability, and data/schema
   compatibility before stopping anything. Store transaction progress durably.
3. Quiesce the old daemon and GUI. Remove the old `app.rieul.daemon` and
   `app.rieul.system` system registrations and the old `app.rieul.gui` and
   `app.rieul.user` agents. A removed plist is insufficient: confirm the loaded
   legacy root jobs have stopped. Never leave a legacy root job pointing into a
   user-writable app, including after reboot or interrupted migration.
4. Install the validated app, apply only the reviewed ownership transition,
   and ask the logged-in user to register/approve its SMAppService daemon. A
   pending approval is a distinct state, not success. If approval is declined,
   do not silently reinstall the old service against the new app. Recovery must
   first restore the protected old app and then its legacy registrations.
5. Confirm daemon and GUI version compatibility and a healthy service before
   committing the transaction. Retain settings, pairing credentials, TLS material,
   and the SQLite database under their existing locations. Never recursively
   chown data to the GUI user. The install identity stays `app.rieul`.

The transaction must be restartable at every phase. Recovery of the old service
must never run an old binary against an incompatibly migrated database. Define
schema compatibility and backup/recovery before enabling unattended updates;
successful bundle replacement alone is insufficient evidence.

## Required verification before activation

- Developer ID + EdDSA acceptance; wrong team, wrong app/daemon identifier,
  tampered archive, altered nested executable, unsigned artifact, downgrade,
  malformed version, and symlink/path substitution rejection.
- Clean install and migration from both legacy daemon locations, including
  root-owned apps, multiple logged-in users, missing/dangling plists, and loaded
  jobs whose plist has been removed.
- Approval pending, denied, later revoked, service crashed, app relocated,
  stale daemon version, and concurrent update attempts.
- Termination at every migration/update phase, startup reconciliation, failed
  health check, safe rollback, and preservation of pairing/config/database.
- Actual signed and notarized old/new bundles on supported macOS versions in a
  disposable test machine/VM. Fixtures do not establish system consent behavior.
- Existing GUI close-to-hide, tray, duplicate activation, and shutdown behavior.

Release work requires coordinated packaging changes, approved creation/storage
of the EdDSA key, appcast hosting, nested Sparkle signing, and notarized test
artifacts. None of those is performed by this preflight change. Production
service migration or registration also needs specific action-time authorization.

## Read-only diagnostic

Build the launcher and run:

```sh
cargo run -p rieul-macos-daemon --bin rieul-macos-launcher -- update-status
```

This command examines only `/Applications/Rieul.app`, its embedded daemon, fixed
legacy service paths, and loaded system jobs. It verifies expected signing
requirements, rejects symlinked executable path components, reports protected
ownership, and explicitly reports that the updater is not implemented. It does
not run the GUI or the installer, register services, download releases, read
pairing/config/database contents, or change the OS. A restricted sandbox can
prevent macOS signature verification; a failed diagnostic is not proof of
tampering. Re-run read-only verification in an environment with access to macOS
security services.

## Primary sources

- [Apple: updating helper executables](https://developer.apple.com/documentation/servicemanagement/updating-helper-executables-from-earlier-versions-of-macos)
  describes macOS 13 bundle layouts, `BundleProgram`, daemon-first registration,
  initial user authentication, and status/approval handling.
- [Sparkle package updates](https://sparkle-project.github.io/documentation/package-updates/)
  require authorization on every package install, so wrapping today's PKG does
  not meet #45.
- [Sparkle installer security](https://github.com/sparkle-project/Sparkle/blob/2.x/Documentation/Installation.md)
  describes one-time installer jobs, ownership-dependent authorization, and
  protected staging.
- [Sparkle setup](https://sparkle-project.github.io/documentation/)
  covers archive signatures, key management, packaging and signed update testing.
