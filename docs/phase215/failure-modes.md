# Phase 215 - Failure Modes

| Condition | Status | Reason |
|---|---|---|
| No planning provider | BLOCKED | PROVIDER_NOT_CONFIGURED |
| No architecture provider | BLOCKED | PROVIDER_NOT_CONFIGURED |
| Provider ok:false | FAILED | provider reason |
| Provider throws | FAILED | exception |
| Plan validation fails | INVALID | validation errors |
| Architecture validation fails | INVALID | validation errors |
| Plan not VALID for architecture | INVALID | PLAN_NOT_VALID |
| Content hash mismatch | INVALID | CONTENT_HASH_MISMATCH |
| Duplicate concurrent submission | idempotent | one winner |

Never fabricated: stage record existence != execution success; provider-ok:true
alone != authoritative success; VALID requires parse + schema + semantic +
content hash + durable persistence.
