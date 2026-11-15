# Primary handoff concurrency model

A small bounded TLA+ design check for an authenticated primary A handing
management authority to an already enrolled member B. It does not operate a
cluster or prove the implementation correct. The initial empty histories omit
the common admission/genesis prefix in which A is primary and B is a member.

## Run

From the repository root, run the common model checker (Java 21 required):

```sh
sh ./protocol/models/check.sh cluster
# Or reuse an already downloaded jar:
TLA2TOOLS_JAR=/path/to/tla2tools.jar sh ./protocol/models/check.sh cluster
```

The runner downloads the official TLA+ v1.7.4 tools jar when needed and checks
SHA-256 before executing it:
`936a262061c914694dfd669a543be24573c45d5aa0ff20a8b96b23d01e050e88`.
The jar reports TLC 2.19, revision `5a47802`. No jar or generated TLC state is
stored in the repository. The common runner checks all three configurations,
exit codes, and the expected negative invariant, not merely any failure.
To inspect just one run:

```sh
cd protocol/models/cluster
states=$(mktemp -d)
java -XX:+UseParallelGC -Xmx1g -cp /path/to/tla2tools.jar tlc2.TLC \
  -workers 1 -seed 1 -metadir "$states" -config fixed Handoff
```

Checked with Java 21, that exact jar, one worker and seed 1:

| Configuration   | Exit | Generated / distinct | Depth | Result                                   |
| --------------- | ---- | -------------------- | ----- | ---------------------------------------- |
| `fixed`         | 0    | 2,106 / 434          | 12    | All five safety invariants pass          |
| `recovery`      | 0    | 2,106 / 434          | 12    | Safety and conditional recovery pass     |
| `early-publish` | 12   | See trace below      | 7     | `NoConcurrentLegitimateWriters` violated |

Positive searches exhaust the state graph. Negative searches stop at the first
violation; their counts can depend on exploration order.

## What is checked

`Handoff.tla` permits two distinct ordinary management operations, one prepared
handoff and two members. It is finite without a transition-depth cutoff.
Preparation captures an exact reconciled prefix. A racing source write makes
that acceptance stale, so `BeginSeal` cannot accept it. Source writes and seal
share a serialization gate. Seal and target activation have separate begin,
commit and rollback transitions. The seal record and source journal append
commit atomically, and an uncommitted signed certificate is not exposed.

Lost responses, duplicate receipt/activation retries and crash/reopen can occur
repeatedly. A lost seal response leaves no browser-held certificate, so
activation requires a fresh read of the durable journal. Reopen preserves durable journals, preparation receipts and seal,
while discarding open transactions and browser-held evidence. Recovery reads the
committed journal and resumes the same handoff; it never makes the source
writable by timeout. `DaylightPasses` represents an arbitrary wall-clock/daylight
boundary after which the durable preparation is still an obligation. It is not
a clock, duration or daylight-saving-time simulation.

The invariants check types/bounds, no simultaneously eligible A/B writers,
target activation backed by the source's durable seal, the exact prepared prefix
at activation, and unique operation IDs within each journal. A successful retry
may return an existing receipt; **it must not append the operation twice**.
`RetryReceipt` abstracts that idempotent outcome and does not model payload
conflicts or prove the receipt lookup implementation.

`fixed` assumes no fairness or eventual delivery. `recovery` additionally checks
`sealed ~> Transferred(target)` under **strong fairness** of journal recovery,
begin activation and commit activation. This explicitly assumes repeated reads
and retries eventually get chances to finish despite loss/rollback. It does not
claim progress under permanent outages, endless starvation, or without a retrying
caller. A stale, never-sealed attempt need not complete.

## Focused negative trace

`early-publish` changes only `PublishBeforeCommit`: it allows the source to expose
a signed certificate while its transaction can still roll back. This is a
hypothetical regression of the response/commit boundary, not a reported bug:

