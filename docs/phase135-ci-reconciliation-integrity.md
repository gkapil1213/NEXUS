# Phase 135 — CI reconciliation integrity

## Objective

Harden Phase 132 + 133 + 134 so a worker that has lost durable reconciliation
ownership cannot perform any authoritative mutation — even when it has an
external provider request already in flight and the response arrives after
ownership has moved.

## 1. The stale-worker race

Before Phase 135 the ownership check lived only at the scheduler tick boundary
(CicdReconciliationScheduler.tickNow -> ownership.ensureOwned). Once
drain.reconcileOpen() was called, nothing re-verified ownership.

A worker A could therefore:

1. pass the scheduler gate,
2. call the provider (pollRun, listArtifacts, downloadArtifact) — long awaits,
3. lose its lease during that await — either by TTL expiry or by B's
   ensureOwned taking over the row,
4. resume after the delayed response and unconditionally UPDATE the
   reconciliation row, register an artifact, and insert a
   ci_image_digest_bindings row.

## 2. The durable ownership fence

Every authoritative mutation now carries a SQL fence against the Phase 134
ownership row:

    UPDATE <table> SET ... WHERE <row identity>
    AND EXISTS (
      SELECT 1 FROM ci_reconciliation_worker_ownership
      WHERE ownership_id = ?
        AND worker_id    = ?
        AND lease_id     = ?
        AND state        = 'ACTIVE'
        AND expires_at   >  ?
    )

When the fence does not match, changes === 0. The reconciler treats this as a
fencing outcome — not a CI failure. ReconcileOnceResult.fenced is set, a
ci.reconciliation.fenced event is emitted, and no BLOCKED write occurs, no
CI_TERMINAL_* reason is fabricated, and no REGISTERED transition happens.

The fence is validated against the durable row, not local memory. A stale
worker still holding a localLeaseId in memory cannot write.

## 3. Where the fence is enforced

- CicdReconciliationService.reconcileOnce: attempts bump, ARTIFACT_VALIDATING,
  REGISTERED.
- CicdReconciliationService.block: state=BLOCKED write.
- CicdReconciliationService.retry: last_error / attempts write.
- CiArtifactReconciliationService.reconcile: ArtifactService.register (via
  canWrite), INSERT ci_image_digest_bindings.

ArtifactService.register gained an optional synchronous canWrite hook. It is
called immediately before engine.put("artifacts", ...); a false return throws
ArtifactRegistrationFencedError. Callers that omit canWrite (every non-CI
caller) behave exactly as before.

## 4. What the test proves

scripts/test-phase135-ci-reconciliation-integrity.ts runs two deterministic
scenarios against the real services and real SQLite (migrations 150 + 151):

- Primary race (T01-T08, T11, T12) — A's pollRun is held on a controllable
  promise. While A waits, the clock advances past A's TTL and B acquires
  ownership. When A's response is released with status SUCCEEDED, A's
  ARTIFACT_VALIDATING write is fenced (changes === 0), the durable row stays
  PENDING, no artifact is registered, no binding is created, and A's result
  carries fenced: true with no blockedReason.

- Artifact-layer race (T09, T10) — A's downloadArtifact is held on a
  controllable promise. B takes over while A waits. When the artifact bytes
  are released, isOwnedNowSync() returns false and the artifact reconciler
  returns SKIPPED_NO_OWNERSHIP; the artifact service is never called and no
  binding row is inserted.

- Subsequent authoritative reconciliation (T13-T15) — B, holding a valid
  fence, reconciles the same run to REGISTERED, registering exactly one
  artifact and exactly one binding. A second pass by B is idempotent:
  countBindings remains 1 and artsB.records.length remains 1.

## 5. Why scheduler-only ownership is insufficient

The scheduler gate guarantees "at most one process enters a tick", not "the
process that is currently inside a tick still owns the lease". Any await
(provider REST call, artifact download, database transaction) is a window in
which ownership can move. The fence closes that window by re-validating the
durable row at the moment of mutation.

## 6. Known limitations

- The EXISTS subquery and the row write are two logical operations. SQLite's
  planner inlines the shape used here, but there is a theoretical nanoseconds
  window between the subquery evaluation and the write. Fully closing it
  would require a per-row fencing token or a wrapping transaction — neither
  is in Phase 135's scope.
- ArtifactService.register writes an artifacts row before the binding insert.
  In the narrow window where two workers both pass findBinding -> undefined,
  one artifacts row may be orphaned. The DB UNIQUE (execution_id, run_id,
  image_digest) prevents a second binding row, so the orphan is unreferenced
  and inert. Eliminating it entirely would require an idempotency key on
  register.
- No migration was added: migration 150 already carries the two UNIQUE
  constraints that matter for idempotency, and migration 151 carries the
  partial unique index on the ownership row.

## 7. Verification

    npm run typecheck
    npx tsx scripts/test-phase132-ci-reconciliation.ts
    npx tsx scripts/test-phase133-scheduler.ts
    npx tsx scripts/test-phase134-durable-ci-ownership.ts
    npx tsx scripts/test-phase135-ci-reconciliation-integrity.ts
    npm run build
    git diff --check