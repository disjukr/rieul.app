# Terminal concurrency models

Executable, bounded TLA+ safety checks of selected terminal attachment and input
lifetimes. These models describe the implementation at `473103a`, not a new wire
protocol. They supplement implementation tests; passing TLC is not a proof that
Rust or TypeScript refines the models. No real terminal or daemon is required.

The only manually invoked pstack guidance used was `principle-fix-root-causes`
and `principle-prove-it-works` from the approved
`michael-denyer/pstack-claude` revision
`a12b04786023e762f12f5de7bb5fafb8c23f8c36`. No pstack installer, hook, or other
skill was run.

## Run

Use Java 21 and official TLA+ tools v1.7.4, which reports TLC 2.19, revision
`5a47802`. Download into temporary storage, not the repository:

```sh
tools=$(mktemp -d)
curl -fL https://github.com/tlaplus/tlaplus/releases/download/v1.7.4/tla2tools.jar \
  -o "$tools/tla2tools.jar"
sha256sum "$tools/tla2tools.jar" # macOS: shasum -a 256 "$tools/tla2tools.jar"
# Require: 936a262061c914694dfd669a543be24573c45d5aa0ff20a8b96b23d01e050e88
```

From this directory, run the positive models:

```sh
java -XX:+UseParallelGC -Xmx1g -cp "$tools/tla2tools.jar" tlc2.TLC \
  -workers 1 -seed 1 -fp 0 -metadir "$tools/terminal-fixed" -config fixed Terminal
java -XX:+UseParallelGC -Xmx1g -cp "$tools/tla2tools.jar" tlc2.TLC \
  -workers 1 -seed 1 -fp 0 -metadir "$tools/input-fixed" -config input-fixed InputCleanup
```

Use fresh `-metadir` paths for reruns. Run the negative controls with the same
options and `-config broad-cleanup Terminal`, `-config stealing-attach Terminal`,
`-config stale-input Terminal`, or `-config input-broad InputCleanup`. These are
intentional model mutations, **not claims of existing production faults**. Each
must exit 12 with the named invariant violation and a trace, not merely fail to
parse or exhaust memory.

| Configuration     | Exit | Generated / distinct | Depth | Outcome               |
| ----------------- | ---- | -------------------- | ----- | --------------------- |
| `fixed`           | 0    | 494,358 / 39,192     | 8     | No error; empty queue |
| `input-fixed`     | 0    | 97 / 72              | 7     | No error; empty queue |
| `broad-cleanup`   | 12   | 315 / 127            | 4     | `CleanupIsolation`    |
| `stealing-attach` | 12   | 193 / 57             | 3     | `FastAttachNoSteal`   |
| `stale-input`     | 12   | 110,002 / 12,737     | 7     | `InputAuthority`      |
| `input-broad`     | 12   | 20 / 20              | 5     | `FinishIsolation`     |

Counts use one worker, seed 1, fingerprint index 0, and the pinned jar. Depth
includes the initial state. Negative searches stop at the first violation and
retain unexplored states; positive searches finish their bounded graphs.

## `Terminal.tla`: host authority

There is one terminal session, two fresh, non-reused attachment IDs, two RPC
session identities, two viewport sizes, epochs 0..3, and at most seven
transitions. IDs are allocated in order. `owners` is immutable allocation-owner ghost
metadata retained after detach; `live` is the actual `attach_owners` map domain.
Stale input leases retain their original
attachment, RPC identity, and epoch; an ended stream may still attempt a write in
the abstraction, conservatively exercising rejection of late work.

- **Attach** atomically registers the new attachment and, when requested, grants
  control only if the process has not exited and there is no **live** primary.
  Fallible resize precedes authority/epoch/viewport mutation. A rejected resize
  leaves the view attachment registered. Omitted and false `requestControl` are
  both represented as false because neither attempts control.
- **Cleanup** models the output attachment guard finishing, failing, being
  canceled, or being aborted. It removes only its exact attachment ID and can
  arrive after another attachment has been installed, including on the same RPC
  session. Repeating cleanup is harmless. It does **not** clear primary or bump
  the epoch. A primary ID can legitimately remain stale after detach; vacancy
  is determined by membership in the live attachment set.
- **Take** is an explicit, owner-validated operation and may preempt another live
  primary. Re-taking the same primary resizes without bumping the epoch. A failed
  resize leaves authority, epoch, and viewport unchanged.
- **BeginInput** captures the current epoch only for the live, RPC-owned primary.
  **WriteInput** independently checks live membership, RPC ownership, primary ID,
  and captured epoch for every attempted chunk. A primary handoff A -> B -> A
  must not revive A's old stream.
- **Exit** prevents the attach fast path from acquiring control. It does not
  revoke all input in this model: `begin_input`, `write_input`, and explicit
  `take_control` do not themselves test the exit flag in the current source.
  Backend resize/write success remains abstract nondeterminism.

`last` is an observation record of the preceding operation and its before-state.
The contracts inspect that record plus resulting state. Mutation constants alter
only transitions, never the contracts. `AttachRegistration` requires registration
even on a failed control attempt; `FastAttachEligibility` checks both granting
and withholding control. `CleanupIsolation`, `FailureAtomicity`, `AuthorityEpoch`,
`TakeOwner`, and `InputAuthority` independently check their named contracts. No
invariant incorrectly requires stale primary IDs to remain live.

### Witnessed negative traces

- **Broad cleanup:** attach 1 and 2 on `rpc1`; cleanup 1 removes both. Expected
  live set is `{2}`, observed `{}`.
