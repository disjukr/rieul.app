# Opt-in management RPC review checkpoint

This local checkpoint extends e431f1a1. It is not approved for main or deployment.
The unpublished union experiment 98f52280 is excluded. No real host, pairing,
credentials, service or OS permissions were changed by this work.

## Activation and authentication

There is no experimental build flag hiding these RPCs: supported storage
platforms advertise them in supportedProcIds. Windows is explicitly excluded
until private DACL creation and validation exist. Enrollment is opt-in: authenticated CreateCluster or
PrepareClusterJoin must carry confirmed=true. Startup and GetClusterState do
not create a node key or database. The background worker starts with the server,
but only works on an existing enrolled database. Existing pairing and ordinary
Screen/files authentication remain unchanged. A recorded cluster client grant
does NOT yet authorize those ordinary RPCs.

| IDs / procedures | Authority |
| --- | --- |
| 76 GetClusterState; 77 CreateCluster; 78 PrepareClusterJoin; 80 FinishClusterJoin; 81 CancelClusterJoin | Existing unexpired local paired client. Create/join additionally require explicit confirmation. Finish requires pinned genesis, local reservation and verified history. |
| 79 AdmitClusterMember; 82 RemoveClusterMember; 83 ReadClusterHistory; 84 PreparePrimaryTransfer; 85 SealPrimaryTransfer; 86 ActivateClusterPrimary; 87 ApplyClusterHistory | Local paired client, or active node proof through the peer envelope. Runtime enforces primary/head/consent/transfer requirements. |
| 88 BeginClusterClientAdoption; 89 CompleteClusterClientAdoption; 90 GetClusterClientAdoption | Local paired client; outbox ownership binds its client ID. Complete requires client key possession proof. |
| 91 AdoptClusterClient; 92 RevokeClusterClientGrant | Local paired client or active node proof; primary log orders adoption/revocation. Adoption verifies issuer membership and both proofs. |
| 93 GetClusterPeerChallenge | No paired session required. Bounded short-lived challenge and server signature; requires an enrolled server. No key/address/history returned. |
| 94 ExecuteClusterPeerRequest | No paired session required, but consumes a connection-bound nonce and verifies current cached sender admission/key and signed request before invoking the explicit inner whitelist. Not a general authenticated session. |

Local credentials are reloaded and checked before runtime execution/receipt
lookup; their guard is held through the transaction. Peer proofs bind cluster,
target key, sender admission/key, nonce, connection, procedure, payload hash and
original principal. The fully trusted member attests that original principal;
it is not an independently verified end-client signature. Peer writes recheck
membership in the transaction. Offline replicas cannot promise fresh revocation.

Admit, Remove, Seal, Adopt and Revoke may forward to the cached primary using
that signed envelope. Other operations remain local. Public requests are bounded
to 512 KiB / depth 16 / 24,000 CBOR items before generic decoding. Log history is
bounded to 512 entries and 240 KiB of stored entry bodies plus overhead. No log
compaction or forced authority recovery is implemented.

## Preserved endpoint validation / denied edit

An optional edit would have removed initialize's `old.endpoint != endpoint`
conflict check, to allow retrying an existing operation after the daemon's
configured endpoint changed. Automatic approval review rejected this as an
unauthorized weakening of endpoint validation. That command did not execute.
The exact equality check remains, alongside HTTPS/origin/path validation and
signed endpoint binding in genesis/join consent. No alternate path was added
to bypass it. Endpoint migration is unsupported; configuration drift produces
Conflict rather than silently accepting a different endpoint.

## Evidence and remaining boundaries

The latest pre-checkpoint cargo check passed. Cluster tests passed 24/24,
including three actual localhost WebTransport scenarios: opt-in join/handoff
and revoked credential denial; cancelled admission/removal; node nonce replay
denial and automatic adoption retry after a TLS trust failure. Tests use temp
SQLite files, synthetic keys and fixture TLS roots; no user screen or input.
Transaction rollback/reopen tests are not power-loss or forced-kill durability
evidence. Full host regression passed 147 tests (3 ignored); TypeScript codegen,
`pnpm check`, `pnpm test` (112 tests) and `pnpm build` passed. The Rust
codegen baseline and exhaustive RPC category count were updated for 19 new
procedures. `pnpm test:ui` could not launch any browser: the configured
Playwright chromium_headless_shell-1194 executable is absent. No UI pass is
claimed. Logs are in repository-local tmp/cluster-review-*.log (not committed).

