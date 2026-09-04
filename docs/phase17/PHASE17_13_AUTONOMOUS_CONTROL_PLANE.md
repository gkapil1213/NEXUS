# Phase 17.13: Autonomous Control-Plane Execution, Closed-Loop Optimization & Governance

## Overview
Phase 17.13 adds controlled execution of Phase 17.12 optimization decisions. It introduces a control decision/action model, autonomy levels, human overrides, budgets, oscillation detection, and a closed-loop control engine. The system executes only supported control-plane actions; external infrastructure operations return CONTROL_PLANE_ONLY or UNSUPPORTED_EXTERNAL_EXECUTION.

## Architecture
- `worker-control-decision.ts` – Decision persistence and status lifecycle.
- `worker-control-action.ts` – Executable action model and store.
- `worker-control-executor.ts` – Executes supported control-plane actions.
- `worker-control-engine.ts` – Core autonomous control engine.
- `worker-control-budget.ts` – Action budget enforcement.
- `worker-control-stability.ts` – Oscillation detection.
- `worker-control-override.ts` – Human override support.
- `worker-safety-gate.ts` – Reused security gate.
- Existing Phase 17.12 policy/optimization/services remain authoritative.

## Decision Lifecycle
PROPOSED → VALIDATING → APPROVED → AUTHORIZED → EXECUTING → SUCCEEDED / FAILED / ROLLED_BACK / BLOCKED / EXPIRED / STALE

## Autonomy Levels
- OBSERVE_ONLY: blocks execution
- RECOMMEND: generate decisions only
- AUTO_LOW_RISK: allows low-risk execution
- AUTO_MEDIUM_RISK: stricter policy
- HUMAN_APPROVAL_REQUIRED: defers execution
- EMERGENCY_STOP: blocks execution

## Safety
Security gates, autonomy levels, overrides, budgets, and stability checks all run before execution. Worker trust/health/credential validation is enforced through `WorkerSafetyGate`.

## Database Migration
`034_phase17_autonomous_control_plane.sql` adds:
- control_decisions
- control_actions
- control_objectives
- control_overrides
- control_budgets
- control_loop_state

## Test Results
- Phase 17.13 Pass 13: `68/68 PASS`

## Environment Limitations
- External infrastructure provisioning is not integrated; SCALE_OUT/SCALE_IN return CONTROL_PLANE_ONLY.
- No live remote worker fleet was connected.
- Human override is represented as control-plane state, not an external UI/API.

## Production Readiness Boundary
Phase 17.13 provides safe, policy-governed control-plane execution. Full infrastructure automation requires real provider integration.
