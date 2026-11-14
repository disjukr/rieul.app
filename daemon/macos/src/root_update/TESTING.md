# Updater verification checkpoint

The macOS arm64 job in `.github/workflows/check-pairing.yml` runs these commands after
installing the existing daemon codegen dependencies:

```sh
cargo test -p rieul-macos-daemon --lib root_update --locked
cargo test -p rieul-daemon-host --lib --locked
```

The supported macOS runner is Apple Silicon `macos-15`; Intel Macs are unsupported. Tests use temporary
files, fixture ownership based on the test process UID, simulated service effects,
and harmless native commands. They cover extraction, filesystem swaps, private
records, transaction/recovery faults, retry suppression, management RPC
permissions, and scheduler/work admission. No `sudo`, service installation,
launchd registration, migration command, policy enabling, or VM setup occurs.

The read-only real codesign test remains explicitly ignored in the default suite
because it needs an unrestricted macOS Security framework context. The three
host ACP integration tests need an installed authenticated adapter and also remain
ignored. Neither these skips nor passing fixture tests prove signed old/new app
installation or native system-service recovery.

## Production activation remains disabled

The existing installer/release workflows do not activate this updater. Ordinary
app-path daemon execution does not create or enable the protected updater policy.
Network preparation requires the root-private enabled policy, and the production
controller runs only from the fixed protected service path. Do not run the hidden
migration/worker commands to make CI pass. The first privileged installation and
activation still require explicit action-time authorization in the intended
environment. No new signing key or weaker identity policy is part of this CI step.

## Separate integration gate

Initially no ready isolated macOS VM was found. The user subsequently authorized
an isolated Tart guest. Official Tart 2.41.1 was downloaded and its Cirrus Labs
Developer ID signature and notarization verified; the official Tahoe base image
is downloading with a 60-minute / 120-GiB bound. No guest has booted yet, and no
host Rieul service or security settings were changed.
Before production activation, approved signed/notarized old/new fixtures and an
isolated guest or disposable dedicated Mac are still needed to verify:

- Root-owned fixed paths, real launchd worker/service lifecycle and migration.
- Candidate readiness failure, rollback, reboot at terminal/cleanup boundaries.
- Multiple GUI users, public app-entry substitution, real connection/job drain.
- Actual notarization assessment and measured stop-to-ready downtime.

Keep signing credentials in the existing approved signing environment; transfer
artifacts rather than credentials to the test guest. A real system-service test
must not target the user's installed Rieul service. The current workflow addition
is a nonprivileged regression gate, not that native integration gate.

## Solid native integration checkpoint

Main `6b8deea8b5343b0d4d0d7dfd4b5d65f105e1113c` is merged normally. The updater
Bunja uses native Solid accessors/setters and an owner-bound effect root. No
Jotai bridge is restored. Existing daemon menu placement is preserved. Tests
exercise stale connection responses, stale installation consent, synchronous
duplicate requests before Solid flush, disposal, visible deferral, explicit
manual confirmation/cancellation, and replacement-daemon dialog invalidation.

Validation after integration: updater 45 pass / 1 intentionally ignored; host
92 pass / 3 intentionally ignored; macOS all-target check; root Node suite 62
pass; TypeScript checks and production web build pass. Browser suite used the
installed Chrome with an isolated Playwright profile because bundled Chromium
was absent: 26 passed initially, one updater fixture locator was ambiguous
(the fixture output also has role=status); after scoping the locator both
updater browser tests passed. Thus all 27 distinct browser tests passed.

The RPC generator golden changed only for the appended update RPC schema
(64/65 and associated types); TypeScript generated artifacts match generation.
The signed-fixture workflow remains a local, non-dispatched review draft outside
`.github/workflows`. Actual signed lifecycle, rollback, reboot, multiuser and
downtime evidence remains pending. Production updater activation is unchanged.

## Architecture contract

The signed update manifest schema and asset name remain unchanged. Candidate
verification requires an Apple Silicon macOS host, audits Mach-O headers throughout
the staged app, and requires arm64 Mach-O daemon, launcher and GUI entry points.
Intel and universal/mixed-architecture candidates are rejected before replacement.
Signature, digest, version and database gates still apply. This does not delete
old release assets or modify an existing Intel installation. Pure header tests run
without executing a candidate or changing host services.

## Schema-1 device-number repair (separate package)

`updater-device-repair` is an opt-in build feature, **off** for normal daemon
and installer builds. Build `rieul-macos-system` with that feature, sign the
helper using the official Developer ID Application identity and hardened
runtime, then run `scripts/macos/package-updater-device-repair.sh` with that
helper, the official Developer ID Installer identity and a new output path.
The no-payload PKG must be notarized and stapled. Verify package signature,
Gatekeeper installer assessment, and stapling before running the signed VM
fixture (release pipeline or artifact publication is not automatic).

The separate explicit Installer operation neither stops nor restarts a daemon.
It accepts only an administrator-requested, pre-swap, matching failed attempt
with unchanged inodes, confirmed current same-volume aliases, and verified old
and staged signed bundles. A schema-1 journal has no historical volume UUID, so
a current same-volume check cannot prove historical identity. Do not use this
as automatic journal recovery or relax normal update validation.

The operation archives the validated candidate runtime stage (if any), then
atomically renames the active journal to a private nonce-scoped archive. The
journal remains intact; configuration, pairing state, DB, installed binaries,
launchd jobs and policy are untouched. The original `incoming` app and worker
result stay in their original locations until the standard updater next
prepares/dispatches a new attempt. Normal preparation discards the obsolete
incoming release and keeps independently validated newer release data. If
repair already completed but Installer reporting was interrupted, do not keep
rerunning the package: confirm the old service is healthy, then use **Check for
Updates**, check the target version, and **Install** through the regular signed
update path. If the already-installed daemon is parked, normal recovery of the
old service is a separate administrator step.

Before distributing, test on a disposable Apple Silicon VM with a real
official-signed, notarized protected installation:

1. Start the old healthy runtime with pairing and configuration state. Stage
   a newer official candidate and inject only divergent historical device
   numbers into a test v1 `Prepared` journal (alternate: reproduce real number
   churn over reboot). Bind the test hard failure to that attempt.
2. Run the notarized repair PKG through macOS Installer. Confirm both signed
   snapshot checks and APFS descriptor UUID queries pass, no protected binary,
   daemon PID, version, pairing/configuration or DB changes, and only verified
   pre-swap staging records are archived.
3. In another snapshot, interrupt after candidate-runtime archival but before
   journal retirement. The active record must remain resumable/fail-closed;
   opening the repair again must not replace the preserved archive.
4. Check and install the newest official release directly (not the discarded
   candidate). Confirm the standard service/DB readiness and pairing.
5. Repeat with live worker, unexpected journal phase, mismatched nonce/old
   runtime hash, replaced root-protected staged app, wrong inode/current
   volume, missing or invalid signed manifests, and preexisting swap evidence.
   Every case must leave the active journal and staging aliases untouched.
