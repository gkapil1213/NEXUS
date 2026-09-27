# Phase 207 - Production Scheduler

## Components

- src/core/distributed-scheduler.ts - scheduler implementation (unchanged).
- NexusKernel.startDistributedScheduler() - lifecycle owner.
- NexusKernel.stopDistributedScheduler() - shutdown.
- NexusKernel.getDistributedSchedulerStatus() - status snapshot.

## Lifecycle

boot() never starts the scheduler. Server-mode entrypoints opt in,
mirroring startGateway() and startRecoverySupervisor():

    await kernel.boot();
    await kernel.startGateway();
    await kernel.startRecoverySupervisor();
    await kernel.startDistributedScheduler();

Shutdown reverses order via kernel.shutdown({ finalRecoveryPass: true }).
Internally shutdown() stops the scheduler, clears the execution reconcile
timer, stops the CI scheduler, stops the recovery supervisor, then closes
the PostgreSQL pool. No scheduler callback can touch the pool after close.

cleanupOnFailedBoot() follows the same ordering.

## Requirements

- NEXUS_PERSISTENCE_MODE=shared
- DATABASE_URL pointing at a reachable PostgreSQL instance
- ExecutionStore.hasAsyncBackend() === true (kernel attaches PgAsyncEngine
  from the pg-client singleton at boot).

Calling startDistributedScheduler() in sqlite mode throws
SCHEDULER_REQUIRES_SHARED.

## Configuration

| Variable | Default | Effect |
|---|---|---|
| NEXUS_SCHEDULER_INTERVAL_MS | 5000 | Tick interval. Non-positive disables. |
| NEXUS_EXEC_RECONCILE_MS | 30000 | Execution reconcile tick. Non-positive disables. |

These are independent control loops. Do not reuse one for the other.

## No-overlap

Local to each process. distributedSchedulerInFlight is checked at the
start of each interval callback; if the previous tick is still running,
the callback increments distributedSchedulerSkippedTicks and returns.
The flag is cleared in a finally block.

This is an optimization only. Cross-process correctness comes from
PostgreSQL CAS and advisory locks inside ExecutionStore.

## Status snapshot

getDistributedSchedulerStatus() returns:

    {
      wired: boolean,
      running: boolean,
      inFlight: boolean,
      skippedTicks: number,
      lastTickAt: number | null,
      lastResult: SchedulerTickReport | null,
      lastError: string | null
    }

## Failure observability

Tick failures emit scheduler.tick_error on the kernel event bus with
{ error, at }. The message is also recorded in distributedSchedulerLastError
and surfaced through the status snapshot.
