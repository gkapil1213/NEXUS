# Phase 261 — Test results

## Environment

- Repository: `C:\Users\pc\NEXUS`
- HEAD at time of run: `0d2f4e9` (phase261a).
- Persistence mode: shared (`NEXUS_PERSISTENCE_MODE=shared`).
- Backend: local containerized PostgreSQL at
  `postgres://postgres:postgres@localhost:55432/nexus`.
- Test runner: `tsx`.

## Verification commands

Four commands gate the phase. All four must pass before push.

### `npm run typecheck`

    > typecheck
    > tsc --noEmit

    TYPECHECK_EXIT=0

### `npm run test:phase261`

    11 checks, 0 failed
    PHASE261_EXIT=0

### `npm run test:phase260`

    PASS: 13
    FAIL: 0
    BLOCKED: 0
    NOT EXECUTED: 1
    PHASE260_EXIT=0

The single NOT EXECUTED is `260G` — the phase260 partial-persistence
repair, deliberately deferred. See `docs/phase260/known-limitations.md`
§1 and this repo's `phase260-handoff.md` for how Phase 261 changes the
scope of that deferral.

### `npm run test:phase183a`

    === Phase 183a Summary ===
    Passed: 21
    Failed: 0
    PHASE183A_EXIT=0

## Phase 261 checks — test-to-requirement mapping

Each row names the requirement from the phase261 acceptance brief and
the check that satisfies it.

| ID | Requirement | Check |
|---|---|---|
| `261.boot` | Kernel boots in shared mode with the drainer wired | `engineeringOutboxDrainer` and `executionStore` are non-null after `kernel.boot()` |
| `261A` | Undelivered outbox row is delivered | `drain()` claims at least one row; `delivered_at` is set on the row |
| `261B` | Redelivery is idempotent on `event_id` | Second `drain()` claims zero; exactly one `engineering_run_events` row for that `event_id` |
| `261C` | `deleteEngineeringRunCascade` removes the outbox row | Zero rows remain after the call |

## Phase 261a checks — test-to-defect mapping

Added in `0d2f4e9`. Each row names the defect or requirement the check
covers.

| ID | Requirement | Check | Defect fixed |
|---|---|---|---|
| `261D` | Transient delivery failure then successful retry | First `drain()` → `retried=1`, `delivered=0`, `attempts=1`, `next_attempt_at > t0`. Second `drain()` at `next_attempt_at + 1` → `delivered=1`, `delivered_at` set | none — regression guard |
| `261E` | Retry exhaustion → permanent failure | Five `drain()` calls advance past each backoff; after the 5th, `permanently_failed_at` set, `attempts=5`. 6th `drain()` at t+1e6 → `claimed=0` | none — regression guard |
| `261F` | Concurrent drainers claim at most one row | Two drainer instances, same pending row, `Promise.all([d1.drain(t), d2.drain(t)])` → `r1.claimed + r2.claimed <= 1` | none — claim SQL was already atomic |
| `261G` | Expired claim is recoverable | Row inserted with `claim_expires_at = t0-60_000`, `claimed_by='ghost'`. Fresh drainer at `t0` → `claimed=1`, `delivered=1` | none — claim SQL already handled expiry |
| `261H` | Malformed payload is not delivered | Row with `payload='{invalid json'` → `delivered=0`, `permanently_failed_at` set, `last_error` starts with `MALFORMED_PAYLOAD`, `payload` column byte-identical, zero `engineering_run_events` rows | Defect 2 |
| `261I` | Claim error surfaces | Store's `prepareAsync` throws on the claim UPDATE → `drain()` throws with the underlying `pg_boom_claim` message preserved | Defect 1 |
| `261J` | Fence miss is `lostClaims`, not `delivered` | Monkey-patched `markDelivered` UPDATE rewrites `claimed_by` → `delivered=0`, `lostClaims=1`, `delivered_at IS NULL` | Defect 3 |

## Observed output (verbatim)

