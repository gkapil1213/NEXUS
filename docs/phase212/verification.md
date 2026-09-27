# Phase 212 - Verification

## Commands

    npx tsc --noEmit --pretty false
    npx tsx scripts/test-phase212-release-recovery.ts
    npx tsx scripts/verify-phase.ts 212
    npx tsx scripts/phase212-evidence.ts

## Scenario coverage

| ID | Scenario | Expected |
|---|---|---|
| 212A | successful deployment reconciliation | RECOVERY_REQUIRED, requires inspection |
| 212B | unknown provider outcome | RECOVERY_REQUIRED |
| 212C | restart after unknown outcome | UNKNOWN durable, RECOVERY_REQUIRED |
| 212D | provider reports deployed | DEPLOYED |
| 212E | provider reports failed | FAILED |
| 212F | provider reports pending | PENDING |
| 212G | provider reports not found | NOT_FOUND |
| 212H | reconciliation idempotency | classifier determinism x3 |
| 212I | concurrent recovery workers | exactly 1 lease winner |
| 212J | recovery lease conflict | second rejected |
| 212K | lease expiration recovery | reacquired after TTL |
| 212L | stale worker fencing | attacker rejected, owner accepted |
| 212M | restart during reconciliation | RECOVERY_REQUIRED persists |
| 212N | restart after deployed before verification | RESUME_VERIFICATION |
| 212O | health verification success | RESUME_VERIFICATION |
| 212P | health verification failure | MARK_FAILED_AND_ROLLBACK |
| 212Q | rollback required | VERIFICATION_FAILED -> ROLLING_BACK |
| 212R | rollback succeeds | ROLLING_BACK -> FAILED (terminal) |
| 212S | rollback failure | ROLLING_BACK -> BLOCKED with reason |
| 212T | restart during rollback | RESUME_ROLLBACK |
| 212U | duplicate rollback prevention | status remains ROLLING_BACK |
| 212V | deployment intent idempotency | same intentKey x3 |
| 212W | artifact identity enforcement | artifactDigest differentiates |
| 212X | commit identity enforcement | commitSha differentiates |
| 212Y | environment identity enforcement | environment differentiates |
| 212Z | authorization enforcement | RECOVERY_REQUIRED not executable |
| 212AA | tampered recovery state | durable state survives fresh service |
| 212AB | illegal state transition | no corruption |
| 212AC | audit/event persistence | updatedAt + createdAt durable |
| 212AD | secret leakage protection | no secret tokens in intent |
| 212AE | deterministic recovery decision | classifier identical x3 |
| 212AF | Phase 211 regression | Phase 210 gate still ALLOWED |
