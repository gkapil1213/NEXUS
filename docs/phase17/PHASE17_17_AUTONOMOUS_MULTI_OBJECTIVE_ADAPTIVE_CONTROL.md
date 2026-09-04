# Phase 17.17: Autonomous Multi-Objective Control, Adaptive Learning & Production Guardrails

## Overview
Phase 17.17 adds a bounded, deterministic adaptive control layer on top of Phases 17.12–17.16. It evaluates multiple operational objectives, scores them deterministically, arbitrates conflicts, learns from real outcomes, and proposes bounded policy adaptations. Every autonomous decision remains governed by safety gates, control budgets, consensus epochs, policy versions, and human overrides.

## Architecture
- `worker-objective-engine.ts` – Objective registration and retrieval.
- `worker-objective-score.ts` – Deterministic multi-objective scoring.
- `worker-objective-arbitrator.ts` – Priority/hard-constraint arbitration.
- `worker-learning-confidence.ts` – Confidence evaluation for adaptation.
- `worker-adaptive-learning.ts` – Outcome ingestion and bounded adaptation proposals.
- `worker-learning-drift.ts` – Drift detection.
- `worker-guardrail.ts` – Production guardrails.
- `worker-blast-radius.ts` – Blast-radius classification.
- `worker-control-rollback.ts` – Idempotent rollback tracking.
- `worker-control-health.ts` – Autonomous control-loop health.
- `worker-adaptation-governance.ts` – Learning freeze governance.

## Control Loop
OBSERVE → SCORE → ARBITRATE → GATE → BUDGET → CONSENSUS → EXECUTE → MEASURE → LEARN → VALIDATE → ROLLBACK IF NECESSARY → AUDIT

## Adaptation Safety
- Learning never modifies source code.
- Adaptation only changes bounded parameters with explicit min/max and max delta.
- Insufficient confidence, stale telemetry, drift, oscillation, or consensus loss freezes adaptation.
- Emergency stop and human override always win.

## Database Migration
`038_phase17_adaptive_multi_objective_control.sql` adds:
- worker_control_objectives
- worker_control_objective_scores
- worker_adaptation_events
- worker_adaptation_parameters
- worker_learning_outcomes
- worker_learning_drift
- worker_control_guardrails
- worker_control_rollbacks
- worker_control_health

## Verification
- Phase 17.17 Pass 17: 72/72 PASS
- Full regression suite expected to pass.

## Infrastructure Limitations
- No live external worker fleet or cloud provider integration is used.
- Adaptive learning is deterministic, bounded, and rule-based—not machine learning.
- Production infrastructure provisioning remains control-plane only.

## Production Readiness Boundary
Phase 17.17 provides deterministic multi-objective adaptive governance. Full production use requires live fleet data and continuous outcome feedback.
