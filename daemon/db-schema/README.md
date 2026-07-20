# Daemon state database schema

This directory contains the SQLite schema for the daemon state database. The
database is an implementation detail of the daemon host, not a client-facing
protocol contract.

`migrations` is the source of truth. Migration files use a zero-padded version
prefix and are applied in that order. Once released, an existing migration must
not be changed. Add a new file and register it in `MIGRATIONS` in
`daemon/host/src/db_schema.rs` instead.

`current.sql` is a generated snapshot for inspecting and reviewing the current
schema. The daemon never executes this snapshot; it always applies migrations.
Do not edit `current.sql` directly. Regenerate or verify it from the repository
root:

```sh
deno task db-schema:generate
deno task db-schema:check
```
