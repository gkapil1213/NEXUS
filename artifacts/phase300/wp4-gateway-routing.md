# WP4 — Worker gateway routing

**Classification: PASS — 7/7 gateway-routing regression tests.**

Latest evidence:
`test-results/2026-11-12-phase300-wp4-gateway-routing-7-7-PASS.txt`

Additional committed evidence:
`test-results/2026-11-12-phase300-wp4-7-7-PASS.txt`

## Shared PostgreSQL routing

In shared persistence mode, the JOB_RESULT preflight uses asynchronous
dispatch and result reads. The JOB_RESULT handler uses asynchronous
PostgreSQL-backed persistence. SQLite-only mode retains the synchronous
fallback.

The November 12 test exercises the real gateway message-handling path,
including handler registry routing and result handling.

## Test evidence — 7/7

Script: `scripts/test-phase300-wp4-gateway-routing.ts`

| Case | Verification | Result |
|---|---|---|
| WP4-1 | Successful JOB_RESULT through real gateway persists durably in PostgreSQL | PASS |
| WP4-2 | Wrong worker rejected without writing | PASS |
| WP4-3 | Matching duplicate ACKs without a second row | PASS |
| WP4-4 | Conflicting duplicate rejected; original preserved | PASS |
| WP4-5 | Missing dispatch rejected | PASS |
| WP4-6 | Distinct rejection reasons map to distinct error strings | PASS |
| WP4-7 | SQLite-only fallback routes and ACKs correctly | PASS |

Summary: 7 PASS, 0 FAIL, 0 BLOCKED, 0 NOT EXECUTED.
Exit code: 0. Shared mode was active and DATABASE_URL was configured.

## Scope boundaries and remaining checks

The 7/7 suite specifically verifies JOB_RESULT routing. It does not by
itself establish that every gateway message type or every dispatch read API
uses PostgreSQL in shared mode.

Separate source paths identified during the Phase 300 audit include
JOB_CANCEL dispatch listing, `getDispatchStatus()`, and
`collectDispatchResult()`. Their shared-mode behavior and acceptance scope
must be assessed separately rather than inferred from the JOB_RESULT tests.

JOB_OFFER routing is also not one of the seven cases in this WP4 test.

The previous documentation's statement that JOB_RESULT preflight still
uses synchronous reads is obsolete: the inspected source now uses the
async backend-aware preflight path.

The November 8 WP4 evidence remains historical and is not overwritten.