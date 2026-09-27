# Phase 203 Testing

## Suites

| Slice | File | Coverage | Assertions |
|-------|------|----------|------------|
| 203a | test-phase203a-stage-dispatch.ts | dispatch, topological order, failure, cancel, idempotency, worker race | 22 |
| 203b | test-phase203b-worker-failure.ts | attempt durability, stall recovery, downstream blocking | 17 |
| 203c | test-phase203c-dag-convergence.ts | deeper chains, fan-out, two-level diamond, concurrent workers | 16 |
| 203d | test-phase203d-restart-durability.ts | file-backed DB restart, mid-flight crash, partial-progress resume | 20 |
| 203e | test-phase203e-concurrency-stress.ts | 5-worker fan-out, 50-stage chain, repeated no-op dispatch | 14 |

Total 89 assertions across Phase 203.

## Regression (unchanged)

Phase 201a (21), 201b (11), 202a (11), 202b (13), 202c (19),
202d (15), 202e (10). No regression.

## Evidence

`scripts/phase203-evidence.ts` runs each 203 suite and writes
`artifacts/phase203/phase203-evidence.json` with commit hash and
per-suite PASS/FAIL/BLOCKED counts.

## Known limitations

- No retry scheduling test — the driver does not schedule retries;
  retry support is documented as future work.
- No Postgres driver restart test — the driver is sync-only today.