# macOS updates — issue #45

> Historical design/checkpoint notes below: the newest checkpoint is authoritative.

## Release integration checkpoint (2026-11-02)

The updater and GPUI lifecycle were validated on the isolated single-user VM
at source 7596dcb (two consecutive commits, rollback and interrupted reboot).
The subsequent 40f72789 GUI recovery corrections passed independent review and
synthetic multi-user regressions; actual simultaneous login sessions remain untested.

Official packaging now seals the update manifest after nested executable signing.
The release workflow notarizes/staples the app itself, creates the fixed
`rieul-macos-update.tar` plus SHA256, and wraps that same app in the independently
signed/notarized PKG. Existing Developer ID/notary credentials are reused.

The installer refuses registered legacy/system jobs before PKG payload replacement.
It also rejects a retained `/Library/LaunchAgents/app.rieul.user.plist`
(including dangling links) or any observed `gui/<uid>/app.rieul.user` job.
Migration repeats that legacy-agent check before GUI finalization/policy activation,
including on recovery. Only explicit service/domain absence is accepted; ambiguous
inspection fails closed. Status 125 alone is not absence evidence. For the exact
observed unsupported-domain response, migration additionally requires a successful
matching user-domain print with no GUI ASID/subdomains, an absent legacy user job,
and a repeated no-GUI association check. Unknown formats or an association fail.
This uses the installed Apple launchctl(1) contract that associated user-login
domains have their ASID displayed; background and GUI service sets are distinct.
An administrator must explicitly
retire the old agent in the maintenance window; no unknown job is terminated.
Old releases lack a trustworthy idle/drain barrier: an explicitly arranged
maintenance window is required. It does not kill legacy work. Existing protected
state blocks payload overwrite; resume a migration through the protected runtime.
The public app's `install` entry is inert and never elevates or executes code.

PKG postinstall executes a duplicate signed daemon from Installer's protected
Scripts directory, after fixed Team/daemon identity verification. That bootstrap
snapshots the public app through held directory descriptors into private root
storage, verifies its sealed signature/manifest and requires its daemon digest to
match the bootstrap before publishing or executing the runtime. Public app paths
are never a source of privileged scripts or executed daemon code.

Initial runtime publication uses `updates/service-migration-tmp` (0700), verifies and
syncs the complete executable, then atomically publishes without replacing an
established runtime. Incomplete pre-journal staging is discarded on retry; an
existing runtime with a different digest fails closed.
Publication uses fixed names and descriptor-relative RENAME_EXCL from the private
updates directory into its verified parent. The data directory remains 0755;
recursive staging cleanup still refuses public-readable parents. Actual signed
Installer testing of source 17bb316 exposed this parent-mode mismatch before
runtime publication; the regression now models the real 0755/0700 split.

Migration retains its verified app snapshot and journal through GUI finalization.
It installs the GUI plist from that snapshot, durably records target UIDs before
stopping any GUI, attempts every target, and retains failed targets for retry.
Only completed GUI finalization allows policy activation and journal retirement.
An Installer timeout does not remove recovery state. Resume with the fixed
`/Library/Application Support/rieul/service/rieul-macos-system migrate-updater`
command under administrator context; it accepts pending or already completed
migration. Never restart the old public-bundle root job. If failure occurred
before a complete runtime was published, recovery requires the verified protected
PKG bootstrap, not a public bundle command or bypassing the payload preflight.

Review-fix validation: synthetic installer checks exercise protected bootstrap
selection/signature refusal; updater regressions exercise partial runtime copy,
atomic publication/reuse, per-UID GUI failure/retry and policy ordering. These do
not replace the pending exact-source signed PKG fresh/legacy/reboot VM tests.


First-install administrator changes are limited to the signed app installation,
fixed LaunchDaemon/LaunchAgent registrations, protected service executable,
root-private updater state/policy and public-read GUI barrier. Existing configuration,
pairing and database files are retained and are not recursively chowned. A missing
fresh-install DB is initialized by the verified daemon; existing DB/sidecars must
pass protected read-only validation and compatible schema checks. Policy becomes
enabled only after nonce/PID/hash-bound readiness attests database schema 2.

This checkpoint does not authorize host installation or certify the new installer
against a newly signed fixture. Host 0.6.13 currently has a login child; application
is deferred, and partial process visibility is not evidence of zero connections.

## Historical initial status

Local, incomplete implementation on `issue-45-update-preflight`; not published,
installed, activated, or ready to close #45. The previous Sparkle/SMAppService
experiment was removed because keeping the root-owned app still required repeated
authorization. The replacement is a restricted daemon-internal updater engine.
It currently has no production startup, CLI, or RPC entry point.