The browser has not been integrated or tested for cluster operations. There is
no browser key persistence, automatic adoption initiation, cluster-grant session
authentication, automatic member connection or cluster UI. The outbox worker
and adoption RPCs are early backend work included for review, not a completed
pairing user flow. Real production CA routing has not been exercised by the
fixture tests. Foreground forwarding has compile coverage but no dedicated E2E.

Still required: restricted pre-admission synchronization (current bootstrap
requires existing local pairings); normal Leave orchestration; primary
rediscovery after the old primary becomes unreachable; more negative peer and
adoption ordering tests; Windows key-file ACL validation; cancellation/drain
lifetime review; local credential removal versus pending/adopted grants.
Admission/history validation must not be replaced by old success receipts.
Existing TLS verification, endpoint equality and local file protections remain.

## Follow-up: cached-peer primary rediscovery

The replication worker now probes the cached primary and at most three distinct
cached peers per tick, rotating the fallback window. Each exchange retains its
8-second timeout; a tick therefore has at most four such network exchanges for
discovery. Only a verified continuous signed history changes the primary route;
there is no election, new authority, endpoint rewrite or external discovery hint.
A stale replica response does not prematurely stop fallback discovery.

An actual three-node localhost test transfers A to B, leaves C on A's old head,
stops A's fixture server, and verifies C learns the signed transfer from B and
can repeat synchronization without changing the head. A deterministic unit test
checks probe budgets, uniqueness and eventual candidate coverage. This does not
solve permanent authority loss, old-backup rollback, restricted join sync or
normal Leave. Foreground forwarding still uses its cached route; background
replication must refresh it before a subsequent forwarded request can succeed.

## Auth review fixes following 8313eddf

- CancelClusterJoin now rejects Member phase. It rechecks local identity, role,
  current phase and prepared obligations in its immediate transaction. A durable
  target acceptance cannot be cancelled before seal or concurrently with final
  activation. Normal member departure remains a separate, unfinished Leave flow.
- External history import and PreparePrimaryTransfer now recheck peer membership
  and expiry inside their write transaction. Internal worker import is an explicit
  separate call with no external principal; it still verifies genesis, signatures,
  prefix continuity and target preparation.
- Adoption queue capacity (128) excludes completed owner receipts; receipts have
  a separate bound (512, matching maximum journal entries) and expire with their
  grants. Eligible pending items are selected before the eight-item work limit.
  Expired queue entries are removed. No unbounded archive was introduced.
- The worker refreshes local credentials and holds the shared credential lock
  through adoption dispatch. Revoked/expired owners cannot initiate new retries.
  Unresolved requests receive durable cancellation markers; a deterministic
  primary Revoke operation resolves uncertain in-flight delivery. Both adoption
  then revoke and revoke then adoption leave no usable grant. An already observed
  accepted cluster grant has its separate explicit cluster revocation policy.
  During partition or uncertain delivery this is eventual cancellation, not an
  instantaneous cross-node revocation guarantee; no new signing/dispatch occurs
  for a cancellation-marked local request.
- RPC 95 GetClusterRemovalProof is peer-only and binds the exact historical
  admission AND key. Removed peers remain forbidden from ordinary history and
  all management mutations. This RPC returns only the genesis-verified signed
  prefix ending at their own Remove entry, never subsequent entries or another
  node's proof. The existing nonce/request/target signature binding applies.
  The worker uses it only after a peer RPC rejection and becomes Removed after
  verifying/importing the proof. Discovery may make up to one additional bounded
  proof exchange per rejected peer (at most eight exchanges total, each 8 s);
  network failure alone does not trigger the extra exchange.
- Windows enrollment is fail-closed before database/key creation. Cluster RPCs
  are absent from discovery and the worker returns without starting. Private DACL
  implementation and Windows runtime validation remain future work. Mac fixture
  tests are explicitly platform-gated; a Windows-specific no-key-creation test
  and a cross-platform RPC discovery gate test were added.
