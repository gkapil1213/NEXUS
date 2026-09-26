# Phase 202 Testing

## Slices and coverage

| Slice | File | Backend | Assertions |
|-------|------|---------|------------|
| 202a | `scripts/test-phase202-durable-admission.ts` | SQLite | 11 |
| 202b | `scripts/test-phase202b-retry-eligibility.ts` | SQLite | 13 |
| 202c | `scripts/test-phase202c-concurrency.ts` | SQLite + Postgres | 19 |
| 202d | `scripts/test-phase202d-shared-admission.ts` | Postgres | 15 |
| 202e | `scripts/test-phase202e-admission-stress.ts` | SQLite | 8 (2 stress timing) |

## Regression

Phase 197, 198, 199, 200, 201a, 201b, 202a, 202b, 202c, 202d must all remain green.

## Evidence

`scripts/phase202-evidence.ts` runs each test, parses PASS/FAIL/BLOCKED counts,
and writes `artifacts/phase202/phase202-evidence.json`.

## What is NOT tested

- Multi-process concurrent admission on PostgreSQL (only in-process promise
  race via `acquireLeaseAsync`).
- Distributed DAG execution across multiple orchestrators.
- Long-running admission under sustained load (>10k evaluations).
  These are documented as known limitations rather than fabricated PASSes.