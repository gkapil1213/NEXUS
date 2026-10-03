# Phase 238 Design — Durable Fair Active-Health Checkpoint (generation-CAS)

## 1. Problem
Phase 237 gave eventual fairness with an in-memory keyset cursor. A restart
reset the cycle. Phase 238 makes the cursor durable and safe under persistence
failure and concurrent writers.

## 2. Architecture preserved
ReleaseRecoverySupervisor sole lifecycle owner. observeActiveHealth sole
observation owner. ReleaseRecoveryExecutor sole recovery engine. Keyset
ordering and per-tick cap unchanged.

## 3. Persistence
Coordination table via pg-bootstrap.ts (idempotent under advisory lock):
  active_health_checkpoints (scope_key PK, cursor TEXT NULL,
    generation BIGINT NOT NULL DEFAULT 0, updated_at BIGINT NOT NULL)
Upgrade path: ALTER TABLE ADD COLUMN IF NOT EXISTS generation ...

## 4. Scope key
release-recovery-supervisor/<activeHealthEnvironmentFilter ?? "__global__">

## 5. CAS
expectedGeneration < 0 -> INSERT ON CONFLICT DO NOTHING
expectedGeneration >= 0 -> UPDATE SET cursor=?, generation=generation+1 WHERE
  scope_key=? AND generation=?
Returns true only when a row was affected.

## 6. Crash safety
Per tick: load -> query cap+1 -> observe -> compute nextCursor -> CAS persist.
Local cursor advanced ONLY on CAS success. Crash before CAS repeats work,
never skips.

## 7. Wrap
Exhausted set writes cursor=NULL. Stale pre-wrap writer rejected (238Y).

## 8. Concurrency
In-flight guard within supervisor. Across supervisors: CAS generation (238AA
exactly one winner). Existing activation lease/CAS unchanged.

## 9. Failure
Persistence failure: checkpointPersisted=false, checkpointConflict=true,
local cursor not advanced; next tick reloads durable state (238K, 238L).

## 10. Authoritative state separation
Checkpoint is coordination/scheduling state only. Authoritative state remains
in release_deployment_intents.

## 11. Test results (actual)
Phase 238: 60/0/0/0
Phase 237: 23/0/0/0
Phase 236: 25/0/1/0
Phase 235: 35/0/1/0
npx tsc --noEmit: exit 0

## 12. External blockers
AWS_REGION_NOT_CONFIGURED remains BLOCKED.
