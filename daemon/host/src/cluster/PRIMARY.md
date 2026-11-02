# Primary-managed membership draft (not registered or activated)

Base: published 3351b600. The unpublished 98f52280 union experiment remains on
cluster-membership-model and local main; cluster-primary-management branches
from 3351b600 and excludes it. No production keys or credentials are created. No new admin role is introduced:
paired clients retain full authority, members trust one another. A restricted
pre-admission sync connection is a distinct scope, not normal member authority.
Cluster ID alone never authorizes disclosure of logs, node keys or addresses.
Forwarded management intent must bind the original authenticated subject, cluster
and canonical request digest; replay receipt lookup runs AFTER caller authorization.

## Trust and identity

Each node owns a distinct Ed25519 key; no shared root secret is copied. Cluster ID
is SHA-256 of a domain-separated genesis containing a random cluster nonce and
first node/admission public identity. Genesis is pinned through authenticated join
consent, never accepted solely from discovery. Node and client keys remain distinct.
Only the primary orders membership; ordinary node services remain peers.

Pairing is locally approved at any member. A proposed cluster client grant binds
client key, cluster ID, grant ID, issuer admission and expiry. Its exact issuance,
revocation distribution and issuer-removal policy are NOT settled. Existing
shared-secret pairing credentials will not silently become portable credentials.
The join confirmation must explicitly show that this node becomes accessible to
cluster clients and which existing paired clients gain cluster access. A boolean
acknowledgement in the draft consent binds that intent, not a finished grant policy.
No authentication activation may occur before that policy and code are reviewed.

## Ordering and idempotency

One durable SQLite serialization path covers every management mutation and seal.
Each operation ID is bound to canonical request digest and exact signed response.
A matching retry returns the stored result; changed content conflicts. Commit
atomically stores log entry, derived state, sequence and operation receipt before
reply. Request cancellation after acceptance does not undo committed work.
Sequences increase globally across epochs (positive exact i53, checked overflow).
Epoch only changes on primary transfer; it is not immediate revocation freshness.

Log transcript is an explicitly encoded fixed CBOR array:
[domain="rieul.cluster.management.v1", clusterId, epoch, sequence, previousHash,
 operationId, requestDigest, mutationTag, mutationFields].
Ed25519 signs these bytes; SHA-256 hashes the complete signed entry. Keys/IDs/hash
are 32 bytes; signatures 64 bytes; unknown versions/tags, noncanonical encoding,
sequence gaps, wrong cluster/signature/previousHash fail closed. Mutation fields
will be typed and bounded before actual implementation, not arbitrary BDL reencode.
Join consent and transfer acceptance use separate transcript domains.

## State transitions

Local slot: Vacant -> Reserved(cluster, admission, operation) -> Member.
Reserve is durable before target signs consent; exact retries are idempotent.
Primary validates consent/reservation identity then atomically appends admission.
Target activates only after verifying the contiguous signed log through admission.
Late Finish cannot activate a retired reservation. Before admission, cancellation
retires the reservation; if primary raced and committed admission, reconciliation
requires a primary removal, never resurrection of local membership. Cancel is
serialized by primary as removal if already admitted, or as an admission-ID
tombstone otherwise; either prevents a delayed Admit. Local retirement happens
independently and durably first; until remote confirmation, show RemovalPending,
not "removed from cluster". Normal Leave targets only the local admission and
waits for primary's signed self-removal before detach. Offline leave remains
Leaving; primary cannot leave itself until a normal transfer completes.

Replicas forward the original authenticated management intent to the current
primary; transport trust alone cannot convert an arbitrary caller into an admin.
If primary is offline, return PrimaryUnavailable (no fake success or hidden queue).
Client may keep the same operation ID for retry. Cached data-plane sessions and
local discovery of cached members continue independently. New authorization at
an offline replica is only as fresh as its validated cache; removal takes effect
there once synchronized. Session termination policy on removal needs explicit
integration; no instantaneous partition-wide revocation claim.

## Normal primary transfer