1. B prepares the current empty prefix.
2. A begins seal, but has not committed it.
3. A publishes the staged certificate `<<"handoff">>`.
4. A rolls back: its journal is still empty and `sealed = FALSE`.
5. B begins and commits activation from that certificate.
6. A's replay still names A; B's replay names B. Both serialization gates are
   idle, so `NoConcurrentLegitimateWriters` fails.

This is seven TLC states including the initial state. The negative configuration
intentionally checks the writer invariant rather than stopping earlier at the
missing durable seal. Correct publication prevents this path.

## Implementation mapping and real tests

- [`daemon/host/src/cluster/primary.rs`](../../../daemon/host/src/cluster/primary.rs):
  `Store::commit` exposes signed responses only after commit; `append` uses
  `TransactionBehavior::Immediate`, checks exact existing request receipts before
  rejecting sealed/old-primary writes, and appends the transfer with the seal in
  the same transaction. `State::apply` checks epoch, sequence, previous hash,
  operation uniqueness and the transfer's exact prefix. `install` checks the
  local prefix, verifies history, requires the stored target preparation and
  activates within the install transaction. These guards are **abstracted as
  predicates/atomic transitions**, not derived or verified from Rust by TLC.
- [`daemon/host/src/cluster/primary/runtime.rs`](../../../daemon/host/src/cluster/primary/runtime.rs):
  `PreparePrimaryTransfer` can return the original durable preparation;
  `import` validates explicit activation for the selected operation and commits
  installation before returning state. Authentication/authorization, target
  membership and signatures are trusted preconditions here, not cryptographic
  or access-control claims.
- [`web/src/cluster/manage.ts`](../../../web/src/cluster/manage.ts):
  `transferPrimary` reconciles history before preparation, verifies acceptance,
  seals before activation, and recovers the operation and already selected target
  from verified history after an interrupted response. `RecoverFromJournal` and
  `RetryActivation` collapse these reads and browser retries.
- [`web/tests/cluster-management-retry.test.ts`](../../../web/tests/cluster-management-retry.test.ts)
  exercises the actual browser orchestration, including lost activation response
  and old-epoch receipt recovery.
- Rust tests in `primary.rs` cover
  `writes_and_seal_share_one_serialization_path_and_exact_prefix`,
  `uncommitted_seal_and_target_activation_roll_back`,
  `durable_receipts_survive_seal_restart_and_transfer_to_new_primary`, and
  `target_hash_epoch_and_signature_mismatches_do_not_seal_or_install`.

From the repository root:

```sh
node --conditions=browser --experimental-test-module-mocks --import tsx --test \
  web/tests/cluster-management-retry.test.ts web/tests/cluster-trust.test.ts
cargo test -p rieul-daemon-host --lib cluster::primary --locked --offline
```

The two browser files passed all 6 tests with Node 24.22.1 during this addition.
The Rust `cluster::primary` tests passed all 26 tests (0 ignored) independently
on macOS with cached Rust 1.99.1 against source `473103a`, using isolated source
and temporary database fixtures. No live cluster was contacted. The model
supplements, not replaces, those implementation tests.

## Limits

Sequence equality stands in for collision-free authenticated history identity
(sequence, epoch, hash, operation and target binding). There are no bytes,
signatures, keys, untrusted identities, transport parsing, revocation races,
membership changes, operation payload conflicts, receipt capacity limits,
compaction, database corruption or rollback of already committed durable state.
Only one preparation and handoff are modeled; there is no return transfer,
third member or source catch-up after B writes. Atomic SQLite commit/durability,
serialization, prefix verification and idempotent receipt behavior are explicit
abstractions that require the implementation tests above. In particular,
`NoDuplicateAppend` is largely enforced by the fresh-operation guards and replay
abstraction, not an independent proof of database uniqueness. The primary is
derived from each node's own log, not a single globally chosen writer variable;
the negative run demonstrates that the writer invariant is not true merely by
construction. Passing this finite model is not an unbounded protocol proof.
