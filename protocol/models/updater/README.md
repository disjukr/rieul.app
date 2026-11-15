# macOS updater admission and force handoff

A bounded, executable TLA+ safety model of the existing updater's admission,
GUI barrier, and two-phase service exit. This is not a refinement proof of Rust,
a security certification, or permission to activate the updater. It changes no
production behavior and needs no running Rieul service.

## Run

From the repository root:

```sh
sh protocol/models/check.sh updater
```

The common runner verifies the official TLA+ tools checksum, checks the corrected
model, and checks the exact expected failures below. See the parent model README
for prerequisites and tool download details. For an individual trace, from this
directory run the pinned tools with a fresh temporary state directory:

```sh
java -XX:+UseParallelGC -Xmx1g -cp "$TLA2TOOLS_JAR" tlc2.TLC \
  -workers 1 -metadir "$(mktemp -d)/states" -config skip-barrier Updater
```

Substitute any configuration name below. Do not interpret every nonzero exit as
success: mutations and reachability probes must exit 12 with the named invariant
violation, not a parse error or runtime failure.

## Scope and source correspondence

Source reviewed at `473103ae` (including the force-install changes originating in
`c2269eb` / `77897cb`). All references below are repository-relative.

| Model element                                  | Implementation contract                                                                                                                                                                                                                                                                                                   |
| ---------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `matchingIntent`, `Manual`, `Force`            | `daemon/macos/src/root_update/native.rs::quiesce_inner` filters confirmed install intent by the prepared journal nonce. A stale intent is ignored, not treated as force consent. `drain.rs::request_exit` also requires force to be manual.                                                                               |
| `intent`, shared `holders`, `AcquireExclusive` | `root_update/gate.rs::{announce_force,shared,wait_exclusive}`: a live privileged write lock announces intent; shared admission checks it after locking; force still waits for the exclusive barrier.                                                                                                                      |
| `YieldCompatible`, `LaunchCompatible`          | `daemon/macos/src/bin/launcher.rs::{exec_gui,can_yield_installed_gui,wait_for_forced_gui_handoff}`: the trusted installed launcher stops only its own bundled child. Other/legacy holders need not cooperate.                                                                                                             |
| `Freeze`, `NewWork`, `FinishWork`, `Grant`     | `daemon/host/src/maintenance.rs::{WorkGate,Workload}` and `server.rs::observe_update_work`: scheduler pause and admission freeze precede a fresh workload snapshot. A completed call may leave a PTY/job behind. Manual waives connections only; valid force waives active-work vetoes too, but never new-work admission. |
| `Commit`, `AcknowledgeExit`, `StopService`     | Host server maintenance loop and `root_update/drain.rs::request_exit`: live grant, worker commit, then serving daemon's exit acknowledgement. Native quiesce stops the known system job only after successful acknowledgement.                                                                                            |
| `AutomaticReconnect`                           | Host server accept loop cancels an automatic lease on a connection; manual/force leases reject new connections instead.                                                                                                                                                                                                   |
| `Revalidate`, `Swap`                           | `root_update/transaction.rs::resume_locked`: successful quiescence is followed by schema/artifact revalidation before exchanges. `native.rs` retains the exclusive guard. Force does not bypass these checks.                                                                                                             |
| `Defer`, `DeferLegacy`                         | Busy/error/expired or stale drain grants, barrier timeout, failed checks, and worker handoff failure cannot authorize a stop. A legacy holder can defer force installation.                                                                                                                                               |

`mode` has automatic, manual and force requests; `matchingIntent` represents the
confirmed/current-candidate test. All six combinations are explored. There is one
representative compatible GUI holder and one legacy/unresponsive holder, one
active call bit, one persistent-work bit, and one connection bit. The persistent
bit groups terminals, commands, agents and other retained busy work. After exit
it records work present before interruption, not a claim that its process survived.
At most two new-work admissions and twelve transitions are explored. Initial
work and all four GUI-holder subsets are included (192 initial states).

## Checked safety properties

- `ExclusiveNoGUI`: no running GUI holder overlaps exclusive replacement access.
- `AdmissionFrozen`: a granted, committed or exiting lease retains the admission
  freeze and scheduler pause; no work is newly admitted after its grant.
- `OrdinaryGrantIdle`: non-force leases never proceed with disallowed busy work.
  Manual connections are deliberately exempt, active work is not.
- `SwapAuthorized`: swap is reached only with exclusive/no-GUI access, frozen
  admission, paused scheduler and successful post-stop validation.
- `TypeOK`: finite state domains remain valid.

Grant, commit, acknowledgement and stop ordering is represented structurally by
separate phases, not an independent proof that every Rust exit path follows them.
Successful verification is an assumed primitive. The model cannot prove codesign,
notarization, digest/schema checks, OS lock semantics, authorization, or that an
untrusted program participates in the barrier.

## Mutations and non-vacuity probes

| Configuration          | Expected exit | Expected invariant                       |
| ---------------------- | ------------- | ---------------------------------------- |
| `fixed`                | 0             | All safety properties hold within bounds |
| `skip-barrier`         | 12            | `ExclusiveNoGUI`                         |
| `open-admission`       | 12            | `AdmissionFrozen`                        |
| `force-busy-witness`   | 12            | `NoForceBusySwap`                        |
| `legacy-defer-witness` | 12            | `NoLegacyDeferral`                       |

