# WP8 — Schema and migration integrity

**Classification: CODE COMPLETE — PARTIAL VERIFICATION**

src/core/pg-bootstrap.ts now creates remote_execution_results on the
Postgres bootstrap path. Prior to commit 40b0ef3, this table was absent
from pg-bootstrap even though it exists in the live DB and is created by
SQLite migration 022, altered by 025, and indexed by 176.

The DDL added matches the live DB's index structure (verified against
phase299-constraint-index-inventory.json):

- CREATE UNIQUE INDEX idx_remote_results_dispatch ON (dispatch_id)
- CREATE INDEX idx_remote_results_job ON (job_id)
- CREATE INDEX idx_remote_results_worker ON (worker_id, created_at DESC)

What is verified:

- The table is created by pg-bootstrap.ts and the three indexes match the
  live DB.
- The table exists at runtime — test-phase268-remote-result-integrity.ts
  inserts, reads, and deletes rows from it against live PostgreSQL at
  DATABASE_URL.

What is NOT verified:

Column-type parity between our pg-bootstrap DDL and the live DB:

- success INTEGER NOT NULL in our DDL; live DB type not introspected
  (no psql on PATH; the column-inventory JSON has not been read for this
  table).
- created_at BIGINT NOT NULL — matches pg-bootstrap epoch-millis convention;
  SQLite migration uses INTEGER.
- verified_at BIGINT — migration 025 declares INTEGER; we use BIGINT for
  epoch-millis consistency. Deliberate divergence; requires validation.

No schema changes were made to the live database in this session. The
pg-bootstrap DDL is additive: CREATE TABLE IF NOT EXISTS. If the live table
already exists with a different type for success, the DDL is a no-op and no
drift is introduced. But a fresh bootstrap of a clean PostgreSQL would
create the table with our INTEGER / BIGINT types, which may not match a
production instance that was created by running migrations manually.

No migration files were added or modified.

Known limitation: column-type drift between pg-bootstrap DDL and the live
DB is NOT VERIFIED. See known-limitations.md.
