# Phase 17.10: Worker Fleet Autoscaling, Backpressure & Admission Control

## Overview
Phase 17.10 extends the existing Phase 17.9 fleet governance with admission control, backpressure, resource-aware capacity enforcement, and autoscaling decision support. It builds directly on the existing worker fleet, capacity, scheduler, trust, health, credential, lease, telemetry, and audit systems.

## Architecture
- `worker-backpressure.ts` – Deterministic backpressure state evaluation from queue depth and fleet utilization.
- `worker-admission.ts` – Admission control engine that decides ADMIT, DEFER, or REJECT based on backpressure, scheduler eligibility, and resource availability.
- `worker-autoscaler.ts` – Autoscaling decision engine producing SCALE_OUT, SCALE_IN, HOLD, BLOCK_SCALE_IN, or COOLDOWN recommendations.
- `worker-fleet.ts` – Extended with healthy worker count and fleet utilization aggregation.
- `worker-capacity.ts` – Extended with CPU/memory/disk reserved capacity aggregation.
- `worker-scheduler.ts` – Extended with CPU, memory, and disk enforcement in scheduling hard filters.

## Admission Lifecycle
1. Evaluate backpressure from queue depth and fleet utilization.
2. For CRITICAL backpressure, only CRITICAL jobs may be admitted; others are deferred.
3. For HIGH backpressure, LOW priority jobs are deferred.
4. Otherwise, attempt scheduling via `WorkerScheduler`.
5. If a worker is selected, decision is ADMIT with reservation and lease (if enabled).
6. If no capacity, decision is DEFER.
7. If all workers are rejected for non-capacity reasons, decision is REJECT.

## Backpressure States
- NORMAL
- ELEVATED
- HIGH
- CRITICAL

Thresholds are configurable and centralized in `BackpressureConfig`.

## Capacity Model
- Concurrency, CPU, memory, and disk reservations are tracked in `worker_capacity_reservations`.
- `WorkerCapacityService` provides reserved-CPU/memory/disk aggregation.
- `WorkerScheduler` enforces `minCpu`, `minMemory`, and `minDisk` before selection.
- Reservations are atomic and idempotent; duplicate reservation attempts fail safely.

## Autoscaling Decisions
The autoscaler returns real control-plane decisions, not infrastructure provisioning actions:
- SCALE_OUT when queue depth or utilization exceeds configured thresholds.
- SCALE_IN when utilization is idle and no queue depth, respecting minimum fleet size.
- HOLD when fleet is stable.
- BLOCK_SCALE_IN/COOLDOWN when safety or cooldown prevents scaling.
- Cooldown and maximum scale-step are enforced.

Actual worker provisioning remains outside Phase 17.10; decisions are persisted and auditable.

## Database Migration
`031_phase17_worker_admission_backpressure.sql` adds:
- `worker_admission_decisions`
- `worker_backpressure_state`
- `worker_scaling_decisions`

## Verification
Phase 17.10 verification harness tests:
- backpressure states
- admission success/defer
- duplicate reservation idempotency
- reservation release
- CPU/memory/disk capacity enforcement
- scale-out recommendation
- scale-in blocked by active job
- cooldown enforcement
- regression placeholders for Phases 11–17.9

All Phase 17.10 deterministic tests pass.

## Environment Limitations
- No live remote worker fleet was connected.
- No actual cloud worker provisioning was performed.
- Autoscaling decisions are control-plane recommendations only, not infrastructure mutations.
- Real resource metrics (CPU/memory/disk) are stored as configured values, not measured from live hosts.

## Production Readiness Boundary
Phase 17.10 provides deterministic admission, backpressure, capacity enforcement, and scaling decision support. Full production autoscaling requires integration with a real cloud/provider worker provisioner.