Checked on 2026-11-15 with one TLC worker:

| Configuration          | Generated / distinct states | Depth |
| ---------------------- | --------------------------- | ----- |
| `fixed`                | 70,452 / 28,114             | 13    |
| `skip-barrier`         | 2,767 / 1,578               | 3     |
| `open-admission`       | 14,216 / 5,933              | 6     |
| `force-busy-witness`   | 45,121 / 18,222             | 10    |
| `legacy-defer-witness` | 2,862 / 1,623               | 3     |

The corrected run completed with an empty queue. Counterexample runs stop at the
first specified violation; their counts can vary with exploration order. Depth
includes the initial state.

The mutations are deliberately unsafe alternatives, not claims of current bugs:

- `skip-barrier` permits a force worker to acquire replacement access despite a
  shared holder. Trace: compatible holder, valid force intent, then exclusive
  access while that holder remains. Failure occurs before drain or swap.
- `open-admission` lets new work bypass the freeze. Trace: validate, acquire
  exclusive, freeze, grant, then admit new work. `admissions` becomes 1 while
  `grantAdmissions` remains 0.

The witness configurations use corrected behavior and deliberately false
invariants. They ensure safety did not pass simply by making all updates
unreachable. `force-busy-witness` reaches `Swapped` with a valid force request and
persistent busy work recorded. `legacy-defer-witness` reaches `LegacyDeferred`
only after verified force handoff encounters a legacy shared holder; candidate
rejection and unrelated deferrals cannot satisfy that probe. Deferral has no
forced close/kill action for the legacy holder.

No fairness or eventual-update guarantee is asserted. Compatible holder yield is
optional, so unresponsive compatible launchers may also defer. Time is abstract:
lease expiry, timeout and failure may nondeterministically defer before exit.
Deadlock checking is disabled because terminal results and the transition bound
are intentional stopping points.

## Implementation checks, separate from TLC

These existing actual-source tests connect the modeled contracts to code. Run
from the repository root with the project's Rust/codegen prerequisites:

```sh
cargo test -p rieul-daemon-host --lib maintenance:: --locked --offline
cargo test -p rieul-daemon-host --lib \
  manual_drain_reobserves_terminal_created_after_prior_sample --locked --offline
cargo test -p rieul-macos-daemon --lib \
  force_handoff_preserves_exclusive_barrier_and_clears_when_worker_exits --locked --offline
```

The first includes `forced_update_closes_admission_even_with_active_work`,
`manual_confirmation_only_waives_connections_not_active_work`,
`active_work_blocks_drain_and_drain_blocks_racing_work`, and
`failed_start_requires_current_grant_before_commit`. The second tests a call
finishing after a prior sample and leaving a live terminal; the fresh snapshot
must reject ordinary manual drain and release admission on deferral. The third
uses temporary files and a child query process to test live force-intent locking,
read-only lock impersonation refusal, retained shared-holder exclusion and release.
These tests do not install or update an app. macOS-native lifecycle/lock behavior
still requires the supported Apple Silicon macOS runner.

TLC was run here on Linux with Java 21 and the official v1.7.4 jar, TLC 2.19
revision `5a47802`, SHA-256
`936a262061c914694dfd669a543be24573c45d5aa0ff20a8b96b23d01e050e88`.
Separately checked native implementation on Apple Silicon macOS, source
`473103ae`, with cached Rust 1.99.1 and locked offline dependencies:
`maintenance::` 6 passed; the drain re-observation regression 1 passed;
`local_update` 7 passed; `root_update` (including the handoff lock test) 83 passed,
2 ignored; `desktop_ipc` 9 passed, 1 ignored. These are isolated fixtures, not an
installed or signed GUI-open upgrade test.

## Deliberate omissions

Only one installation attempt through admission and swap is modeled. App and
service exchanges are collapsed into one operation. The model does not cover
partial swaps, recovery/rollback, readiness receipts, journal durability,
filesystem/public-path races, signing/packaging, policy activation, transaction
nonce generation/reuse, PID matching, receipt age arithmetic, real launchd,
multi-user restoration, actual timing, or permission/ownership validation.
`matchingIntent` abstracts only the native install-intent filter, not the separate
fresh drain-attempt nonce/PID protocol. Commit/acknowledgement assume a fresh,
unexpired grant for the current serving PID and successful response publication.
The model assumes that serving daemon exists; the native parked/already-stopped
shortcut is not represented. Scheduler pause failure is collapsed into deferral.
The compatible class means an installed bundled launcher eligible under
`can_yield_installed_gui`, not every current launcher; a custom-config or
nonbundled launcher belongs to the non-yielding class even if its code is recent.
WorkGate and scheduler coverage of every real work source is an assumption, not
established by these few state bits.

The live-intent guard's release on pre-exit deferral is represented, but a worker
crash after stop/swap is not a recovery proof. The post-stop `frozen` and scheduler
bits mean no admission is possible from the stopped daemon, not that a dead
process still owns Rust guards. Managed GUI stopping is omitted; the holders are
manual/cooperative or unknown barriers left after managed jobs stop. GUI relaunch
and finalization after swap are outside this model. Consult
`daemon/macos/UPDATES.md` and `daemon/macos/src/root_update/TESTING.md` for the
separate native integration gate. No installation, activation, migration, service
stop, real update or device/access change is part of this check.
