# Phase 206 Testing

## Suite

`scripts/test-phase206-worker-fencing.ts` — 14 scenarios against real
SQLite persistence with the real ExecutionStore + LeaseManager.

| ID | Scenario | Assertion |
|----|----------|-----------|
| 206A | single acquisition | `validateLease` returns true |
| 206B | concurrent acquisition | one winner; active lease count = 1 |
| 206C | ownership generation | new `lease_id` differs; old invalid, new valid |
| 206D | renewal | `expires_at` advances on valid renewal |
| 206E | stale renewal | throws after takeover |
| 206F | takeover | active holder is B; A stale |
| 206G | stale heartbeat | `WORKER_OWNERSHIP_LOST` |
| 206H | stale progress | `WORKER_OWNERSHIP_LOST` |
| 206I | stale completion | `WORKER_OWNERSHIP_LOST` |
| 206J | retry fencing | attempt-1 completion after attempt-2 begins is rejected |
| 206K | terminal fencing | heartbeat against terminal stage is rejected |
| 206L | concurrent reconciliation | one terminal, one event, one dispatch |
| 206M | idempotency | repeated cycles leave at most one active lease; double release is a no-op |
| 206N | restart recovery | file-backed DB: A's expired lease stays expired after reopen; B owns current |

## Concurrency methodology

Real concurrency only. Two synchronous `acquireLease` calls in the same
tick; `Promise.all` for concurrent reconciliation. The partial unique index
`idx_execution_leases_active_job` on `(job_id) WHERE status='ACTIVE'`
rejects the second INSERT atomically. Same ExecutionStore + LeaseManager
the production code uses — no fakes.

## Fencing

`lease_id` is the fencing token. Every takeover issues a fresh UUID. Stale
workers keep their old `lease_id`, which fails the
`EXISTS(lease ACTIVE AND unexpired AND matching lease_id + worker_id + job_id)`
predicate in every worker-facing CAS update.

## Takeover

1. `expireLease` sets old row `status='EXPIRED'`.
2. Job's `current_lease_id` cleared.
3. `acquireLease` inserts new ACTIVE row with fresh `lease_id`.
4. All subsequent CAS updates keyed on old lease_id match zero rows.

## Stale-worker

Asserted in 206G/206H/206I/206K: heartbeat, progress, completion all
return `WORKER_OWNERSHIP_LOST` after takeover or terminal state.

## Regression

201a 21, 201b 11, 202a 11, 202b 13, 202c 19, 202d 15, 202e 10, 203a 22,
203b 17, 203c 16, 203d 20, 203e 14, 204 18, 205 22 — all green.

## Known limitations

- No schema change was needed. `lease_id` is a per-acquisition UUID never
  reused; monotonicity is not required for correctness.
- Postgres shared-mode fencing is not exercised at runtime. Async siblings
  exist and share the same WHERE predicate as the sync path.
- Phase 71/73 `fencing_token`/`fence_epoch` columns are for the distributed
  control plane and do not participate in per-execution ownership.