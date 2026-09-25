# NEXUS Phase 195 — Migration Integrity Evidence

## 1. Scope

Phase 195 was scoped to production migration integrity, fresh-database
bootstrap correctness, schema dependency validation, and recovery-state
durability. The Phase 194 investigation surfaced a warning:

    160_phase175_recovery_retry_state.sql:
    no such table: release_deployment_intents

Phase 195 was to determine whether that warning represented a test
fixture defect, a migration discovery/ordering/transaction/dependency
defect, an environment defect, or a genuine production migration defect,
and to either fix the root cause or document why no fix was required.

## 2. Baseline

    HEAD:  e0385c2307c0bc959be177a75ff31187695f42b3
    tag:   nexus-phase194-complete
    branch: master == origin/master

Phase 194 commits (0688b55, 7ba892f, 76114e7, e0385c2) are untouched.
Phase 193 commits (b1adf30, 545ce5a, cbbd1a4) are untouched.

## 3. Repository discovery

Actual paths (verified, not assumed):

    migration directory       src/db/migrations/
    migration runner          src/core/migration-runner.ts
    production bootstrap      src/core/sqlite-engine.ts SQLiteEngine.open()
    history table             nexus_schema_migrations
    integrity checker         src/core/persistence-integrity.ts
    server-side health        src/server/db-health.ts

MigrationRunner.getMigrations() reads every *.sql file in the migration
directory and sorts them lexicographically by filename. That ordering is
deterministic and places migration 146 before migration 160
(discovered indices: i146=132, i160=146 among 151 files).

SQLiteEngine.open() runs the full MigrationRunner chain synchronously
before the engine is returned. It is the sole production bootstrap path
(no alternate initialization code path exists; only persistence-integrity
and db-health read the same history table for diagnostics).

## 4. Root cause

Classification: **TEST_FIXTURE_DEFECT**.

The Phase 194 evidence trail captured this warning only during the first
iteration of `scripts/test-phase194-execution-continuity.ts`, which used
a hand-rolled MIGS array listing six migrations
(142, 149, 154, 155, 156, 160). That array omitted 146 — which creates
`release_deployment_intents` — so migration 160's
`ALTER TABLE release_deployment_intents ...` failed.

The hand-rolled array was replaced by `SQLiteEngine.open()` in the Phase
194 rewrite, which runs the real production chain. Re-running the
unchanged Phase 194 test during Phase 195 reconnaissance shows no
`[mig-warn]`, no `no such table`, and no reference to
`release_deployment_intents` in stderr. The warning is gone because the
fixture defect that produced it is gone.

Phase 194 correctly closed because the warning never affected the
correctness of the execution-continuity assertions: the six-migration
fixture still created every table those assertions touched. The warning
was diagnostic noise from an incomplete harness, not a production
migration failure.

No production migration change is required.

## 5. Fix

No production source file was changed.

The fix for the warning was already delivered inside Phase 194
(commit 0688b55, the rewrite of test-phase194-execution-continuity.ts to
use SQLiteEngine.open()). Phase 195 adds a dedicated migration-integrity
test and this evidence document.

Changed in Phase 195:

    scripts/test-phase195-migration-integrity.ts   new
    docs/PHASE_195_MIGRATION_INTEGRITY_EVIDENCE.md new (this file)

## 6. Fresh database evidence

Fresh on-disk SQLite file. Production bootstrap via SQLiteEngine.open().

    Migration file count: 151
    §1 migration 146 discovered  146_phase103_durable_release_intents.sql
    §1 migration 160 discovered  160_phase175_recovery_retry_state.sql
    §1 deterministic lexicographic order: 146 before 160
       i146=132 i160=146
    §2 migration history populated  history=151 files=151
    §2 no migration missing from history
    §2 no checksum drift  drift=0
    §2 migration 146 recorded
    §2 migration 160 recorded

All 151 migrations applied in order; every history row checksum matches
the SHA-256 of its on-disk file.

## 7. Schema contract evidence

