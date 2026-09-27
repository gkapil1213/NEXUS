# Phase 206 Architecture Gap Analysis

Repository baseline: `17f27ef` (nexus-phase205-complete). All findings verified
against the actual code before this phase.

## 1. What currently protects lease ownership?

Three layers, all at the persistence boundary:

- `execution_leases` has a **partial unique index** `idx_execution_leases_active_job`
  on `(job_id) WHERE status='ACTIVE'` (migration 142). At most one active lease
  per job is enforced by the database itself.
- Every worker-facing mutation (`recordAttemptHeartbeatAsOwner`,
  `recordAttemptProgressAsOwner`, `updateAttemptAsOwner`,
  `completeAttemptAndTransitionJob`) predicates on
  `EXISTS(SELECT 1 FROM execution_leases WHERE lease_id=? AND worker_id=?
  AND job_id=? AND status='ACTIVE' AND expires_at > now)`.
- Job-level transition CAS (`recoverJobAtomic`) additionally predicates on
  `current_lease_id = expectedLeaseId`.

## 2. What currently prevents stale workers from mutating jobs?

The `EXISTS(...)` clause on every write. Once the worker's lease is not
ACTIVE / not unexpired / not matching `(lease_id, worker_id, job_id)`, the
UPDATE matches zero rows and the caller sees `WORKER_OWNERSHIP_LOST`.

## 3. Where is the current ownership authority stored?

`execution_leases.status = 'ACTIVE'` + `expires_at > now` on the row keyed by
`lease_id`. The `current_lease_id` column on `execution_jobs` is a cached
projection for job-level CAS, not the authority.

## 4. Are lease IDs globally unique?

Yes. Generated per acquisition via `generateId()` in `execution-store.ts`
(16 random bytes, hex). Collisions are computationally infeasible. The column
is `PRIMARY KEY`.

## 5. Are lease IDs monotonic?

No. They are random UUID-like identifiers, not counters. Correctness does not
require monotonicity — only that a stale worker's token cannot match a fresh
row. UUID uniqueness gives that property directly. This is a deliberate
design choice documented in `execution-store.ts`; the field is referred to
in-code as the fencing token.

## 6. Does an expired lease receive a strictly newer ownership generation?

The `lease_id` changes but is not ordered. What the system guarantees: after
takeover, the new `lease_id` is a **distinct identity that never matches the
old one**. Any predicate keyed on the old lease_id fails. Observable behavior
is equivalent to a monotonic generation for the purposes of rejecting stale
workers.

## 7. Can an old worker result currently reach a state mutation after takeover?

No — provided the caller passes the old `lease_id` and `worker_id`, which is
how all existing code paths behave. The CAS predicates reject it and the
caller receives `WORKER_OWNERSHIP_LOST`. There is no path in the codebase that
lets a stale worker bypass the lease EXISTS check.

## 8. How can existing fencing infrastructure be reused?

`lease_id` **is** the fencing token. The Phase 71 / 73 `fencing_token` /
`fence_epoch` columns belong to the distributed **control plane** (leader
election, multi-region consensus) — they live on `control_plane_*` and
`phase71_*` tables, not `execution_leases`. Reusing them for execution
ownership would create a parallel authority and violate the "no second lease
system" rule. Keep them separate.

## 9. What is the minimum schema/code change required?

**None.**

Every invariant the phase asks for is enforced today:
- single active owner: partial unique index + CAS
- concurrent acquisition safety: partial unique index reject
- renewal refusal after expiry/takeover: `renewLeaseAsOwner` predicate
- stale heartbeat / progress / completion rejection: `EXISTS(lease)` predicate
- retry fencing: attempt CAS on `status='RUNNING'` + attempt_number uniqueness
- terminal fencing: job CAS on `expectedStatus` + `RUNNING`-only attempt updates

Phase 206 therefore delivers:
- this gap analysis, so the model is discoverable
- `scripts/test-phase206-worker-fencing.ts` — 14 scenarios exercising the
  existing primitives against real SQLite persistence with real concurrency
- `docs/phase206/testing.md` + `artifacts/phase206/phase206-evidence.json`

No production code change. No migration. No new ownership table.