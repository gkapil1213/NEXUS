# Phase 134: Durable CI Reconciliation Worker Ownership

## Objective

Phase 134 adds durable worker ownership for the CI reconciliation scheduler.

The objective is to ensure that, when multiple NEXUS instances are running, only one active worker owns the CI reconciliation role at a time. Ownership is persisted in the database, renewed through a lease, reclaimed after expiry, and released during graceful shutdown.

Phase 134 builds on the durable CI reconciliation introduced in Phase 132 and the one-shot/backoff scheduler introduced in Phase 133.

## Scope

Phase 134 provides:

- Durable CI reconciliation worker ownership
- Database-level single-active-owner enforcement
- Worker lease acquisition
- Lease renewal and validation
- Lease expiry detection
- Safe ownership takeover/reclaim
- Explicit ownership release
- Crash/restart recovery
- Scheduler ownership gating
- Ownership-loss protection
- Event/audit integration
- Multi-instance safety

The implementation does not repurpose the existing execution/job lease infrastructure.

## Separate Ownership Domain

The existing `execution_leases(job_id)` infrastructure represents ownership of individual execution jobs.

CI reconciliation scheduler ownership is a different concern: it represents ownership of the reconciliation worker role itself.

Phase 134 therefore introduces a dedicated persistence model instead of reusing or modifying `execution_leases(job_id)`.

This keeps execution ownership and scheduler-worker ownership independently enforceable.

## Durable Ownership Persistence

Migration:

`src/db/migrations/151_phase134_reconciliation_worker_ownership.sql`

The migration creates the durable CI reconciliation worker ownership record and enforces a single active owner for the scheduler ownership identity.

The ownership identity is:

`ci-reconciliation-scheduler`

The persistence model records the worker identity, lease identity, state, timestamps, and ownership lifecycle information required for acquisition, renewal, expiry, takeover, inspection, and release.

The migration is designed to be idempotent.

## Worker Identity

Each scheduler process creates one stable worker identity for its lifetime:

`nexus-cicd-scheduler-<uuid>`

The identity is reused by that process for subsequent ownership operations rather than generating a new worker identity for every reconciliation tick.

Lease identities are separately generated for ownership records.

## Ownership Acquisition

The ownership service is implemented in:

`src/core/ci-reconciliation-ownership.service.ts`

The service supports acquisition through `ensureOwned()`.

Before attempting acquisition, expired active ownership can be transitioned out of the active state.

If there is no active owner, the worker attempts to acquire ownership.

Database-level conflict handling prevents two workers from successfully becoming the active owner for the same scheduler ownership identity.

If another active worker still owns the lease, acquisition returns a `held-by-other` result rather than allowing concurrent ownership.

## Ownership Renewal

An existing owner can call `ensureOwned()` repeatedly.

When the persisted worker and lease identity match the local owner, the service performs a conditional renewal of the active lease.

The renewal extends the expiry timestamp only while the ownership record remains active, unexpired, and owned by the same worker/lease combination.

This prevents an old worker from renewing a lease after another worker has legitimately taken ownership.

## Ownership Validation

Ownership is validated against the durable database state rather than relying only on process-local memory.

A conditional database update is used for renewal.

If the conditional update does not affect the expected ownership row, the local worker treats the ownership as lost.

This prevents stale workers from continuing to act as the authoritative reconciliation worker.

## Expiry and Takeover

Active ownership contains an expiration timestamp.

When the lease has expired, a subsequent worker can safely reclaim the ownership.

The expired owner cannot successfully renew after another worker has taken ownership.

The ownership service therefore supports recovery from worker crashes without requiring manual database cleanup.

## Release

The ownership service provides explicit release behavior for graceful shutdown.

A worker releases only the active ownership record matching its own worker and lease identity.

The ownership state is moved out of the active state and the local ownership state is cleared.

Release is idempotent/best-effort for shutdown purposes.

## Scheduler Integration

Phase 134 integrates ownership with:

`src/core/cicd-reconciliation-scheduler.ts`

The scheduler accepts an ownership implementation through its options.

Before a reconciliation tick performs mutation, the scheduler verifies ownership.

If ownership cannot be established, the scheduler:

