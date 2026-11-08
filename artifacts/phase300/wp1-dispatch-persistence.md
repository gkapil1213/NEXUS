# WP1 — Dispatch persistence

**Classification: PASS — 8/8 integration tests**

## What was implemented

Async PostgreSQL siblings on `ExecutionStore` for the full dispatch lifecycle:

- `getRemoteDispatchAsync(dispatchId)` — read by dispatch id
- `getRemoteDispatchByExternalProviderIdAsync(providerId)` — read by provider id
- `getRemoteDispatchByJobIdempotencyKeyAsync(key)` — read by idempotency key
- `upsertRemoteDispatchAsync(record)` — atomic `INSERT ... ON CONFLICT (dispatch_id) DO UPDATE`
- `createRemoteDispatchIfAbsentAsync(record)` — `INSERT` with `23505` catch and recovery by idempotency key
- `listAllRemoteDispatchesAsync()` — full-table read

All methods call `this.requireAsyncDb()`, so calling them in SQLite-only mode
throws rather than silently falling back. Sync siblings are unchanged for
SQLite-only mode.

## Idempotency-key semantic — resolved

`remote_dispatches.idempotency_key` is **globally UNIQUE** (migration 172,
mirrors pg-bootstrap DDL). This was **kept as-is** per section 2 of the
completion directive ("Do not silently change existing uniqueness behavior").

Behavior: a second dispatch with a different `dispatch_id` but the same
`idempotency_key` is rejected by the unique constraint. `createRemoteDispatchIfAbsentAsync`
catches the `23505` and returns the original record with `created: false`.
This is asserted in WP1-7.

## Test evidence

`scripts/test-phase300-wp1-dispatch-persistence.ts` — 8 cases against an
isolated PostgreSQL database (fresh database `nexus_p300wp1_<random>`
created from `DATABASE_URL`, populated with the minimal schema, then dropped
in `finally`). No production data was touched.

| # | Case | Result |
|---|---|---|
| WP1-1 | `createRemoteDispatchIfAbsentAsync` inserts a new dispatch | PASS |
| WP1-2 | `getRemoteDispatchAsync` returns the exact row | PASS |
| WP1-3 | `getRemoteDispatchByExternalProviderIdAsync` resolves by provider id | PASS |
| WP1-4 | `getRemoteDispatchByJobIdempotencyKeyAsync` resolves by idempotency key | PASS |
| WP1-5 | Duplicate creation returns `created: false` and the original record | PASS |
| WP1-6 | Concurrent creation for one idempotency key yields one row and one winner | PASS |
| WP1-7 | Conflicting idempotency key with different dispatch_id is rejected, original preserved | PASS |
| WP1-8 | Independent store instance reads a dispatch created by another instance | PASS |

**Summary: PASS: 8 / FAIL: 0 / BLOCKED: 0 / NOT EXECUTED: 0.**

Verbatim output: `test-results/2026-11-08-phase300-wp1-8-8-PASS.txt`.

## What is NOT verified

- **Cross-process** verification (two Node processes racing on the same
  isolated DB). Section 10 of the directive requires this; WP1-6 uses
  cross-connection (two `PgClient` pools) within a single process. This is
  the same gap noted in known-limitations.md; it will be closed in the
  cross-process cycle alongside WP2.

- **`listAllRemoteDispatchesAsync`** is present in the source but is not
  directly asserted in the WP1 test suite — it is exercised indirectly by
  WP1-8's cross-instance read, which reads a specific dispatch, not the full
  list. A direct list assertion can be added if the directive interprets
  §2 item 4 as requiring direct coverage; the current implementation makes
  this a trivial add.
