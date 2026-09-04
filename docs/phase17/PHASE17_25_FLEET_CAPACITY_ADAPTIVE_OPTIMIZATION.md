# Phase 17.25: Autonomous Fleet Capacity Optimization & Adaptive Scaling Control

## Overview
Phase 17.25 adds deterministic capacity intelligence, demand forecasting, capacity gap analysis, risk-aware scaling strategy, safety-gated scaling execution, stability/oscillation protection, and scaling outcome analysis. It extends the Phase 17.24 closed-loop fleet control architecture and remains bounded by existing NEXUS reliability, SLO, governance, and safety systems.

## Architecture
- `worker-capacity-intelligence.ts` – Capacity state classification.
- `worker-capacity-forecast.ts` – Deterministic workload forecast.
- `worker-capacity-gap.ts` – Capacity gap/headroom calculation.
- `worker-scaling-strategy.ts` – Risk/state-aware scaling strategy.
- `worker-scaling-risk.ts` – Scaling risk evaluation.
- `worker-scaling-safety-gate.ts` – Pre-scaling safety decisions.
- `worker-scaling-plan.ts` – Immutable scaling plan persistence.
- `worker-scaling-executor.ts` – Provider-neutral execution boundary.
- `worker-scaling-stability.ts` – Oscillation/thrashing suppression.
- `worker-scaling-outcome.ts` – Post-scaling effectiveness classification.
- `worker-scaling-rollback.ts` – Rollback eligibility.
- `worker-capacity-optimizer.ts` – Closed-loop orchestration.
- `worker-capacity-cost.ts` – Cost-aware capacity efficiency.

## Key Decisions
- Capacity state: UNDER_CAPACITY, HEALTHY, NEAR_SATURATION, SATURATED, OVER_CAPACITY, UNKNOWN.
- Forecast trend: STABLE, INCREASING, DECREASING, VOLATILE, UNKNOWN.
- Scaling strategy: NO_ACTION, SCALE_UP, SCALE_DOWN, HOLD, DEFER.
- Safety gate returns ALLOW/DENY/DEFER/OBSERVE_ONLY.
- Executor returns EXECUTION_UNAVAILABLE when no real infrastructure adapter exists—never fake success.
- Scaling stability detects oscillation/thrashing and defers autonomous action.

## Database Migration
`046_phase17_fleet_capacity_adaptive_optimization.sql` adds:
- capacity_observations
- capacity_forecasts
- scaling_plans
- scaling_decisions
- scaling_outcomes

## Verification
- Phase 17.25 Pass 25: 73/73 PASS
- Full regression suite expected to pass.

## Infrastructure Limitations
- No live external infrastructure/provider adapter is configured.
- Scaling execution returns EXECUTION_UNAVAILABLE, not simulated success.
- Fleet capacity optimization is control-plane only.

## Production Readiness Boundary
Phase 17.25 provides the deterministic capacity optimization and adaptive scaling governance layer. Full production use requires real infrastructure adapters and continuous fleet telemetry.