- Transfer preparations are bounded to 16 per current prefix and 512 retained
  receipts per local incarnation. Current obligations never expire by wall
  clock; signed log advancement makes an old prefix unsealable. Old receipts
  remain for idempotency until explicit new local incarnation initialization.
  Exhaustion returns Limit; there is no automatic destructive eviction.

Regression evidence includes concurrent activation/cancel; stale authenticated
peer after removal rejected by prepare/import; expired/full queue reclamation;
eight completed entries before pending work; two cancellation/adoption log
orders; exact own-removal prefix excluding later entries; acceptance capacity
and idempotent retry; platform-dependent discovery. These are isolated fixtures,
not real host enrollment or a completed browser cluster session. Windows-only
execution and private DACL correctness are not claimed.

Validation after the auth fixes: host 156 passed / 3 ignored; web/codegen unit
112 passed; cargo check, TypeScript check, generated codecs and web build passed.
The added Windows-specific test has not run on Windows in this local checkpoint;
no Windows private-key-storage support is advertised. The existing Playwright
executable absence and browser cluster-flow gap remain. No main push, CI run,
release, host enrollment or actual pairing mutation was performed.

## Adoption P2 follow-up (separate from Leave)

Acceptance import now re-reads persisted local credentials under the same mutex
as local credential removal. Under that lock it marks unresolved revoked owners
cancelled before importing the downloaded history. The lock covers this local
commit boundary, not history download. Ordinary paired and peer history RPCs
likewise reconcile owner revocation while retaining that credential guard.
The regression explicitly passes the worker precheck, accepts remotely, revokes
locally while the history is in flight, then applies the acceptance; the pending
row remains cancellation-marked instead of becoming a completed receipt.

Cancellation is eventual only while the issuer retains member authority and
can reach the primary. If the issuer is removed first, its ordinary authority is
not restored: the cancellation remains unresolved. GetClusterClientAdoption
reports CancellationNeedsActiveMember, and new paired-only read RPC 97
GetClusterRevocationIssues returns the cluster ID, grant ID, expiration and
requiresActiveMember flag. Another current member must explicitly revoke that
grant in the primary log. These are local recorded issues, not fresh assertions
about remote grant state; externally resolved issues may remain until expiry
because a removed node cannot read newer history. No new cancellation-proof
RPC or removed-member write permission was added.

Unresolved rows survive rejoining another cluster/incarnation rather than being
silently discarded. They share the bounded 128-entry outbox and expire with the
grant. Retries only target the current cluster; cross-cluster unresolved issues
remain visible. A same-cluster rejoin can retry using its new active membership.

Begin skips revoked and cancellation-marked previous grants when looking for a
same-owner/key retry, issuing a new grant ID. The old receipt/tombstone remains;
late completion of the old grant does not reactivate it. Regression tests cover
both revoked receipts and unresolved cancellation markers.

Leave work is preserved separately in a local stash/patch and is not part of
this follow-up. RPC 96 is reserved for that work; this checkpoint registers 97
without claiming Leave support. Browser UI for these states is not implemented.

P2 validation: host 158 passed / 3 ignored; web/codegen 112 passed; TypeScript
check and web build passed. Windows runtime and browser cluster E2E remain
unverified. No main push, release or actual host/pairing changes were made.

## Normal Leave follow-up

RPC 96 LeaveCluster is a local paired-client action. It durably records one
operation for the current cluster/admission and returns Leaving, not a claim
that remote membership was already removed. The worker first synchronizes with
the primary, requests Remove for its own admission, and confirms detachment by
its signed self-removal prefix. No generic history or management permission is
restored after removal. A lost Remove response is recovered by that same proof
path; identical Leave retries return the current durable state.

The primary cannot leave before transferring authority. A target with an
acceptance still sealable at its current prefix cannot leave. These checks share
the local transaction with transfer preparation; new transfer preparation and
new adoption begin/complete are refused after Leaving is recorded. Existing
ordinary local pairing is unchanged. Primary unavailability leaves the request
pending instead of silently detaching or force-removing remotely.

