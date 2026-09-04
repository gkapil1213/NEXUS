# Phase 17.14: Autonomous Multi-Worker Coordination, Global Optimization & Control-Plane Resilience

## Overview
Phase 17.14 extends Phase 17.13 with fleet-level coordination, global state observation, workload distribution, migration governance, conflict detection, control epochs, and control-plane health. It builds on existing worker trust, credential, health, lease, capacity, scheduler, optimizer, telemetry, and audit systems.

## Architecture
- `worker-global-state.ts` – Deterministic global fleet snapshot.
- `worker-coordinator.ts` – Coordination plan creation and lifecycle.
- `worker-workload-distributor.ts` – Hotspot-aware workload redistribution recommendations.
- `worker-control-conflict.ts` – Deterministic conflict detection.
- `worker-control-epoch.ts` – Control decision epochs/validity.
- `worker-migration.ts` – Workload migration intent tracking.
- Existing Phase 17.13 control-action/budget/stability/override modules remain authoritative.

## Coordination Lifecycle
OBSERVE → GLOBAL STATE → WORKLOAD MODEL → CANDIDATE ACTIONS → CONFLICT DETECTION → COORDINATION → SAFETY GATE → BUDGET → EXECUTION → VERIFY → AUDIT/TELEMETRY

## Global State
`WorkerGlobalState.capture(now)` returns a deterministic snapshot containing worker counts, active jobs, available concurrency, queue depth, unhealthy/quarantined/revoked/draining/maintenance counts, and observed timestamp.

## Workload Distribution
`WorkerWorkloadDistributor` evaluates fleet hotspots and recommends:
- NO_ACTION when balanced,
- REBALANCE when a hot worker is detected.

## Migration Governance
`WorkerMigration` records migration intent with idempotency. Actual job/worker migration requires external infrastructure and is not faked.

## Conflict Detection
`WorkerControlConflictDetector` deterministically resolves conflicting actions:
- SCALE_IN vs SCALE_OUT → DENY
- SCALE_IN vs MIGRATE → DEFER
- RECOVERY vs SCALE_IN → DEFER
- QUARANTINE vs DISPATCH → DENY
- etc.

## Control Epochs
`WorkerControlEpoch` creates and invalidates epoch identifiers. Stale/expired epochs are rejected.

## Database Migration
`035_phase17_global_coordination_resilience.sql` adds:
- worker_global_state
- worker_coordination_plans
- worker_control_epochs
- worker_control_conflicts
- worker_control_health
- worker_migrations
- worker_control_transactions

## Test Results
- Phase 17.14 Pass 14: 42/42 PASS
- Full regression suite passes.

## Environment Limitations
- No live remote worker fleet or cloud provider integration was used.
- Workload migration is recorded as control-plane intent only; no actual job movement is performed.
- Autoscaling/provisioning recommendations remain control-plane only.
- Failure-domain logic uses persisted worker metadata, not live topology discovery.

## Production Readiness Boundary
Phase 17.14 provides deterministic global coordination and resilience. Full production automation requires real worker fleet and infrastructure provider integration.