- **Stealing fast attach:** attach 1 requests and obtains control at epoch 1;
  attach 2 requests control while 1 is live and incorrectly becomes primary at
  epoch 2. Only an explicit Take is allowed to do that.
- **Missing epoch fence:** attach 1 as observer; attach 2 grants control at epoch
  1; begin input for 2 captures token 1; explicit Take 1 then Take 2 advances to
  epoch 3; old input for 2 is incorrectly accepted with token 1.

## `InputCleanup.tla`: browser queue ownership

A separate small model avoids conflating output-attachment cleanup with input
stream cleanup. `queueTerminalInput` creates a stream object, `stopTerminalInput`
closes/discards its queue and clears the current reference, and
`sendTerminalInput` can finish later. Its `finally` must close its own object,
but may clear the current reference only when that reference still names it.

Two non-reused object identities and six transitions explore both completion
orders, stop/replacement, enqueuing, and queue discard. Pending promises are not
assumed to complete fairly. The negative trace is start 1, stop 1, start 2, finish
1: unconditional reference clearing loses stream 2. `FinishIsolation` detects
that result independently of the mutation. `LiveQueue` and `NoClosedInput` also
check current-object and discarded-queue consistency.

## Source and implementation tests

| Model operation / contract                                      | Production mapping                                                                                                                                                                                                    | Independent fixture                                                                                                                                                                                                       |
| --------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Atomic attach, vacancy-only grant, rejected resize retains view | [`terminal.rs`](../../../daemon/host/src/terminal.rs), `TerminalManager::attach`, `acquire_control`                                                                                                                   | [`control_tests.rs`](../../../daemon/host/src/terminal/control_tests.rs), observer, vacancy, live-primary, exited, rejected-resize, and successful-resize tests                                                           |
| Exact output cleanup, idempotence, delayed task abort           | [`server.rs`](../../../daemon/host/src/server.rs), `stream_attach_terminal_session`, `TerminalAttachmentCleanup::drop`; `TerminalManager::detach`                                                                     | [`terminal_lifecycle_tests.rs`](../../../daemon/host/src/server/terminal_lifecycle_tests.rs), exact cleanup, aborted future, and new same-RPC replacement regression                                                      |
| Explicit Take, stable same-primary epoch, failure atomicity     | `TerminalManager::take_control`, `acquire_control`                                                                                                                                                                    | `same_primary_resize_keeps_existing_input_stream_authorized`, `failed_explicit_take_preserves_prior_authority_and_input_stream`                                                                                           |
| Captured input token and per-chunk validation                   | `handle_write_terminal_input_stream`, `TerminalManager::begin_input`, `write_input`, `validate_attach_owner`                                                                                                          | `terminal.rs::control_reacquisition_does_not_reauthorize_old_input_stream`                                                                                                                                                |
| Input object cleanup and discard                                | [`terminal/index.tsx`](../../../web/src/view/workbench/tool/terminal/index.tsx), `stopTerminalInput`, `sendTerminalInput` finally; [`input-stream.ts`](../../../web/src/view/workbench/tool/terminal/input-stream.ts) | [`terminal-input-stream.test.ts`](../../../web/tests/terminal-input-stream.test.ts) exercises the actual queue's wake/order/limits/discard behavior; the small model alone does not execute the component's finally block |
| Fast grant interpretation, legacy/refused outcomes              | [`attach-control.ts`](../../../web/src/view/workbench/tool/terminal/attach-control.ts)                                                                                                                                | [`terminal-attach-control.test.ts`](../../../web/tests/terminal-attach-control.test.ts) and existing [`terminal.spec.ts`](../../../web/tests/ui/terminal.spec.ts) production-component fixtures                           |

Run the implementation fixtures separately from TLC:

```sh
cargo test -p rieul-daemon-host terminal::
cargo test -p rieul-daemon-host server::terminal_lifecycle_tests
node --conditions=browser --experimental-test-module-mocks --import tsx --test \
  web/tests/terminal*.test.ts
```

The Rust fixtures use injected, fake terminal backends, not the local terminal
backend or an installed daemon. The cross-language TypeScript tests consume
checked-in Rust wire goldens; running those TypeScript tests does not rerun Rust.
The ignored transport/hardware benchmark is not part of these ordinary unit
commands. The Node command passed all 19 selected tests during development. On the native
macOS toolchain, the mapped Rust terminal fixtures, including all three added
regressions, passed: 24 passed, one pre-existing ignored transport benchmark.
This is separate implementation evidence, not a result produced by TLC.

## Limits

This is safety checking within explicit finite bounds, not unbounded verification,
liveness, fairness, refinement, or a proof of the entire terminal protocol. Epoch
and attachment counters do not wrap in the model; the Rust epoch uses
`wrapping_add`, whose eventual rollover is outside these bounds. There is no
claim that detach immediately revokes a stale primary field, or that a stalled
or disconnected output stream is eventually cleaned up.

The host mutex is abstracted as atomic operations. The models omit wire bytes,
authentication establishment, arbitrary invalid viewport values, terminal close,
multiple sessions, PTY/parser internals, output replay/snapshots/history gaps,
network scheduling, timeout/stop detection, table delivery, and browser
attachment generation/stale unary-reply/deferred-resize coordination. Reconnect
is represented only as fresh attachment allocation with potentially delayed old
cleanup. The separate input model does not prove browser-to-host control state
coordination or prevent arbitrary third-party writes. Tests and code review are
still needed to establish the mapping and real transport behavior.
