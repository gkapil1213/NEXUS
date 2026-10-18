# NEXUS Phase 270 - PostgreSQL Crash/Restart, Durable Recovery and Shutdown Integrity

## Objective

Implement Phase 270 as a production-oriented verification phase that closes the PostgreSQL coverage gaps identified in `docs/phase267/PHASE267_REPORT.md`.

This is an additive reliability and verification phase. Do not redesign NEXUS, replace persistence implementations, weaken existing invariants, or add unrelated features.

## 1. Repository protection and preflight

1. Inspect the current branch, commit, working tree, `package.json`, Phase 267 tests, Phase 198 ownership tests, Phase 265/266 suites, PostgreSQL adapter, migrations, recovery-operation stores and shutdown implementation.
2. Preserve all existing user changes. Do not reset, clean, overwrite unrelated files or amend existing commits.
3. Record the baseline commit and working-tree state in the Phase 270 report.
4. Never run destructive tests against a production or shared PostgreSQL database.
5. PostgreSQL tests must require an explicitly configured, isolated test database. Validate the connection and database identity before executing tests. If isolation cannot be established, report `BLOCKED` and skip PostgreSQL tests safely.
6. Never drop a schema, truncate shared tables, or reset a database that may contain user data.

## 2. Real PostgreSQL child-process crash/restart coverage

Extend the existing Phase 267 test design and child-process helper where appropriate. Reuse existing production interfaces and migrations rather than creating a fake persistence implementation.

Add PostgreSQL variants for the applicable lifecycle scenarios currently tested only with SQLite, including:

- Operation created but not yet claimed.
- Process killed after a durable claim.
- Process killed after transition to `IN_PROGRESS`.
- Mutation committed before operation completion, where the production interface permits deterministic fault injection.
- Expired claim recovery by a different engine or process.
- Two workers competing for the same operation.
- Repeated startup reconciliation and idempotency.
- Stale or inconsistent claim ownership.
- Database errors during mutation or finalization, verifying errors cannot be reported as success.

Use separate Node child processes and a genuinely shared PostgreSQL test database. After each child exits, reconnect independently and inspect persisted rows using the supported asynchronous store API.

Use deterministic synchronization, bounded timeouts and unique test identifiers. Do not rely on arbitrary sleep durations when a readiness signal or explicit state poll is possible.

Distinguish clearly between:
- `REAL CHILD-PROCESS RESTART`
- `IN-PROCESS FAULT INJECTION`
- `REAL POSTGRES SERVER RESTART`

Do not describe a process kill as a PostgreSQL server restart.

## 3. Actual PostgreSQL server restart - conditional

Determine whether the local environment provides a disposable PostgreSQL instance that can safely be restarted, such as a dedicated test container.

If available, add a separately reported test that:
1. Creates and commits a recovery operation.
2. Stops or restarts the disposable PostgreSQL server through a documented, supported mechanism.
3. Waits for readiness with a bounded timeout.
4. Reconnects using a new client.
5. Verifies that committed operation state, ownership fields, retry metadata and recovery eligibility remain correct.
6. Verifies that database unavailability is never misreported as successful recovery.

Never restart a shared or production database.

If a disposable server cannot be safely controlled, report this specific test as `BLOCKED` or `NOT EXECUTED` with the reason. Do not simulate it and claim a pass.

## 4. PostgreSQL shutdown and reconciliation tests

Add a PostgreSQL-backed counterpart to `scripts/test-phase267-shutdown-reconciliation.ts`.

Use the actual async recovery-operation APIs and production shutdown guard. Cover:
- Reconciliation does not begin after shutdown is marked.
- Shutdown does not falsely finalize pending or in-progress work.
- Existing durable claims remain consistent.
- A peer cannot steal a live claim.
- Expired claims can only be recovered according to the production eligibility rules.
- Repeated shutdown and reconciliation calls remain safe.
- Persistence errors surface explicitly.
- Reconnecting after shutdown sees durable, valid state.

Keep SQLite shutdown tests intact as regression coverage. Do not force synchronous SQLite-only test assumptions into PostgreSQL code.

## 5. Invariants that must remain true

Assert and preserve the existing production invariants:
- Only the current claim owner may finalize an operation.
- Expired or invalid ownership cannot authorize finalization.
- Retry timing eligibility is respected.
- `RECOVERY_REQUIRED` operations are not accidentally treated as ordinary resumable operations.
- Reconciliation is idempotent.
- Concurrent claim attempts cannot both become the valid owner.
- Database failures cannot silently turn an unknown outcome into success.
- Shutdown prevents new reconciliation work where the existing contract requires it.
- Existing Phases 144, 157, 178, 197, 198, 199, 264, 265, 266, 267 and 269 must continue to pass unchanged. Phase 270 is additive: it extends coverage, it does not modify existing invariants or remove existing test assertions.

## 6. Completion criteria

- All new Phase 270 tests pass against a real PostgreSQL instance.
- All existing phase suites continue to pass unchanged.
- The harness (scripts/phase266-verify.ps1) is extended with the Phase 270 steps and exits 0 in default mode.
- The harness exits 1 in strict mode when PG is unavailable (existing behavior preserved).
- docs/phase270/PHASE270_REPORT.md documents the baseline commit, test results, coverage matrix, and any BLOCKED/NOT EXECUTED items with reasons.
- Tag phase270-postgres-crash-restart created and pushed.
- No regression in any prior phase.

## 7. Baseline

- Baseline commit: e43ddc5acc11bffbb13c64889d2c903f0891f249
- Phase 269 tag: phase269-recovery-observability
- Working tree at Phase 270 start: clean
- PostgreSQL container: nexus-pg (postgres:16, port 55432), reachable
- DATABASE_URL: postgres://postgres:postgres@localhost:55432/nexus