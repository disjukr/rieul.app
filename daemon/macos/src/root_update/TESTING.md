# Updater verification checkpoint

The macOS matrix in `.github/workflows/check-pairing.yml` runs these commands after
installing the existing daemon codegen dependencies:

```sh
cargo test -p rieul-macos-daemon --lib root_update --locked
cargo test -p rieul-daemon-host --lib --locked
```

The existing matrix covers `macos-15` and `macos-15-intel`. Tests use temporary
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

No ready isolated macOS VM was found in the checked local apps, PATH, and common
VM directories. No VM manager, OS image, or security access was provisioned.
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
