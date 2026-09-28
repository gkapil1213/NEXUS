# Phase 214 - Capability Registry

The registry answers: 'Can NEXUS execute this engineering stage in the
current runtime?' It is deliberately honest.

## Statuses

- AVAILABLE       - a real executor is wired and verified
- UNAVAILABLE     - infrastructure exists but no executor for this stage
- NOT_IMPLEMENTED - no executor and no plan to wire one in this phase

## Current verdicts (this phase)

| Stage | Status | Reason |
|---|---|---|
| PLANNING | NOT_IMPLEMENTED | no executor wired |
| ARCHITECTURE | NOT_IMPLEMENTED | no executor wired |
| IMPLEMENTATION | NOT_IMPLEMENTED | no executor wired |
| BUILD | UNAVAILABLE | no canonical build executor |
| TEST | UNAVAILABLE | no canonical test executor |
| DIAGNOSIS | NOT_IMPLEMENTED | no executor wired |
| REPAIR | NOT_IMPLEMENTED | no executor wired |
| SECURITY_REVIEW | NOT_IMPLEMENTED | SecurityApi exists but no per-run executor |
| RELEASE_READY | NOT_IMPLEMENTED | release path exists (211/212) but not driven from runs |

## Rule

The registry never returns AVAILABLE for a stage whose real executor is not
wired. A probe can only downgrade, never upgrade. 214I asserts this.