1. Target is an active member. It catches up to the advertised head and durably
   prepares acceptance for transfer ID, source epoch/key, exact prefix sequence/hash
   and target admission/key.
   Acceptance grants no primary rights. A separate mutually authenticated internal
   PreparePrimaryTransfer / AcceptPrimaryTransfer exchange is declared but not
   registered. A changed head invalidates acceptance; reprepare with a fresh ID.
2. Source serializes transfer with membership writes. Complete earlier mutations;
   atomically append a terminal transfer entry and persist Sealed. The certificate
   includes cluster, transfer ID, old/new epoch, exact pre-transfer prefix sequence/hash,
   target key/admission and signed target acceptance. Source cannot remove itself
   as primary before transfer, and target must still be active at sealing.
3. Only after durable seal does source release the identical certificate. Same
   transfer retries replay it; altered target/epoch/hash under that ID conflicts.
   Timeout, lost response, process restart or target failure NEVER unseal source.
4. Target verifies complete log continuity through the final entry and transfer
   certificate, persists both and its Active(newEpoch,nextSequence) state in one
   transaction before emitting any new signed entry. Its first entry chains to
   the transfer entry. For prefix n/H, transfer entry is n+1/T and the first new
   primary entry is n+2 with previous hash T; no self-referential hash is signed.
   Repeated certificates are idempotent.
5. Replicas change accepted signer only after validating the transfer. Source is
   a replica afterward; it may forward new management requests but not append.

Loss before seal leaves source authoritative. Loss after seal can stop membership
changes until the target obtains its certificate; safe replay is supported, forced
rollback is not. Loss of target or old DB rollback must not trigger promotion.
Restoring an old primary database can recreate a writer unless externally fenced;
forced recovery is explicitly unsupported. Rebuild with a new cluster identity is
an initial option, not transparent recovery. Existing data-plane work is separate.

## Snapshot and synchronization

Initial version keeps the complete signed management history. Bounded pages include
sequence and previous hash. Snapshot is only a cache acceleration: verify genesis,
complete contiguous history, every handoff and replay-derived state/hash before
adopting it. Persist high-water head and reject rollback/conflicting same position.
Do not trust a snapshot signature alone to erase prior removals. No unsafe log
compaction; if configured history limit is hit, fail explicitly until reviewed
checkpoint/compaction support exists. Unknown/pending or invalid input cannot
invalidate established authentication. Bound record bytes, batch count, pending
ancestry and signature/replay computation before accepting network-facing input.

## BDL / tests

cluster.bdl is a review-only declaration with provisional proc IDs76–88. No
supportedProcIds registration. Signed canonical bodies are distinct from arbitrary
BDL serialization. Public client grant/auth declarations still await policy review. Preparing/Sealed/
AwaitingActivation and Leaving/RemovalPending are explicit proposed UI states;
network orchestration and projection of these states are not implemented.

Planned fixture tests: crash/transaction interruption at every seal/target commit
boundary; concurrent mutation vs seal; duplicate operation/hash conflicts; lost
certificate and response replay; target/hash/epoch mismatch; old primary restart;
rollback/gap/fork snapshot rejection; reserve/finish/cancel races. Real crash/power
loss claims require separate process/storage tests beyond transaction-drop models.

## Implemented internal fixture checkpoint

`daemon/host/src/cluster/primary.rs` is cfg(test)-only. It uses ring Ed25519 and
SQLite immediate transactions for an ordered signed log, digest-bound durable
receipts (stored log entries), prefix validation, transfer acceptance tied to an
exact head, durable source seal and atomic target history installation. Removal
of an unknown admission is a cancellation tombstone; removed IDs cannot rejoin.
Receipts transfer as signed log entries and are checked before new epoch/seal
conditions, but after the fixture signing-key check. Actual client authorization
must precede this boundary in production; that integration is absent.

Its typed Admit stands for consent already verified by a future integration. It
does not yet join this journal to the existing local reservation model or enforce
self-only Leave at an authenticated RPC layer. Snapshot verification currently
means exact local prefix plus complete signed replay, not accepting a separate
snapshot object. Inputs are bounded synthetic fixtures; production byte/count/
verification-work limits remain required. Interruption tests drop transactions
and reopen databases, not SIGKILL or power-loss tests. Old-backup fencing remains
unsupported. Temporary source/target unavailability after seal is intentional.
