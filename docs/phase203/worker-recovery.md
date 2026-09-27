# Phase 203 Worker Recovery

## Attempt durability (203b)

The driver creates an `execution_attempts` row after each successful
`PENDING -> RUNNING` transition, with:
- `job_id = stageExecutionId`
- `attempt_number = 1`
- `status = RUNNING`
- `worker_id`, `lease_id` matching the lease
- `started_at = now`
- heartbeat seeded via `recordAttemptHeartbeatAsOwner`

This is the missing piece that made Phase 197's stall recovery unaware
of stage jobs prior to 203b. Without an attempt row, a crashed worker's
stage would sit RUNNING with an ACTIVE lease and no heartbeat, and
`recoverStalledAttemptsTick` (which scans attempts on `heartbeat_at`)
would never see it.

## Recovery integration

`recoverStalledAttemptsTick` (execution-engine.ts:903) now finds stale
stage attempts the same way it finds stale ordinary-job attempts:
- `listStaleAttempts` filters `execution_attempts` on `heartbeat_at < cutoff`
- `fenceStaleAttempt` performs the CAS on `status='RUNNING'` + lease
- The stage job is transitioned off RUNNING by the fence path

Proven in 203b S3 and 203d S2: seed a RUNNING stage + stale heartbeat +
ACTIVE lease, close, reopen, invoke the tick, verify the stage moves to
ORPHANED and downstream remains blocked.

## Failure finalization

On terminal transition (SUCCEEDED/FAILED), the driver calls
`updateAttemptAsOwner` with the same lease before releasing it. This
ensures the attempt's terminal status is durable while ownership is
still verifiable.

## What is NOT covered

- Retry scheduling — failed stages stay FAILED, downstream is blocked.
  Introducing `RETRY_SCHEDULED` would require coordination with the
  caller's retry policy.
- Postgres-shared-mode recovery for stage jobs — the driver's write
  path is sync-only.