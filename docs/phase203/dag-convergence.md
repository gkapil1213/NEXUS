# Phase 203 DAG Convergence

## Topological dispatch

`runStageGraphToCompletion` loads the canonical dependency edges via
`store.stageDeps.listGraph(executionId)`, builds a `DependencyGraph`,
rejects cycles via `detectCycle`, and orders stages via
`orderDependencies` (DFS post-order).

The order is stable regardless of the order in which stages were
declared (203a S3).

## Within-tick vs. across-worker concurrency

Within a single driver invocation, stages are dispatched sequentially
in topological order. Independent branches (e.g. B and C in a diamond)
are not executed in parallel by one invocation.

Concurrent branch execution is achieved by running multiple driver
invocations with distinct `workerId`s. The lease CAS serializes the
race — one worker wins, the other sees `LEASE_UNAVAILABLE` and skips.
Proven in:
- 203a S7 (single contested stage)
- 203c S5 (diamond, two workers)
- 203e S1 (fan-out, 5 workers racing over 21 stages)

## Convergence

The driver tracks three outcomes: `dispatched`, `failed`, `blocked`.
A tick makes progress if any stage transitions. If no progress is
possible and every stage is terminal, `converged = true`. If no
progress is possible and some stages are blocked, the driver returns
with `blocked` populated and `converged = false`.

Downstream stages become eligible automatically once their
prerequisites reach SUCCEEDED — no manual eligibility forcing is used
anywhere (203a S1/S2/S3, 203c S1–S6).

## Failure propagation

- Terminal dependency failure (FAILED / DEAD_LETTER / CANCELLED / SKIPPED)
  blocks downstream with `DEPENDENCY_TERMINAL_FAILURE`.
- In-flight dependency blocks with `DEPENDENCY_IN_FLIGHT`.
- Retry-pending dependency blocks with `DEPENDENCY_RETRY_PENDING` (from
  202b; the driver itself never schedules a retry).

Proven in 203a S4, 203c S6.