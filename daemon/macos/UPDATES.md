# macOS updates — issue #45

## Status

Local implementation, not production-ready or activated. Do not close #45.
The Sparkle controller, SMAppService adapter, durable coordinator, and one-time
legacy migration/recovery adapter compile. Default release packaging is unchanged.
`RieulUpdaterEnabled` is absent from production bundles; the native controller
also has an unconditional activation block pending signed lifecycle validation.
No installation, service registration, ownership change, or key creation was run.

## Architecture and permissions

Use official Sparkle 2.10.0 for regular app-bundle updates, not PKG updates.
The SDK archive SHA-256 is
`c2bf58aa8387266ac179357b1415d6f2635f044da8be41042af32425dae6da0c`.
It was downloaded into ignored `tmp/sparkle` for local compilation only.

The Rust launcher dispatches to `rieul-update-controller` only when explicitly
configured in the installed app's Info.plist. The native AppKit controller owns
one direct GUI child and Sparkle's lifetime. It sends SIGTERM only to that child
and refuses termination if the child does not finish. It never uses process-name
kills. Existing Solid/Jotai/Bunja application state is unchanged.

SMAppService uses new fixed labels `app.rieul.daemon.v2` and `app.rieul.gui.v2`.
Their bundled plists use fixed BundleProgram paths and SpawnConstraint facts:
team `D379GLRLPV`, expected signing identifier, and Developer ID category 6.
The GUI agent has KeepAlive=false; unregistering the coordinator's own agent
would kill it, so Sparkle handles GUI termination instead. Daemon registration
and approval precede GUI registration. Revoked/pending approval is not success.

Keep the app and all regular resources root-owned and non-writable by group or
others. Reject escaping symlinks and extended ACLs. No ownership relaxation,
permanent root updater, custom privileged update IPC, arbitrary root command,
password storage, or passwordless sudo is introduced. The root migration adapter
is a one-time, explicitly invoked operation; the updater never invokes it.

**This does not yet eliminate repeated administrator prompts.** Sparkle can still
request authorization to replace this protected app. Automatic downloads/installs
are disabled. A safe unattended ownership/registration design and supported-OS
proof are prerequisites to claiming the original goal is met.

## OS evidence and boundary

Apple's SMAppService documentation specifies initial daemon approval and bundled
helper locations; it does not establish every desired replacement security or
consent property. Apple's WWDC23 session explicitly states launchd plist
constraints are enforced starting in macOS Sonoma (14), not Ventura (13).
The new path therefore refuses macOS 13, which retains the existing installer.
No test on the actual host (macOS 26.2) registered a daemon or changed approval.
Tamper enforcement and approval retention on macOS 14+ remain unverified.

Do not infer that SMAppService registration alone makes a user-writable privileged
executable safe. Root protection remains mandatory even on macOS 14+ in this code.

## Update and recovery transaction

Background discovery does not stop services. The standard Sparkle user driver
is subclassed to intercept Install before replying to Sparkle. It writes and
fsyncs intent, unregisters the daemon, verifies it is absent, and persists the
stopped phase. A private descriptor-relative journal and flock exclude concurrent
controllers. Read/write paths reject symlinks and malformed records.

Only stable increasing x.y.z versions and full application ZIPs at the exact
versioned official GitHub release URL are accepted. Configuration requires an
injected public Ed25519 key, HTTPS, signed feeds, and pre-extraction validation.
Sparkle owns extraction/replacement; no custom archive extractor is introduced.

On abort or restart, validate the protected app and daemon against fixed Apple
Developer ID identities before registering anything. The actual installed version
must equal the old or target transaction version. Recovery registers the daemon
first, records pending approval, then verifies the running daemon's Security
framework identity and code-directory hash against the installed binary.
Transport/database health and schema compatibility are still activation blockers.
No automatic binary downgrade is attempted against potentially migrated data.

