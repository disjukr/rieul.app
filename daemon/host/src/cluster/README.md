# Cluster foundations (test-only)

This module is compiled only under `cfg(test)`. It registers no RPC, changes no
pairing or authentication decision, creates no production keys, and opens no
production database. The SQLite files in its tests are disposable fixtures.
These are executable models for review, not an available cluster feature.

## Proof transcript

The prototype uses the existing ring 0.17.14 Ed25519 implementation, as a dev
dependency. Public keys are exactly 32 bytes and signatures exactly 64 bytes;
invalid signatures, lengths, contexts and encodings fail closed. Node and client
keys have distinct Rust types. Node identity is SHA-256 of the fixed canonical
CBOR array `["rieul.cluster.node-id.v1", keyBytes]`.

The signed transcript is a fixed canonical CBOR array, built explicitly rather
than by reserializing an arbitrary BDL object:

1. `"rieul.cluster.proof.v1"` (format/domain)
2. purpose: server challenge = 0, node possession = 1, client possession = 2
3. cluster ID (32 bytes)
4. server/issuer public key (32 bytes)
5. server/issuer incarnation (32 bytes)
6. subject role: node = 0, client = 1
7. target subject public key (32 bytes)
8. connection challenge identity (32 bytes)
9. fresh nonce (32 bytes)
10. exact request hash (32 bytes)
11. exact expected origin (nonempty, at most 2048 UTF-8 bytes)

The expected context is supplied by a future trusted transport integration, not
accepted from a claimant. Verification compares the complete expected encoding
before verifying its signature; alternate encodings and unknown/trailing fields
are rejected without decoding untrusted CBOR lengths. The origin is compared
exactly, not normalized. The request hash must bind all operation-specific
fields, including a joining node's requested incarnation. The request hash is supplied by the caller; the actual request → hash →
admission → activation integration is unimplemented. That request format and
browser cryptographic interoperability remain undecided. This transcript is
not yet a public wire contract.

A bounded cache holds at most 256 challenges with monotonic deadlines of at most
60 seconds. Valid proof verification and removal are one serialized operation.
A failed proof does not consume the valid challenge; expiry and connection close
remove it, and process restart discards all outstanding challenges. A collision
or RNG failure aborts issuance. Connection IDs and expected keys must be bound
by the future transport; these helpers alone do not prevent relay attacks or
establish TLS channel binding, membership, or authorization.

## Local membership slot

An isolated SQLite transaction reserves the sole local slot before admission.
A reservation persists over restart and never silently expires. Competing joins
are serialized with an immediate transaction. An operation ID stores immutable
cluster, incarnation and request hash: identical retries return its retained
outcome, while changed content conflicts. Activation models only the local
commit **after** admission validation; no such validator exists here.

Cancellation/leave atomically retires the incarnation, preserves the operation
receipt and frees the slot. Delayed activation cannot revive it; replaying its
retirement cannot clear a later reservation. Rejoining requires a new operation
ID and incarnation. Generations advance only on committed transitions, with
checked overflow. Tombstones and receipts are deliberately never compacted in
this model. No synchronization or import may overwrite them.

This guarantees local zero-or-one membership only for processes sharing this
SQLite file. It does not arbitrate cloned/restored state, distributed membership,
or offline revocation. A returned outcome is the current durable outcome of the
same operation, not a fresh admission side effect. Tests model interruption by
rolling back open transactions and reopening the database; they do not claim
power-loss or filesystem durability validation.

## Primary-managed membership direction

The selected direction is a designated primary for ordered membership management,
with no automatic promotion. Data-plane services remain independent peers. See
[PRIMARY.md](PRIMARY.md) for the reviewed direction, internal fixture checkpoint,
normal handoff seal algorithm and outstanding authentication/grant boundaries.
The separate unpublished union experiment is not included on this branch.

`primary.rs` is also test-only. No admission RPC, authentication integration,
automatic connection or live cluster state is introduced. Client grant policy,
issuer-removal behavior and existing pairing expansion remain undecided. Partition
revocation freshness and old-backup split-brain recovery are not solved by a local
seal or management epoch.