Leave receipts bind operation ID to cluster/admission across rejoin. Replaying
an old operation cannot leave a new incarnation. There is at most one operation
per admission and a 512-receipt local bound; exhaustion returns Limit. Known
operation conflicts are rejected before recording Leave. This initial path has
no force-local-detach or cancel-Leave command.

The stash restoration conflicted only in shared RPC dispatch/registration,
state handlers and schema additions. Both reviewed adoption APIs and the fresh
credential-protected import boundary were preserved. The original stash and
local patch remain recovery copies, not unmerged production changes.

Actual localhost WebTransport tests cover normal Leave, unavailable primary,
duplicate requests, an acknowledged primary Remove deliberately not applied at
the leaving node (response-loss model), own-removal proof recovery and stale
Leave after a new cluster is created. This is not a process-kill/power-loss test.
The durable transfer-target rejection also has regression coverage. Host tests
passed 159 / 3 ignored; browser cluster UI and restricted join sync remain
unfinished. Windows enrollment stays disabled. No main push or deployment.

## Consent-scoped join synchronization

RPC 99 ConfigureClusterJoinSync is paired-only. It binds the existing local
reservation operation to a continuous, verified bootstrap history under the
already pinned genesis. Bootstrap peers/endpoints come only from that signed
history. It enables a bounded background bootstrap read without activating the
node; a bootstrap already containing its removal instead retires the reservation.
There is no key creation or network bootstrap solely from server startup.

PrepareClusterJoin now durably fixes a five-minute consent deadline. The v2
consent transcript signs that deadline in addition to the original cluster,
operation, admission, key, confirmation and endpoint fields. Retrying Prepare
never silently extends it. Old prototype reservations with no stored deadline
fail closed. This is an unreleased schema change, not a migration of real nodes.

RPC 98 ReadClusterJoinHistory is a dedicated public transport endpoint, not a
session authentication RPC. It consumes the existing bounded connection nonce,
verifies a distinct join-read signature binding server key, cluster, exact
consent digest, connection and nonce, and validates the target consent. The
server returns its current signed history only if its locally known log still
contains that exact active admission/key and consent digest. Not-yet-admitted,
removed, expired, wrong-consent, replayed and unsigned requests are denied.
The consent alone is not a bearer credential; the target private key must sign
the fresh connection challenge. A join-read proof cannot be reused as a peer
management proof, and the session remains unauthenticated for ordinary RPCs.

The worker verifies the responder against bootstrap keys, reads over normal TLS,
then verifies the latest history and exact admission consent before Finish.
Expiry and cancellation are rechecked at the local write transaction. Fresh
credential reconciliation at history application is retained. At most four
bootstrap peers are probed per tick, each with an eight-second timeout. Expired
reservations stop retrying successfully; expiry does not implicitly free the
local membership slot or remove a remote admission.

Limitations are explicit: cached replicas cannot guarantee revocation freshness
across a partition. Local cancellation prevents Finish, but remote removal still
uses the primary Remove operation; this scoped read does not grant anonymous
cancellation/tombstone writes. A client must orchestrate cancel/remove cleanup
before a new reservation after expiry. Browser orchestration and UI are still
pending. Existing paired manual Finish remains supported with the same expiry,
consent and retirement checks. No general capability-based management session or
removed-member write permission was added.

Localhost E2E covers bootstrap genesis mismatch, denial before Admit, successful
read after approval, nonce replay rejection, ordinary RPC denial on the same
connection, background Finish, and cancellation between response and Finish.
Separate fixtures verify expiry at Admit/read/sign/Finish, altered signed consent
against the committed digest, removal denial and signature-domain separation.
Windows enrollment remains disabled; no real host or pairing was changed.

Join-sync validation: host 162 passed / 3 ignored; web/codegen 112 passed;
TypeScript check and web build passed. Browser cluster flow and Windows execution
remain unverified. No main push, release or actual environment changes.

## Admit expiry under writer contention