Sparkle's public appcast/user-driver hooks do not provide a general extracted
candidate inspection callback. Its built-in signature rules permit key rotation.
Our post-install service gate and SpawnConstraint prevent launching a wrong-team
root daemon, but strict pre-replacement same-team validation of the entire
candidate still needs resolution before production activation. Do not represent
this implementation as satisfying that acceptance criterion yet.

## One-time existing-install migration

After an explicitly authorized protected app installation, the root adapter
validates the app, known legacy plist/executable identities, fixed arguments and
service domains. It saves backups durably before stopping jobs, stops all saved
jobs before removing plists, and verifies absence. It never changes app ownership
or configuration/pairing/database files. A loaded job without a restorable plist
is rejected. An interrupted transaction replays idempotent operations.

New registration is a separate logged-in user action. If approval remains pending,
services remain offline with the backup retained. Explicit rollback requires the
same protected app version and no v2 registration, restores plists atomically,
and bootstraps only the recorded fixed services. It refuses cross-version rollback.
Native privileged effects are compiled but have not been executed; fault injection
covers the coordinator order/replay, not OS launchd behavior or root filesystem races.

## Verification and discovered packaging issue

Commands:

```sh
scripts/macos/test-update-controller.sh
scripts/macos/build-update-controller.sh "$PWD/tmp/sparkle"
scripts/macos/test-update-platform.sh
cargo test -p rieul-macos-daemon update:: --locked
```

Fixture tests cover interruption after each update/migration effect, approval
pending/retry, failed stop/health, concurrent update exclusion, version and archive
policy, wrong identity, malformed/symlinked journals, and same-version recovery.
Read-only platform tests verify the existing signed app/daemon, reject an Apple
platform binary as Rieul, and reject a tampered disposable daemon copy.
These tests do not substitute for a notarized old/new bundle update on a VM.

The existing installation's protection audit is BLOCKED: 3,708 resources have
mode 0666, nine have 0777, and two have 0776. Examples include files under
`Contents/Resources/pairing/app/node_modules/zod`. Its signatures still verify.
The installation was not modified. Coordinate permission normalization before
signing/packaging with the release task; no release scripts were changed here.

## Key approval and remaining release work

No private key was generated or read. The proposed approval is to create a
Sparkle Ed25519 archive/feed signing key in the release operator's macOS login
Keychain, then export it solely for a GitHub Actions secret named
`SPARKLE_PRIVATE_ED_KEY` in a protected `desktop-release` environment for
`disjukr/rieul.app`. Only the macOS release-signing job should consume it, with
required environment approval; repository administrators retain administration
access. Do not expose it to PR jobs or logs. Embed only the public key in Info.plist.
Creating the environment, key, secret, and workflow changes is a later approved
release action. Existing Developer ID secrets were not accessed.

Before enabling: resolve pre-replacement identity validation; add transport/schema
compatibility checks; finish packaging/nested signing/appcast publication; test
notarized old/new updates, migration, revocation, cancellation, and power loss on
supported OS versions; review GUI termination/relaunch and multi-user recovery.
Do not remove the hard activation block until that evidence exists.

## Primary sources

- [Apple helper migration](https://developer.apple.com/documentation/servicemanagement/updating-helper-executables-from-earlier-versions-of-macos)
- [Apple register semantics](https://developer.apple.com/documentation/servicemanagement/smappservice/register())
- [Apple WWDC23 environment constraints, especially 16:02](https://developer.apple.com/videos/play/wwdc2023/10266/)
- [Apple launch/library constraints](https://developer.apple.com/documentation/security/applying-launch-environment-and-library-constraints)
- [Sparkle package updates](https://sparkle-project.github.io/documentation/package-updates/)
- [Sparkle installer security](https://github.com/sparkle-project/Sparkle/blob/2.x/Documentation/Installation.md)
- [Sparkle setup and signing](https://sparkle-project.github.io/documentation/)
