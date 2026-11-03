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