Implemented: official-source download policy, private staging, restricted tar
extraction, candidate signature/notarization/manifest verification, durable
transaction coordination, native atomic exchange, orphan cleanup, and fixture
fault injection. **The production service/GUI Effects adapter, self-replacement
worker, readiness receipt writer, and initial migration are not implemented.**
The original repeated-authorization goal is therefore not yet achieved.

## Architecture and permission boundary

Retain the existing root daemon. Its filesystem/process/command/ACP operations
currently use daemon credentials; a user LaunchAgent would change capabilities,
shared data, console-user behavior, and pre-login availability. No existing remote
client gains a new updater RPC. Root-equivalent remote command access already
exists in the product and must not be represented as an updater security boundary.

The proposed runtime daemon moves to the fixed, root-protected path
`/Library/Application Support/rieul/service/rieul-macos-system`. The app remains
`/Applications/Rieul.app`. This separation is required: even a root-owned app
entry can be substituted by administrators with write access to `/Applications`.
Do not run the root service from a user-replaceable bundle or relax ownership.
No actual service path, launchd registration, or installed file has changed.

Internal policy is fixed at
`/Library/Application Support/rieul/updates/policy.json`, owned by root, mode 0600,
inside a mode-0700 state directory with protected ancestors and no extended ACLs.
Absent/disabled policy performs no network or staging work. The engine accepts
no caller-supplied URL, command, destination, identifier, or signing key.

The initial approved installer must migrate the existing fixed service to the
protected runtime path and explicitly enable the policy once. That installer,
its interruption recovery, and OS activation still require implementation and
specific action-time authorization before running on the user's Mac. Subsequent
updates should use the existing daemon authority; this is not a guarantee that
macOS will never require consent after policy/identity/system changes.

## Candidate contract

Only stable increasing `desktop-x.y.z` tags from the fixed official repository
are considered. Release metadata asset URLs are ignored. Downloads use the fixed
`rieul-macos-update.tar` name under that tag. HTTPS redirects are bounded and
restricted to GitHub API, GitHub, and GitHub release asset hosts. Proxies are
ignored, timeouts are bounded, and metadata/archive sizes are limited.

Extraction uses descriptor-relative exclusive file creation. It rejects escaping
paths, duplicates, hardlinks, device/FIFO/sparse entries, special mode bits, and
unsupported PAX metadata. Internal relative symlinks are created only after all
files; dangling links, cycles and escaping chains fail. Explicit and implicit
entry counts, path depth/length, file size and total size are bounded. Archive
ownership, ACLs and xattrs are not applied. Staging remains root-private.

Verify the staged app with strict nested codesign checks against Developer ID
team `D379GLRLPV`, app ID `app.rieul`, and daemon ID `rieul-macos-system`.
Notarization requires successful `spctl` assessment reporting
`source=Notarized Developer ID`; a generic local allow rule is insufficient.
This may require network access and fails closed when assessment cannot complete.
The signed `Contents/Resources/rieul-update.json` binds protocol 1, app version,
DB schema 2 and the embedded daemon SHA-256. Info.plist version must match.
No Sparkle key, new credential, or secret is required by this design.

`scripts/macos/update-artifact.py manifest BUILD/Rieul.app` writes the contract
before outer signing/notarization. After signing/stapling, `archive` with
`--output .../rieul-macos-update.tar` creates the expected archive. The tool does
not sign or publish; no existing release workflow was modified. Root-side
validation remains mandatory regardless of this packaging tool's checks.

## Transaction and recovery

An exclusive lock protects a private, atomic-write/fsync journal. A random nonce
binds future readiness receipts to the transaction. Download/verification leave
the running service alone. Unjournaled interrupted staging is safely discarded;
a pending transaction's rollback files are retained.

The coordinator journals intent before effects, quiesces services, revalidates,
checks DB schema, exchanges app and protected daemon independently, starts the
candidate and requires readiness. Recovery inspects both actual identities rather
than trusting journal phase, so interruption between the two swaps is replayable.
Native `renameatx_np(RENAME_SWAP)` is implemented and tested on disposable files
and directories, with same-volume enforcement and directory fsync.

Failed readiness rolls back both artifacts only while schema remains 2. Unknown
installed identities or a changed DB schema stop automatic recovery. GUI restore
failures remain retryable after committed/rolled-back journal states. No data,
pairing, settings, certificate, workspace, or DB ownership migration is attempted.