Twelve required tables verified present after fresh migration:

    nexus_schema_migrations
    nexus_records
    execution_jobs
    execution_attempts
    execution_leases
    execution_artifacts
    execution_recovery_operations
    execution_ownership_obligations
    release_deployment_intents
    ci_artifact_reconciliations
    ci_reconciliation_worker_ownership
    execution_events

The list was derived from actual code paths in ExecutionStore,
ExecutionRecoveryOperationStore, CiArtifactReconciliationService,
CiReconciliationOwnershipService, and the release-deployment bridge.

## 8. Reopen + idempotency evidence

    §4 history survives reopen  n=151
    §4 schema survives reopen
    §5 second run: no new history rows  before=151 after=151
    §5 checksum verification passes after second run

A second invocation of MigrationRunner.run() over the same database is a
no-op. History row count is unchanged. Checksums still verify.

## 9. Upgrade evidence

Scenario: an older database that has applied the first 100 of 151
migrations (simulated by running migrations up to index 99 directly and
recording them in nexus_schema_migrations), plus one durable marker row
inserted into nexus_records under store='kv'.

    §6 upgrade: partial DB has 100 of 151 migrations
    §6 upgrade completed full migration chain  final=151 expected=151
    §6 pre-existing row survived upgrade
    §6 required table present after upgrade

The partial database completed the remaining 51 migrations through the
production path. The marker row inserted before the upgrade is still
readable afterwards. release_deployment_intents is present. No
destructive reset was performed.

## 10. Restart durability evidence

    §7 execution job + lease created before restart
    §7 execution job survives restart
    §7 lease survives restart  worker=worker-p195

Created a real job + lease via ExecutionStore + LeaseManager, closed the
SQLite engine, reopened it via SQLiteEngine.open(), then read both back.
Both survived.

## 11. Regression evidence

    Phase 126  execution lifecycle            51 / 0
    Phase 127  execution state machine       111 / 0
    Phase 142  atomic claim                  PASS
    Phase 148  atomic attempt allocation     PASS
    Phase 153  recovery lease fencing        PASS
    Phase 181  persistence durability         66 / 0
    Phase 191  deployment execution           11 / 0 / 0
    Phase 192  restart safety                 17 / 0
    Phase 193  concurrent boot                 6 / 0 / 6 BLOCKED
    Phase 194  execution continuity           22 / 0 / 0
    Phase 194  concurrent lease                6 / 0 / 0
    Phase 195  migration integrity            32 / 0 / 0
    TypeScript compilation                    exit 0
    Production build                          exit 0

Pre-existing failures unchanged (verified by stash in Phase 194; not
touched by Phase 195):

    Phase 136  execution recovery   fixture FATAL — its in-memory DB
              loads migrations 020/021/022/025/142/143/144/149 only and
              omits 154 (execution_recovery_operations) and 164
              (attempt_id on execution_artifacts). Unrelated to fresh-DB
              migration integrity.
    Phase 158  recovery worker heartbeat   91 / 1

## 12. BLOCKED coverage

    PostgreSQL shared-backend migration chain    NOT_RUN
        Postgres is reachable in this environment (docker container
        nexus-phase183-postgres) but the fresh-DB / upgrade / idempotency
        scenarios were exercised against SQLite only, matching the
        scope of the migration runner that was investigated. Migrations
        in this repository target SQLite's sqlite_master and file-based
        history table. The shared-backend Postgres schema is bootstrapped
        separately by src/core/pg-bootstrap.ts and was not part of the
        Phase 194 warning.

    Phase 158 single failing assertion    NOT_RUN
        Pre-existing, not caused by migration behavior.

## 13. Known limitations

  - The upgrade test simulates "older database" by applying the first
    100 migrations directly rather than by checking out an old commit.
    The 100-migration subset is sufficient to prove the forward-only
    completion path but does not exercise older SQLite WAL versions.
  - The 12-table schema contract list is the set of tables Phase 194
    and Phase 195 exercised. It is not claimed to be exhaustive.
  - PostgreSQL migration integrity is out of scope (see §12).

## 14. Final commits and tag

  commits:  see the git log immediately following this document
  tag:      nexus-phase195-complete (created after this doc is committed)
