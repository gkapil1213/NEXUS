# Phase 17.27: Autonomous Production Decision Intelligence & Unified Governance

## Overview
Phase 17.27 adds a unified production decision layer that collects recommendations from existing NEXUS controllers, normalizes them, detects conflicts, evaluates risk/confidence, applies governance, arbitrates objectives, passes a safety gate, authorizes execution, routes to existing controllers, verifies outcomes, and persists decision outcomes. It does not replace existing scaling, release, recovery, capacity, or cost controllers; it coordinates them.

## Architecture
- `worker-decision-context.ts` – Unified decision context.
- `worker-decision-normalizer.ts` – Common recommendation normalization.
- `worker-decision-conflict-detector.ts` – Deterministic conflict detection.
- `worker-decision-risk.ts` – Unified production decision risk.
- `worker-decision-confidence.ts` – Confidence evaluation.
- `worker-decision-arbitrator.ts` – Safety-first action arbitration.
- `worker-decision-governance.ts` – Policy governance.
- `worker-decision-safety-gate.ts` – Final pre-execution safety gate.
- `worker-decision-authorization.ts` – Authorization/epoch validation.
- `worker-decision-executor.ts` – Provider-neutral execution boundary.
- `worker-decision-verification.ts` – Post-action verification.
- `worker-decision-outcome.ts` – Outcome persistence.
- `worker-unified-production-orchestrator.ts` – End-to-end orchestration.

## Database Migration
`048_phase17_unified_production_decision_intelligence.sql` adds:
- unified_decisions
- unified_decision_candidates
- unified_decision_conflicts
- unified_decision_executions
- unified_decision_verifications
- unified_decision_outcomes

## Verification
- Phase 17.27 Pass 27: 75/75 PASS
- Full regression suite expected to pass.

## Infrastructure Limitations
- No live external provider/controller adapter is configured.
- Execution returns UNAVAILABLE when no real execution adapter exists—never fake success.
- Unified decision arbitration is deterministic and safety-first.

## Production Readiness Boundary
Phase 17.27 provides the governed unified decision intelligence layer. Full production use requires real controller adapters and continuous fleet telemetry.