These are engine guarantees under the Effects contract, not proven production
launchd behavior. The missing adapter must authenticate running identities,
revalidate staged/rollback copies immediately before each exchange, account for
`/Applications` entry races, copy the verified daemon into protected storage,
run the worker independently of the service it stops, bind readiness to nonce,
version/hash/PID after database and transport startup, and stop/restart only known
GUI jobs for every affected user. It must never bootstrap an unknown executable.
Recovery must also run after reboot before normal service startup.

## Verification and remaining work

`cargo test -p rieul-macos-daemon root_update:: --lib --locked --offline` exercises
archive attacks, private records, locks, orphan recovery, fixed source/version
policy, manifest/DB gates, native filesystem swaps, interruption after effects,
rollback and GUI retry. It also roundtrips the artifact builder through the actual
restricted Rust extractor. Fake Effects tests do not prove launchd lifecycle.

The ignored `real_signature_checker_accepts_platform_signature_and_rejects_wrong_identity_and_tampering`
test runs the real macOS codesign verifier on an Apple platform binary and a
disposable tampered copy. It passed outside the sandbox. It does not prove a
complete notarized old/new Rieul update; such signed fixtures do not yet exist.

Remaining: implement the production lifecycle/worker/readiness/migration adapter;
integrate the build contract with release signing after coordination; obtain
notarized old/new fixtures; test multi-user sessions, initial migration, reboot,
permission races, interruption and failed health on supported macOS versions.
Keep this work isolated until those requirements and security review are complete.
The existing installation's earlier writable-resource audit was referred to the
release worker. No installed resources were changed here.

## Primary sources

