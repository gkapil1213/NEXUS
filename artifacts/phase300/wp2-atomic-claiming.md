# WP2 — Atomic worker claiming

**Classification: PASS — 6/6 integration tests (including cross-process)**

## What was implemented

ExecutionStore.claimNextDispatchForWorkerAsync(workerId) — single-statement
atomic claim:

  UPDATE remote_dispatches SET status = 'DELIVERED', updated_at = ?
  WHERE dispatch_id = (
    SELECT dispatch_id FROM remote_dispatches
    WHERE worker_id = ? AND status = 'DISPATCHED'
    ORDER BY created_at ASC
    FOR UPDATE SKIP LOCKED LIMIT 1
  ) RETURNING *

FOR UPDATE SKIP LOCKED ensures that two concurrent claimers see different
candidate rows: the first locks one, the second skips it and finds the next.
DISPATCHED -> DELIVERED transition matches the sync version.

Caller: handler-registry.ts:jobOfferHandler routes via hasAsyncBackend().

## Test evidence

scripts/test-phase300-wp2-atomic-claiming.ts — 6 cases against an isolated
PostgreSQL database. No production data was touched.

| # | Case | Result |
|---|---|---|
| WP2-1 | Single worker claims a dispatch | PASS |
| WP2-2 | Two in-process workers compete; exactly one wins | PASS |
| WP2-3 | Empty queue returns undefined | PASS |
| WP2-4 | Multiple workers claim multiple dispatches, no duplicates | PASS |
| WP2-5 | **Two independent PROCESSES compete; every dispatch claimed exactly once** | PASS |
| WP2-6 | Claim state durable across fresh store instances | PASS |

**Summary: PASS: 6 / FAIL: 0 / BLOCKED: 0 / NOT EXECUTED: 0.**

Verbatim output: test-results/2026-11-08-phase300-wp2-6-6-PASS.txt.

## Cross-process detail

WP2-5 seeds 20 dispatches for a single worker. It then spawns two
independent Node processes (via child_process.spawn), each of which opens
its own PgClient pool to the isolated DB and calls
claimNextDispatchForWorkerAsync in a loop until the queue empties. The
parent process parses each child's reported claims and asserts:

- The union of both claim lists covers every seeded dispatch.
- No dispatch appears twice in the union.
- The two claim lists have no overlap.

Result: A=11, B=9, unique=20, no overlap.

This satisfies section 3 of the completion directive's requirement:
"Do not classify WP2 as PASS based only on a single-process Promise.all
test." WP2-5 is a genuine cross-process test.

## What is NOT verified

- Database error propagation during claim (an idempotent PostgreSQL
  failure while claiming) is not exercised by the current 6 cases. It is
  a diagnostic case that would require deliberately breaking the
  connection mid-claim. Not in the critical path; can be added if the
  directive's §3 interpretation requires it.