From the final verification run before push:

    > test:phase261
    > tsx scripts/test-phase261-outbox-drainer.ts

    [PASS] 261.boot kernel boots in shared mode and wires drainer -- kernel.boot ok; drainer and store present
    [PASS] 261A drain delivers undelivered outbox row -- delivered_at=1791708918416
    [PASS] 261B redelivery is idempotent on event_id -- no duplicate; claimed=0
    [PASS] 261C deleteEngineeringRunCascade removes the outbox row -- cascade removed 1 row
    [PASS] 261D transient failure -> retry succeeds -- retry succeeded after 2 calls
    [PASS] 261E retry exhaustion -> permanently_failed -- terminal after 5 attempts
    [PASS] 261F concurrent drainers claim at most one row total -- r1=1 r2=0
    [PASS] 261G expired claim is recoverable -- expired claim reclaimed
    [PASS] 261H malformed payload is not delivered -- payload preserved; permanently_failed
    [PASS] 261I claim error surfaces (does not become empty success) -- threw: claimBatch failed: pg_boom_claim
    [PASS] 261J fence miss on ack is lostClaims, not delivered -- lostClaims=1

    11 checks, 0 failed
    PHASE261_EXIT=0

## What is NOT EXECUTED

### Cross-process concurrency

Test `261F` exercises two drainer instances inside one Node process.
The claim SQL uses `UPDATE ... WHERE outbox_id IN (SELECT ...) RETURNING`,
which is row-lock-safe under PostgreSQL, so two processes cannot both
win the same row. This behavior has not been exercised by an integration
test that spawns two `tsx` children racing on the same outbox table.

Status: **NOT EXECUTED**. Reason: no two-process harness exists in the
test scripts. Adding one is a separate piece of work.

### Long-running stability

No test runs the drainer against a sustained pending-row backlog for
minutes or hours. Backoff scheduling and lease expiry under load are
asserted only for single-row, time-skipped scenarios (`261D`, `261E`,
`261G`).

Status: **NOT EXECUTED**. Reason: not required by the phase261 scope;
not reproducible in a fast test suite without clock injection.

### Delivery to a crashed destination

The drainer's behavior when `recordStageExecutionEventWithId` succeeds
but `markDelivered` fails (or the process crashes between them) is
reasoned about in `outbox-contract.md` and is the same code path as
`261D`, but is not directly exercised by a test that simulates the crash
between the two operations.

Status: **NOT EXECUTED**. Reason: would require sub-process crash
injection. The behavior is proven by reasoning about the retry path
(leases + idempotence), not by a fault injection test.

## Historical runs during development

For completeness, three runs are of interest:

1. **Before 261a fixes** — three failures:
   - `261H delivered expected 0, got 1`
   - `261I drain() must throw when the claim query fails`
   - `261J delivered should be 0, got 2`

   This is the reproduction that identified the three defects.

2. **After Defect 1 + Defect 2 fixes** — one remaining failure:
   - `261J lostClaims should be 1, got 2`

   Cause: cross-run orphan rows from earlier failed runs that shared the
   `claimed_by='loser'` worker id and remained in the outbox table. Fixed
   by scoping `261J` to a single row (isolation patch, backup retained
   under `_bak/`).

3. **After all three fixes** — 11/11 PASS.

## Test artifacts

- Test file: `scripts/test-phase261-outbox-drainer.ts`
- npm script: `"test:phase261": "tsx scripts/test-phase261-outbox-drainer.ts"`
- Pre-261a backup: `_bak/test-phase261-outbox-drainer.pre-261A.bak`
  (gitignored)
- Pre-261J-isolation backup:
  `_bak/test-phase261-outbox-drainer.pre-261J-isolation.bak`
  (gitignored)

## What "PASS" means here

Every check asserts against live PostgreSQL state via a real `PgClient`.
No mocks are used for the database itself; the only stubs are:

- `runService.recordStageExecutionEventWithId` in `261D` (to inject a
  transient throw).
- A store whose `asyncDb.prepareAsync` throws on the claim UPDATE in
  `261I` (to inject a claim failure).
- A `prepareAsync` wrapper that rewrites `claimed_by` in `261J` (to
  simulate a fence miss).

Every other database operation in every test is real. A `PASS` means the
observed row state matched the asserted row state.

## What is not a substitute for

Phase 261's tests run against a local containerized Postgres. They are
not a substitute for production-environment verification under real
network conditions, concurrent tenants, or sustained load. See the
Phase 260 `test-results.md` for a parallel statement of this
qualification.