- [Apple helper migration](https://developer.apple.com/documentation/servicemanagement/updating-helper-executables-from-earlier-versions-of-macos)
- [Apple WWDC23 launch constraints: macOS 14 enforcement](https://developer.apple.com/videos/play/wwdc2023/10266/)
- [Sparkle package updates always require authorization](https://sparkle-project.github.io/documentation/package-updates/)
- [Sparkle installer lifetime](https://github.com/sparkle-project/Sparkle/blob/2.x/Documentation/Installation.md)
- [tar entry path and extension semantics](https://docs.rs/tar/0.4.46/tar/struct.Entry.html)

## Follow-up implementation checkpoint (after b0e5115)

Review fixes: terminal journals now retire only after successful GUI restoration,
with a durable last-result record and replayable private-stage cleanup. Tests
exercise consecutive updates and interruption at every finalization boundary.
A fixed `/Applications/Rieul.app` destination abstraction allows its public parent
to be group-writable without weakening private Dir checks. Exchanged-out app
entries are untrusted until validated inside protected storage.

Native launchd, private app snapshots, protected runtime staging, GUI barrier,
readiness binding and transaction Effects adapters now compile. They have not
been exercised against real launchd mutations. The independent worker and initial
migration wiring remain unfinished; no production updater has been activated.

An optional host maintenance hook counts connections and in-flight RPC streams,
live PTYs, running background jobs and ACP runtimes. It pauses scheduler admission
before granting an idle drain, and only acknowledges exit while admission is
blocked. Busy work is deferred, never killed by a timeout. The current conservative
implementation also defers on idle connected clients. The newly requested manual
RPC/UI path is not yet implemented: it must explicitly warn/confirm disconnection
and must not silently authorize termination of commands, terminals or agents.
The UI belongs in the existing client daemon menu.

Full signing/notarization checks and candidate copying run before drain in the
native adapter; repeated in-process checks after drain use protected-file digests
and known identities. Runtime health verifies nonce, PID, schema, SHA-256 and
static-versus-running CodeDirectory hash. Stop-to-ready timing is recorded.
Port handoff or zero downtime is not implemented or promised.

Discovery currently uses the GitHub `/repos/disjukr/rieul.app/releases/latest`
endpoint, not a list search. Non-desktop latest releases therefore yield no update.
Only stable desktop-x.y.z passes; draft/prerelease are rejected. Asset URL metadata
is ignored in favor of a fixed versioned asset name. HTTP conditional caching,
rate-limit retry, polling cadence and manual UI are not connected yet.

VM precheck: this arm64 Mac reports hardware virtualization support, 64 GiB RAM,
and ample free disk. No Tart, UTM, Parallels or other VM manager was found in the
checked installed applications/PATH. No VM or new software was installed. A
snapshot-capable isolated macOS VM with synthetic pairing/data, no host mounts,
and no imported signing credentials is the intended destructive lifecycle test
location; prepare notarized fixture artifacts through the approved release path.

## Paused checkpoint for the Solid signal migration (2026-11-01)

Local development is paused at the parent's request. Do not delete this branch or
checkout. No OS installation, launchd mutation, policy activation, signing key,
release or remote publication was performed. This is reviewable implementation,
not a production-ready claim or closure of issue #45.

The independent fixed-path launchd worker, protected-runtime startup/reboot
coordination, readiness receipt, one-time migration state machine and concrete
native Effects adapter are now implemented. Migration deliberately requires the
legacy service to have been stopped by the approved initial installer; it does
not silently kill pre-updater workloads. The installer/release workflow has not
been connected. A failed candidate that has never reached readiness can answer
the drain protocol while waiting for configuration, allowing rollback without
claiming that a busy serving process is idle.

The updater protocol uses `SubscribeUpdateStatus` (73), `CheckForUpdates` (74),
and `InstallUpdateConfirmed` (75). IDs 64/65 are retired. Every snapshot has a
required random process epoch and monotonically increasing revision. Subscription
registration precedes its initial snapshot; a bounded watch retains the latest
state for slow consumers. The separate worker's atomic journal/result writes are
observed through filesystem notifications, not status polling.

`CheckForUpdates` joins concurrent discovery, completes at download start (not
archive completion), no-update `Idle`, or a discovery error. Accepted background
work survives RPC cancellation. Its per-operation completion retains the outcome
even if later work starts. `InstallUpdateConfirmed` itself is explicit consent to
client disconnection, not permission to terminate work. Both commands recheck
persisted credential revocation/expiry before dispatch and before returning.
Subscription also checks credentials throughout its lifetime. No caller
URL/path/version/command/validation override exists.

The controller checks on startup and every six hours (implementation default),
and stages while serving. Automatic dispatch requires zero connections and zero
active work. The drain rechecks under scheduler/work admission gates. Reconnection
cancels automatic drain; confirmed manual drain rejects new connections and
closes existing clients, but still refuses live PTYs, commands, transfers and ACP
runtimes. Even idle ACP runtimes defer ordinary installation. Explicit local
force installation is described below.

The Solid/Bunja client subscribes only while mounted, displays Checking immediately,
rejects late revisions and old epochs, and cancels its stream on replacement or
unmount. Installation confirmation is bound to daemon generation and target.
There is no compatibility polling: old daemons show an explicit upgrade-required
message. Deploy this client together with a daemon implementing procedures 73–75;
0.6.18 and earlier do not implement this contract. The autonomous updater and
workload drain guards remain unchanged.

Historical validation before the streaming protocol change follows (not its
validation record):
Validation at pause: host library 91 passed / 3 installed-ACP tests ignored;
root updater 29 passed / 1 read-only signature test ignored in sandbox (before
latest migration-start retry edit); web updater state 3 passed; web type checks
passed. The native lifecycle as a whole has not been tested against real launchd
or notarized old/new Rieul fixtures. Review and isolated VM tests remain necessary.

Discovery remains releases/latest, stable desktop tags only, draft/prerelease
rejected, fixed asset URL. No ETag/conditional caching or explicit rate-limit
backoff. Six-hour polling was an implementation choice, not a user requirement.

Remaining before activation: independent security review of this native adapter;
real signed/notarized VM integration tests for fresh migration, failed startup,
reboot, multi-user GUI restoration and public app-entry races; release packaging
integration; HTTP caching/backoff; UI browser tests and positive provider RPC
integration tests. Controller failure classification and stale worker-result
association need tightening (results currently lack transaction nonce). Existing
native paths intentionally stay fixed, so current fixture tests prove engine and
primitive contracts rather than a complete native adapter simulation. Review
whether GUI stop-before-drain can be narrowed to avoid unnecessary GUI restarts
on server-work deferral. No zero-downtime/port-handoff guarantee is made.

### Force install

The macOS tray's **Force Install Update…** action can promote a queued
ordinary installation or request immediate installation of a verified update.
It explicitly warns that terminals, commands, transfers, agents and Screen
sessions can be interrupted. The installed helper accepts the corresponding
`local-update force-install` operation through the same authenticated local
socket. This operation is local only; the WebTransport update RPCs retain
their existing behavior.

The force request is bound to the prepared candidate's journal nonce. It skips
the busy-work veto but still freezes new work and requires the serving
daemon's grant and exit acknowledgement. Signature, notarization and rollback
checks are unchanged. If the running daemon predates this command, the ordinary
update path must be used once to bootstrap support.
