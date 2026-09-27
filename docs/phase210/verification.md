# Phase 210 - Verification

## Commands

    npx tsc --noEmit --pretty false
    npx tsx scripts/test-phase210-release-safety.ts
    npx tsx scripts/verify-phase.ts 210
    npx tsx scripts/phase210-evidence.ts

## Scenario coverage

| ID   | Scenario | Expected |
|---|---|---|
| 210A | valid release candidate | ALLOWED |
| 210B | commit mismatch | REJECTED_MISMATCH |
| 210C | evidence digest mismatch | REJECTED_TAMPERED |
| 210D | result digest mismatch | REJECTED_TAMPERED |
| 210E | missing required test | REJECTED_UNVERIFIED |
| 210F | BLOCKED verification | REJECTED_BLOCKED |
| 210G | NOT_EXECUTED verification | REJECTED_NOT_EXECUTED |
| 210H | verification FAIL | REJECTED_FAIL |
| 210I | stale evidence | REJECTED_STALE |
| 210J | artifact mismatch | REJECTED_MISMATCH |
| 210K | duplicate verification results | REJECTED_FAIL |
| 210L | process restart durability | same decision |
| 210M | repeated evaluation | same decision |
| 210N | concurrent evaluation | same decision |
| 210O | repository changed after verification | REJECTED_MISMATCH |
| 210P | evidence replay against another candidate | REJECTED_MISMATCH |
| 210Q | malformed evidence | REJECTED_MISSING |
| 210R | missing evidence | REJECTED_MISSING |
| 210S | valid complete chain | ALLOWED |
| 210T | deterministic gate evaluation | identical output |