New admission now acquires BEGIN IMMEDIATE before checking whether the operation
is an exact existing receipt or a fresh append. Caller authorization and local
identity are rechecked first. An exact request digest may replay its committed
receipt after consent expiry; changed content conflicts, and a fresh expired
consent is rejected without writing. The prior pre-transaction-only expiry check
was removed. Other RPCs and browser code are unchanged in this follow-up.

The regression holds a write transaction on another SQLite connection, signals
successful signature/unexpired preflight, proves the operation is still waiting,
lets the consent expire, releases the writer, and verifies Retired with an empty
journal. A separate test waits for the original deadline to pass and confirms
only the exact receipt replays; changed content is rejected.

Validation: full host suite 164 passed / 3 ignored; diff whitespace check passed.
No browser changes, main push, release or environment mutation in this checkpoint.

## Cluster client session authentication (server checkpoint)

Adds unary AuthenticateClusterClient (100), registered only on supported private
storage platforms. It consumes the existing five-second per-connection nonce
(single use, 128 global bound, one challenge/second). The Ed25519 transcript is a
canonical CBOR array headed `rieul.cluster.client-session.v1`, binding cluster,
known epoch/sequence/hash/primary, target admission/key, grant/client key, nonce
and connection ID. The pinned prefix must exactly exist in the verified local
log. No history or address is returned before proof succeeds; a valid proof
returns current verified history. Challenge server proof remains bound to the
cluster and server key, which the caller must obtain from its pinned history.

Session authority is a typed Principal, not a parsed client ID or copied paired
credential. General RPC admission revalidates grant, expiry, local admission/key,
node membership and minimum observed log position. Management mutations recheck
the principal within their existing write transactions before receipts. Screen
credentials combine local records with currently valid cluster subjects without
writing synthetic local credentials. Update RPCs accept the same validated
principal. Local-pairing adoption and secret renewal are not grant-minting
shortcuts: adoption entry RPCs require a local pairing, and renewal has no local
credential to renew for a cluster subject.

The existing 100ms session tick closes a grant session on invalidity. Per-session
stream tasks are scoped in a JoinSet and abort at connection exit, including idle
subscriptions. Screen's existing attachment/connection cleanup releases held
input. Already admitted operations may complete at their operation boundary;
this is not retroactive cancellation of completed effects. Cached replicas still
cannot learn revocations during a partition. Forwarded management retains the
trusted member's signed original-principal attestation and dispatch boundary.
Database rollback fencing remains outside the supported recovery model.

Tests cover proof field substitution, exact pinned prefix, revoked grant write
recheck, expiry/removed node/new incarnation/older state, and real localhost
WebTransport connections to two fixture daemons after automatic adoption. Those
connections use only the synthetic client's private key; ordinary environment,
Screen and management reads succeed. Nonce replay fails. Issuer removal preserves
the accepted grant on the other daemon, while removed-node and revoked-grant
connections close and held synthetic input is released. These are Rust transport
fixtures, not browser E2E. Browser key storage, history verification, automatic
adoption initiation/discovery and UI remain the next separate checkpoint.

Validation: full host 167 passed / 3 ignored; web/codegen 112 passed; TypeScript
check and production web build passed. No actual host, credential, permission,
main push or deployment changes. Independent auth review is required before
publication; Windows enrollment remains disabled.

## Follow-up: typed forwarding and admitted-operation drain lifetime

The prior server checkpoint had two review blockers, now corrected separately
from the stashed browser work:

* Peer envelopes carry ClusterOriginalPrincipal: LocalPairing(client ID),
  ClusterGrant(cluster ID, grant ID, client public key), or Node. The explicit
  canonical peer-request transcript is now v2 and signs that tagged identity.
  No paired-prefix string parsing or implicit grant-to-node downgrade remains.
  The primary checks the grant on receipt and retains a typed Principal for a
  fresh check inside the write transaction. A trusted member's local pairing
  attestation remains distinct from a cluster grant and background node work.
* Protected RPC operations own their existing WorkGuard in an independently
  running task. Canceling the connection's response task therefore cannot drop
  admission while spawn_blocking work remains live. Unprotected subscriptions
  still cancel with the connection; protected input/file streams terminate on
  transport closure, while already admitted mutations finish before releasing
  drain protection. This preserves existing accepted-operation semantics and
  does not add a force-cancel/update path.

