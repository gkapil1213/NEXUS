# Phase 207 - Concurrency Verification

## Invariants and their mechanisms

| Invariant | Mechanism |
|---|---|
| No duplicate admission | pg_advisory_xact_lock in admitNextJobAsync |
| No duplicate dispatch | status CAS in dispatchAdmittedJobAsync |
| Worker capacity respected | durable counter check in dispatch |
| Lease exclusivity | recoverJobAtomic CAS on lease + status |
| Fencing | Phase 206 stale-attempt fence + lease epoch |
| DAG eligibility | stage-eligibility.ts dependency gate |
| Retry exclusivity | recoverJobAtomic CAS on RETRY_SCHEDULED |
| Terminal protection | recoverStaleJobs skips terminal statuses |

## No-overlap guard

Local to each process. Prevents a slow tick from stacking ticks within the
same kernel instance. Does not provide cross-process coordination; that is
PostgreSQL's responsibility.

## Multi-instance behaviour

DistributedScheduler's own header states: multiple instances in different
processes are safe by construction because all coordination is in PostgreSQL.

## Test coverage

- scripts/test-phase207-production-scheduler.ts asserts the shared-mode gate
  in sqlite mode and the successful start / idempotent start / scheduler
  construct on kernel store in shared mode (207A-207E).
- Stateful concurrency scenarios (207N-207S) require seeded durable jobs and
  a real worker adapter. They report NOT EXECUTED rather than PASS in this
  phase unless the fixture is provisioned.
