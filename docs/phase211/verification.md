# Phase 211 - Verification

## Commands

    npx tsc --noEmit --pretty false
    npx tsx scripts/test-phase211-release-execution.ts
    npx tsx scripts/verify-phase.ts 211
    npx tsx scripts/phase211-evidence.ts

## Scenario coverage

| ID    | Scenario | Expected |
|---|---|---|
| 211A  | valid authorized execution path | EXECUTED, verdict ALLOWED |
| 211B  | missing Phase 210 authorization | REJECTED_MISSING |
| 211C  | authorization mismatch | REJECTED_MISMATCH |
| 211D  | source commit mismatch | REJECTED_MISMATCH |
| 211E  | artifact mismatch | REJECTED_MISMATCH |
| 211F  | duplicate idempotency request | same intentKey, no duplicate |
| 211G  | concurrent duplicate execution | exactly 1 EXECUTED |
| 211H  | lease acquisition conflict | second rejected |
| 211I  | lease expiration recovery | reacquired after TTL |
| 211J  | worker/process restart recovery | durable intent survives |
| 211K  | heartbeat timeout | renewal after expiry rejected |
| 211L  | unknown external deployment outcome | NOT_EXECUTED / provider UNKNOWN |
| 211M  | provider status reconciliation | reconcile() invoked |
| 211N  | deployment failure | BLOCKED / provider NOT_DEPLOYED |
| 211O  | successful rollback | FAILED -> ROLLING_BACK -> KNOWN_GOOD |
| 211P  | rollback failure | ROLLING_BACK -> FAILED with reason |
| 211Q  | health verification failure | HEALTH_CHECKING -> VERIFICATION_FAILED |
| 211R  | health verification unavailable | HEALTH_CHECKING -> BLOCKED |
| 211S  | illegal state transition | terminal status preserved |
| 211T  | unauthorized cancellation | non-owner transition rejected |
| 211U  | cancellation after execution | terminal KNOWN_GOOD preserved |
| 211V  | retryable infrastructure failure | RECOVERY_REQUIRED in recoverable list |
| 211W  | non-retryable authorization failure | no intent created |
| 211X  | replay attempt | first EXECUTED, second BLOCKED |
| 211Y  | tampered execution record/event | durable state survives fresh service |
| 211Z  | concurrent workers | 1 of 3 executed |
| 211AA | restart after deployment request | DEPLOYING persisted + recoverable |
| 211AB | duplicate rollback request | status remains ROLLING_BACK |
| 211AC | audit/event persistence | status + updatedAt durable |
| 211AD | secret leakage protection | no secret tokens in intent |
| 211AE | deterministic execution decision | identical outputs |
| 211AF | Phase 210 regression | Phase 210 gate still ALLOWED |
