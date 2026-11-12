# WP8 — Schema and migration integrity

**Classification: PASS**

Verified on 2026-11-11 by fresh independent PostgreSQL bootstrap
(test-phase300-wp8-fresh-bootstrap.ts, 12/12 PASS): isolated DB
created, production bootstrap runs twice (idempotent), all 17 columns
present with correct PostgreSQL types, PK on result_id, both FKs
(job_id → execution_jobs NO ACTION; dispatch_id → remote_dispatches
ON DELETE CASCADE), all 3 indexes, actual async writer persists
success=false round-trip as BOOLEAN, DROP DATABASE verified.

## Verified PostgreSQL bootstrap and live schema

The PostgreSQL bootstrap path in `src/core/pg-bootstrap.ts` creates
`remote_execution_results` and its three required indexes.

On 2026-11-10, the live PostgreSQL database `nexus`, schema `public`,
was inspected using `information_schema.columns`.

Observed result: 17 columns.

All 17 live column definitions match the current PostgreSQL bootstrap DDL:

- `result_id`: TEXT PRIMARY KEY
- `job_id`: TEXT NOT NULL
- `attempt_id`: TEXT NULL
- `worker_id`: TEXT NULL
- `dispatch_id`: TEXT NULL
- `lease_id`: TEXT NULL
- `success`: BOOLEAN NOT NULL
- `exit_code`: INTEGER NULL
- `stdout_ref`: TEXT NULL
- `stderr_ref`: TEXT NULL
- `evidence`: TEXT NULL
- `created_at`: BIGINT NOT NULL
- `stdout_sha256`: TEXT NULL
- `stderr_sha256`: TEXT NULL
- `result_sha256`: TEXT NULL
- `verification_status`: TEXT NULL, default 'PENDING'
- `verified_at`: BIGINT NULL

Both expected foreign keys were confirmed:

- `job_id` references `execution_jobs(id)`.
- `dispatch_id` references `remote_dispatches(dispatch_id)` ON DELETE CASCADE.

All three expected indexes were confirmed:

- `idx_remote_results_job` on `(job_id)`
- Unique `idx_remote_results_dispatch` on `(dispatch_id)`
- `idx_remote_results_worker` on `(worker_id, created_at DESC)`

## Runtime writer verification

`scripts/test-phase268-remote-result-integrity.ts` includes test H.

Test H invokes the actual asynchronous PostgreSQL result writer with
`success: false`, then reads the persisted value and PostgreSQL type.

Observed result:

- Persisted value: `false`
- PostgreSQL type: `boolean`
- Phase 268 suite: 8 PASS / 0 FAIL / 0 BLOCKED

The SQLite synchronous writer retains its INTEGER 1/0 representation.
The PostgreSQL asynchronous writer binds a native boolean.

## SQLite migration type differences

SQLite migrations 022 and 025 define INTEGER for `success`,
`created_at`, and `verified_at`.

The PostgreSQL bootstrap intentionally uses:

- `success BOOLEAN`
- `created_at BIGINT`
- `verified_at BIGINT`

These are backend-specific physical types. The live PostgreSQL schema
matches the PostgreSQL bootstrap. Identical physical types across SQLite
and PostgreSQL are not required.

## Fresh-database bootstrap verification

A fresh, independently initialized PostgreSQL database was created
(`nexus_p300wp8_<random>`) and bootstrapped via `bootstrapPgSchema`
on 2026-11-11. All 12 properties required by Phase 300 Section 7
were verified against that fresh DB.

Test: `test-phase300-wp8-fresh-bootstrap.ts` — 12/12 PASS.

Verified properties:
- Isolated database created
- Production bootstrap ran twice (idempotent)
- `remote_execution_results` created with all 17 columns and correct
  PostgreSQL types
- Primary key on `result_id`
- FK `job_id` -> `execution_jobs(id)` (NO ACTION)
- FK `dispatch_id` -> `remote_dispatches(dispatch_id)` ON DELETE CASCADE
- All three indexes present and correct
  (`idx_remote_results_dispatch` UNIQUE, `idx_remote_results_job`,
  `idx_remote_results_worker`)
- Actual async writer persists a result in the isolated database
- Persisted row has `success=false` round-trip as BOOLEAN false
- `DROP DATABASE` verified

No production database migration or schema alteration was performed
during this verification.

## Evidence classification

- Live PostgreSQL column inspection: PASS
- PostgreSQL bootstrap column-definition comparison: PASS
- Foreign-key inspection: PASS
- Index inspection: PASS
- Native PostgreSQL BOOLEAN writer regression: PASS (8/8 suite)
- Fresh independent PostgreSQL bootstrap: PASS (12/12 checks)

WP8 is verified.