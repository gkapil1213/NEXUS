# NEXUS Phase 267 — Crash/Restart Recovery and Graceful Shutdown Integrity

## Baseline

- Phase 266 status before Phase 267: PASS (503 assertions, 0 fail, 0 blocked), reproduced 3×.
- Working tree at start: pre-existing Phase 265/266 modifications preserved (execution-engine.ts, pg-client.ts, test-phase141, test-phase198, test-phase199, plus .bak files).
- No `git reset --hard`, `git clean`, or destructive checkout commands were run against Phase 267 work.

## Defects reproduced

None. Every Phase 267 §4 safety invariant was already enforced by the existing code:

| Invariant | Enforcing predicate | Source |
|---|---|---|
| Single valid owner per claimed op | `claim_owner = ?` on every mark | `execution-recovery-operation-store.ts` |
| Expired ownership cannot finalize | `claim_expires_at IS NOT NULL AND claim_expires_at > ?` | same |
| Retry eligibility honored | `next_attempt_at IS NULL OR next_attempt_at <= ?` | same |
| `RECOVERY_REQUIRED` not auto-retried | excluded from `listResumableOperations` | same |
| Shutdown does not falsely complete | `if (this.shuttingDown) return;` at reconcile head | `execution-engine.ts:2294` |
| DB errors do not become success | failures surface, never swallowed | `runRecoveryOperationAsync` catch paths |

No production code was changed. Per Phase 267 §6, no fix was made without a reproduced defect.

## Code changes

Added (new files only; no modification to `src/core/*`, migrations, schemas, or public APIs):

- `scripts/_phase267_crash_child.ts` — child process driver for real cross-process crash tests.
- `scripts/test-phase267-crash-restart-recovery.ts` — §3 scenarios 1–4, 6–10.
- `scripts/test-phase267-shutdown-reconciliation.ts` — §3 scenario 5 + §4 shutdown invariants.
- `scripts/phase267-verify.ps1` — verification harness.
- `docs/phase267/PHASE267_REPORT.md` — this report.
- `artifacts/phase267/` — evidence directory.

Modified:

- `package.json` — added `test:phase267` and `test:phase267:shutdown` (2 lines).

## Test evidence

Full PostgreSQL-configured run (`NEXUS_PERSISTENCE_MODE=shared`, `DATABASE_URL` set):

| Suite | Exit | PASS | FAIL | BLOCKED | NOT EXECUTED |
|---|---|---|---|---|---|
| `npx tsc --noEmit` | 0 | — | 0 | 0 | 0 |
| `test-phase144-durable-recovery-operations.ts` | 0 | 113 | 0 | 0 | 0 |
| `test-phase198-ownership.ts` | 0 | 28 | 0 | 0 | 0 |
| `test-phase265-recovery-reconciliation-integrity.ts` | 0 | 41 | 0 | 0 | 0 |
| `test-phase266-recovery-reconciliation-concurrency.ts` | 0 | 27 | 0 | 0 | 0 |
| `test-phase267-crash-restart-recovery.ts` | 0 | 36 | 0 | 0 | 0 |
| `test-phase267-shutdown-reconciliation.ts` | 0 | 11 | 0 | 0 | 0 |
| `test-graceful-shutdown.ts` | 0 | — | 0 | 0 | 0 |
| `git diff --check` | 0 | — | 0 | 0 | 0 (CRLF warnings only) |

Phase 267 totals: 47 assertions across the two Phase 267 suites (36 crash/restart + 11 shutdown), 0 fail, 0 blocked, 0 not-executed in the latest PostgreSQL-configured run.

## Backend coverage

**SQLite:** all scenarios 1–4, 6–9 executed with real on-disk DB shared across parent/child. Scenario 5 executed via the shutdown suite.

**PostgreSQL:** scenarios 1c and 10 executed against a real Postgres instance. Scenarios 2, 3, 4, 6, 7, 8, 9 currently run on SQLite only — the child process supports `backend=postgres` but the parent suite only invokes it for scenario 1. This gap is documented, not substituted.

Composite Postgres coverage across Phase 265, 266, 267:
- Recovery reconciliation semantics (retry deadlines, claim-time enforcement, `RECOVERY_REQUIRED` exclusion, limit validation, concurrency): full coverage.
- Cross-process crash for recovery operations: partial (scenarios 1c, 10 only).

## Labeling (Phase 267 §3 requirement)

Every assertion line carries an explicit label:
- `IN-PROCESS FAULT` — deterministic exception via the pre-existing `__testPhase144Hook` (test-only, no-op in production). Not equivalent to a process restart, and never labelled as such.
- `REAL CHILD-PROCESS RESTART` — separate Node process, `SIGKILL` or clean exit; parent inspects persisted state.

## Remaining risks

1. **PG coverage of scenarios 2, 3, 4, 6, 7, 8, 9 is absent.** A defect in the `PgAsyncEngine` claim path that only manifests under cross-process crash would not be caught by Phase 267. Phase 265/266 verify that path for their scenarios but not for full process death.
2. **The shutdown suite is SQLite-only.** A Postgres variant would need `recoveryOpsAsync` in the harness.
3. **Scenario 10 is an in-process fault, not a real Postgres server restart.** A `docker restart` variant (mirroring Phase 244 A18) would be stronger evidence.
4. **No production code changed.** Phase 267 is additive verification only.

## Final repository status

- No commits, no pushes, no `git reset --hard`, no `git clean`.
- Pre-existing modifications preserved.
- Phase 267 files all present, executable, and verified.
- No production-readiness claim is made from these tests alone (Phase 267 §6).
