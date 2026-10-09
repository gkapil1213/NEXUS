# Phase 260 — Known limitations

## 1. Partial-persistence repair is deferred (§4C)

### The limitation

The engineering-stage executor composes two durable writes that are
not in a shared transaction (see `transaction-boundaries.md` for the
full analysis):

1. `execution_jobs.status` and `execution_events` — atomic with each
   other inside `recoverJobAtomicAsync`.
2. `engineering_run_events` — written via a fresh `PgClient` connection
   and its own auto-commit transaction, after the first write has
   already committed.

If the process is interrupted, the network drops, or the database
becomes unreachable between (1) and (2), the durable state becomes:

- `execution_jobs.status` = the new status (committed)
- `execution_events` = the corresponding audit row (committed)
- `engineering_run_events` = no corresponding row (missing)

This is exactly the partial-persistence condition the Phase 260
reconciler classifies as `MISSING_RUN_EVENT`. The reconciler **detects**
this. It does **not** repair it.

### Why repair is out of scope

The brief §4C explicitly allows this:

> If a reliable repair cannot be implemented safely with the current
> architecture, explicitly return `BLOCKED` with the missing dependency
> or transaction capability documented. Do not pretend a repair
> occurred.

Two viable repair paths exist. Neither qualifies as a "smallest safe
change" for a single phase.

**Path A — Move the run-event write into the job-transition transaction.**

The `engineering_run_events` INSERT would need to happen inside the same
`engine.transactionAsync` block that performs the `execution_jobs` CAS.
Today, `recoverJobAtomicAsync` lives in `execution-store.ts` and knows
nothing about `engineering_run_events`; the INSERT is owned by
`EngineeringRunService.recordStageExecutionEvent`, which uses a
different connection pool.

Implementing Path A requires:

- Threading a transaction handle from `execution-store` up to the
  executor and back down into `engineering-run-service`.
- Introducing a new API surface (e.g. `recoverJobAtomicAsync(input, { onCommit: fn })`),
  or moving the `engineering_run_events` INSERT into `execution-store`.
- Rewriting the call sites in `markStageJob` and any other writer of
  `engineering_run_events` (there are several: the build, test,
  diagnosis, repair, and security-review executors all call
  `appendEvent` directly).

This is an architectural change to two subsystems with cross-cutting
callers. It would take a full phase of its own with a dedicated
regression suite, not a patch inside a phase about reconciliation.

**Path B — Introduce a transactional outbox.**

Add a new table:

    CREATE TABLE engineering_run_event_outbox (
      outbox_id   TEXT PRIMARY KEY,
      run_id      TEXT NOT NULL,
      stage_id    TEXT,
      event_type  TEXT NOT NULL,
      payload     TEXT,
      created_at  BIGINT NOT NULL,
      drained_at  BIGINT
    );

`markStageJob` writes to the outbox **inside** the same
`recoverJobAtomicAsync` transaction (i.e. the outbox INSERT is added
alongside the `execution_events` INSERT in the store's transaction
block). A separate worker drains the outbox into
`engineering_run_events` on a loop or on demand.

Implementing Path B requires:

- A schema migration (PostgreSQL, `pg-bootstrap.ts`, and matching
  migrations directory entries).
- A drain worker with its own lifecycle, error handling, and retry
  policy.
- A decision about exactly-once semantics: the outbox row has to be
  marked drained atomically with the `engineering_run_events` INSERT,
  or the drain becomes at-least-once and needs idempotency keys.
- A backfill strategy for existing `engineering_run_events` rows.

The brief §4E says: *"Avoid schema changes unless necessary; document
and test any required migration."* The schema change is only "necessary"
if Phase 260 is required to close §4C. The brief §4C's own deferral
clause says it is not. So Path B is correctly deferred.

### What Phase 260 does instead

- Detects the condition via `reconcileEngineeringStage` (returns
  `MISSING_RUN_EVENT` with `jobStatus` and `expectedEventTypes`).
- Does not attempt to repair it.
- Documents the two viable repair paths above so a future phase can
  pick up cleanly.

### Status classification

Per the brief §7, the specific test case 260G (partial-persistence
repair) is registered as **NOT EXECUTED**, with a reason string
documenting the deferral. This is deliberate, not a failure.

## 2. Concurrent reconciliation across processes is unverified

Test 260L exercises three **parallel, in-process** calls to
`reconcileEngineeringStage` and asserts identical findings. The
reconciler is read-only, so multi-process concurrency cannot produce
divergent state, but the specific behavior of two processes running
reconciliation against the same stage simultaneously has not been
executed. This is a testing gap, not a correctness gap — read-only
operations do not race.

## 3. Reconciliation is not scheduled

The reconciler is a pure function. There is no periodic job, no
supervisor loop, and no automatic invocation. Callers must invoke it
explicitly. If a future phase wants reconciliation to run automatically
after every stage execution, that scheduling is a separate design
decision.

## 4. `MISSING_RUN_EVENT` is job-terminal-only

The reconciler only emits `MISSING_RUN_EVENT` when the job is in one of
three terminals: `SUCCEEDED`, `FAILED`, `BLOCKED`. For other terminals
(`CANCELLED`, `DEAD_LETTER`), no expected event type is currently mapped
and the reconciler does not check. This is conservative by design — it
avoids false positives for terminal statuses whose event naming may
differ. If those statuses need reconciliation coverage, the
`EXPECTED_RUN_EVENT_FOR_JOB` map in
`src/core/engineering-stage-reconciler.ts` is the single place to extend.

## 5. Stage/job compatibility table is heuristic

The compatibility table (`COMPATIBLE_STAGE_FOR_JOB`) maps a terminal
job status to a set of acceptable `capability_status` values. It is
derived from reading the executor's current behavior, not from a
formal specification. If a future change makes a previously incompatible
combination legitimate, this table needs updating. It is the single
source of truth for reconciliation's `TERMINAL_CONFLICT` detection and
is easy to audit.

## 6. No external-tooling verification

The reconciler uses only `ExecutionStore.getJobAsync` and
`EngineeringRunService.getEngineeringRunStages` /
`.getEngineeringRunEvents`. It does not open a direct `PgClient` and
does not run raw SQL. This is intentional (keeps the reconciler within
the existing service boundaries) but means it inherits whatever
connection behavior those services have — including any transient
connection issues during reconciliation, which will surface as
`UNREADABLE` findings rather than being retried internally.

## 7. Retry policy is not part of the contract

`reconcileEngineeringStage` does not retry. If a caller receives an
`UNREADABLE` finding, it is the caller's responsibility to decide
whether to retry, when, and how many times. The reconciler itself is
stateless and has no retry configuration.

## 8. Not production-grade verification

The Phase 260 tests run against a local containerized Postgres. They
are not a substitute for production-environment verification. See
`test-results.md` for the specific distinction.