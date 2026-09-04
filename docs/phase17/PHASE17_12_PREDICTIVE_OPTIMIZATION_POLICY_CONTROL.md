# Phase 17.12: Predictive Optimization, Policy Governance & Safe Autonomous Control

## Overview
Phase 17.12 extends Phase 17.11 with deterministic fleet optimization, policy governance, capacity planning, resilience assessment, and a safety gate. It provides control-plane recommendations without bypassing existing security, trust, health, credential, lease, admission, scheduler, or recovery controls.

## Architecture
- `worker-policy.ts` – Fleet policy definition and validation.
- `worker-capacity-planner.ts` – CPU/memory/disk/concurrency capacity planning and deficit calculation.
- `worker-resilience-policy.ts` – Fleet resilience state evaluation.
- `worker-fleet-optimizer.ts` – Deterministic optimization recommendations.
- `worker-safety-gate.ts` – Safety gate for autonomous actions.
- Existing worker trust, health, credential, scheduler, hotspot, telemetry, and audit modules remain authoritative.

## Control-Plane Lifecycle
OBSERVE → FORECAST → RISK → POLICY → OPTIMIZATION → SAFETY GATE → CAPACITY GATE → RECOMMENDATION → AUDIT → TELEMETRY

## Policy Governance
- Policies are validated deterministically.
- Invalid policies fail closed.
- Policy versions can be persisted for audit.
- No external human-approval framework is required in this phase.

## Capacity Planning
- Uses real `worker_fleet_state` and available capacity.
- Calculates CPU, memory, disk, and concurrency deficits.
- Workers that are draining or maintenance are not counted as available.

## Optimization
- Detects hotspots and recommends rebalancing.
- Critical resilience blocks optimization.
- High queue/load recommends scale-out.
- Low utilization recommends scale-in.
- Always returns explainable evidence.

## Safety Gate
- Validates worker trust, health, credential, and remote status.
- Returns ALLOW, DENY, DEFER, or REQUIRE_REVIEW.
- Security always overrides optimization.

## Database Migration
`033_phase17_predictive_optimization_policy.sql` adds:
- `worker_policy_versions`
- `worker_optimization_decisions`
- `worker_capacity_forecasts`
- `worker_resilience_states`
- `worker_control_actions`

## Test Results
- Phase 17.12 tests: 37/37 PASS
- Full regression suite expected to pass.

## Environment Limitations
- No live external worker fleet or cloud provider was used.
- Autoscaling recommendations remain control-plane only.
- Resource metrics are configured/persisted, not live-measured.

## Production Readiness Boundary
Phase 17.12 provides deterministic optimization and policy governance. Full production control requires a live worker fleet and real resource metrics.
