# Phase 243 — Verification

## Command
  $env:NEXUS_PERSISTENCE_MODE="shared"
  $env:DATABASE_URL="postgres://postgres:postgres@localhost:55432/nexus"
  $env:NEXUS_POSTGRES_CONTAINER="nexus-pg"
  npm run test:phase243

## Environment used
- PostgreSQL 16 via docker compose (`nexus-pg`, port 55432).
- Real child processes via `spawn(process.execPath, ["--import", "tsx", CHILD, ...])`.
- No mocks of the persistence layer.

## Result (this run)
PASS: 39
FAIL: 0
BLOCKED: 0
NOT EXECUTED: 0

## Coverage
A01 probe | A02 create | A03 scheduling | A04 idempotency | A05/06/07 concurrency
A08/09/10 fencing | A11/12/13 crash | A14 restart | A15 max-attempts | A16 non-retryable
A17 classification | A18 cross-process idempotency | A19 invariants | A20 no-SQLite-fallback
A21 TypeScript | A22 shutdown | A23 Phase 242 regression

## Invariants checked
I02 no op has >1 authoritative owner
I03 non-retryable has NULL next_attempt_at
I04 no runaway attempt_count
I08 recovery operations persisted in Postgres

## Not covered here
I01 (job lease uniqueness), I05/I06/I07/I09 live in the Phase 184 verifier and
are unaffected by Phase 243 changes.