- does not drain reconciliation work
- reports the ownership failure
- records the skipped tick
- does not perform reconciliation mutation

Manual execution through `tickNow()` is also ownership-gated.

`runNow()` uses the same ownership-enforced execution path.

This prevents a non-owner scheduler instance from bypassing the ownership mechanism through manual invocation.

## Ownership Loss

Ownership is treated as a runtime safety boundary.

If renewal or validation detects that ownership has been lost, the local scheduler stops treating itself as the authoritative reconciliation worker.

The old owner cannot continue reconciliation mutation after another worker has legitimately acquired the ownership lease.

## Crash and Restart Recovery

Ownership is durable rather than process-memory-only.

If a worker process terminates without releasing its ownership, the persisted lease eventually expires.

A replacement worker can then reclaim the ownership through the normal acquisition path.

The implementation also supports a restarted worker reclaiming ownership after the previous ownership lease has expired.

## Graceful Shutdown

The scheduler's shutdown path releases its ownership on a best-effort basis after stopping scheduled activity and waiting for in-flight work according to the scheduler lifecycle.

This reduces unnecessary takeover delay during normal process shutdown.

## Events and Audit

Ownership lifecycle operations emit event/audit information through the available event and audit interfaces.

Relevant lifecycle transitions include acquisition, renewal, renewal failure/loss, and release.

Event/audit failures do not replace the database ownership decision itself.

## Multi-Instance Safety

Multiple NEXUS instances can attempt to operate the CI reconciliation scheduler simultaneously.

The database remains the authoritative coordination point.

Only one active worker can hold the scheduler ownership identity at a time.

A second worker cannot simply overwrite an active owner.

Expired or released ownership can be acquired by another worker.

This provides the foundation required for horizontally deployed reconciliation workers.

## Browser/Server Runtime Boundary

The CI reconciliation, scheduler, ownership, and artifact reconciliation implementations are dynamically imported by the kernel at the server/Node runtime boundary.

The kernel keeps their TypeScript imports type-only where appropriate.

This prevents Node-only dependencies from being pulled into the browser bundle.

The Phase 134 ownership implementation does not require a browser-side `node:crypto` import.

The dynamic import boundary also protects the browser production build from Node-only modules used by the server-side reconciliation stack.

## Relationship to Phase 132

Phase 132 established durable CI completion and authoritative artifact reconciliation.

That phase provides durable CI run state, reconciliation, artifact validation, immutable artifact evidence, and release safety enforcement.

Phase 134 adds worker ownership around the reconciliation process so that those durable reconciliation operations are coordinated safely across multiple worker instances.

## Relationship to Phase 133

Phase 133 established the durable scheduler execution behavior, including:

- one-shot scheduling
- immediate initial scheduling
- exponential backoff
- jitter
- single-flight execution
- graceful stop
- manual `tickNow()`
- prevention of global `setInterval` fallback

Phase 134 adds durable ownership enforcement around that scheduler.

## Verification

Phase 134 verification completed successfully.

### TypeScript

`npm run typecheck`

Result: PASS

### Phase 132 Regression

`npx tsx scripts/test-phase132-ci-reconciliation.ts`

Result:

`34 passed, 0 failed`

### Phase 133 Regression

`npx tsx scripts/test-phase133-scheduler.ts`

Result:

`30 passed, 0 failed`

### Phase 134 Ownership Tests

`npx tsx scripts/test-phase134-durable-ci-ownership.ts`

Result:

`17 passed, 0 failed`

The Phase 134 tests cover schema validation, idempotent migration, acquisition, competing owners, renewal, expiry, takeover, stale-owner blocking, release, reacquisition, and restart recovery.

### Production Build

`npm run build`

Result: PASS

Vite successfully produced the production bundle with the server-only reconciliation modules kept behind the runtime boundary.

## Phase 134 Result

Phase 134 establishes durable ownership for the CI reconciliation worker without repurposing execution/job leases.

The implementation combines database-enforced ownership, lease lifecycle management, scheduler gating, stale-owner protection, restart recovery, graceful release, and server-side runtime isolation.

No Phase 134 completion claim should be interpreted as successful CI/deployment execution when the underlying external provider or runtime is unavailable. Reconciliation remains authoritative and ownership does not fabricate external execution results.