Regression: a replica with stale history still accepts G locally after primary
revocation, but its signed grant envelope is rejected at the primary. An envelope
authenticated before revocation also fails the transaction recheck without log
change; altering the identity mode without resigning fails verification.
Transport regressions hold a real SQLite writer lock while ApplyClusterHistory
is admitted, disconnect paired and grant sessions, assert WorkGate stays busy
and drain denied, then release the writer and assert the gate/drain recover.
The grant session reconnects with a fresh proof and explicitly reacquires input;
subsequent removal/revocation still closes live sessions and releases keys.

Validation: cluster subset 46 passed; full host 169 passed / 3 ignored;
web/codegen 112 passed, TypeScript check and production build passed. Browser
work remains stashed and unconnected. No main push or real environment changes.

## Browser automatic adoption, discovery and opt-in UI checkpoint

Browser code is separate from the server-auth follow-ups. `web/src/cluster`
implements explicit canonical transcripts and bounded signed journal verification
(genesis, request digest, previous hash, primary signature, admission tombstones,
transfer acceptance, client/issuer adoption proofs and grant revocation). It
checks the saved prefix and uses an IndexedDB transaction to prevent concurrent
responses from replacing newer history. Discovery also fences older results
before publishing machine state. Endpoints remain tied to cluster/admission/key;
an address match alone never transfers an existing machine's credentials.
Signed HTTPS/443 origins bypass the manual machine-entry default port 9012.

Per-cluster Ed25519 private CryptoKeys are nonextractable and structured-cloned
into IndexedDB. Concurrent tabs generate candidates outside the transaction and
atomically get-or-add one winner; keys and paired secrets are never forwarded.
Storage/crypto failures only affect cluster sync, preserving the existing local
paired session. Pairing adoption starts automatically on an authenticated member,
without an extra upgrade button. Pending operations retry on reconnect and the
five-second background refresh; accepted grants automatically add and connect
members through the same scoped session machinery. Local pairing sessions remain
available for normal credential renewal. Explicitly revoked grants do not cause
automatic re-adoption; fresh local pairing may request new access. Expired grants
can renew through a still-valid local pairing, distinct from a revoke tombstone.

Daemon UI exposes create, join/resume, leave, cancel-join and pending cleanup.
Create/join confirmation explicitly states full member trust, cluster-wide client
access and adoption of existing local pairings. Unsupported enrollment exposes no
actions (including current Windows builds). Cancel retires locally before remote
cleanup and labels unresolved cleanup accurately; no forced detach or promotion.
An explicit successful create/join updates the machine's cluster binding rather
than silently carrying trust across clusters. Primary transfer and explicit
cluster-grant administration remain RPC-level operations: this checkpoint does
not yet provide their dedicated UI. Forced primary recovery remains unsupported.

Real browser evidence: ignored host test
`browser_cluster_pairing_adoption_and_second_node_access` starts two localhost
fixture daemons, uses a new headless Chrome profile, and pins only their short-lived
synthetic certificates in a test-only WebTransport constructor. Rust setup enrolls
the two nodes; the browser then performs StartPairing/CompletePairing once, reloads
the actual app, observes automatic adoption/discovery, and accesses the other node
with the product grant-auth code. Additional browser steps cover nonextractability,
concurrent-tab key creation, reload/reconnect, narrow UI, IndexedDB failure with
local RPC still working, leave, cancel cleanup, fresh-incarnation rejoin, late
Finish rejection, and revoke without automatic re-adoption. Browser tests do not
restart an OS service; daemon crash/reopen coverage remains the existing runtime
suite. No actual host screen, input, credentials, ACLs or membership were used.

Validation: full host 169 passed / 4 ignored (browser test separately passed);
web/codegen 116 passed; type check and web build passed; existing UI suite 43 passed
using installed Chrome plus the new cluster UI test passed. Screenshot inspected:
`tmp/cluster-browser-narrow.png`. Browser fixture log: `tmp/cluster-browser-e2e.log`.
No main push, CI publication, release or deployment. Independent review required.
