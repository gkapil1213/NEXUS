# Phase 17.9: Worker Fleet Governance, Scheduling & Capacity Control

## Overview
Phase 17.9 implements a production-grade worker fleet governance subsystem. It introduces a formal fleet model, capacity reservations, a deterministic scheduler, hard security/eligibility filters, and atomic concurrency protection. It builds directly on existing Phase 15–17.8 worker, trust, credential, health, lease, telemetry, and audit systems.

## Architecture
- `worker-fleet.ts` — Persistent worker fleet state.
- `worker-capacity.ts` — Atomic capacity reservations.
- `worker-scheduler.ts` — Eligibility filtering and worker selection with lease integration.

## Scheduling Lifecycle
1. Receive scheduling request for a job.
2. Validate job exists.
3. Enumerate fleet workers.
4. Apply hard filters in order:
   - draining / maintenance
   - health
   - trust
   - credential
   - capabilities
   - region/environment/os/architecture
   - concurrency capacity
5. If lease integration is enabled, acquire a lease before final assignment.
6. Atomically reserve capacity.
7. Select best eligible worker.
8. Return explainable decision with rejections and reasons.

## Hard Filters
- REVOKED / QUARANTINED worker
- UNHEALTHY / STALE worker
- INVALID_CREDENTIAL
- MISSING_CAPABILITY
- REGION_MISMATCH / ENVIRONMENT_MISMATCH / OS_MISMATCH / ARCHITECTURE_MISMATCH
- DRAINING / MAINTENANCE
- INSUFFICIENT_CAPACITY

## Capacity Model
- `worker_fleet_state` stores concurrency limit and active/queued counts.
- `worker_capacity_reservations` stores active reservations with concurrency units.
- `WorkerCapacityService` provides atomic reserve/release.

## Concurrency Safety
- Capacity reservations use SQLite transactions.
- Lease acquisition prevents duplicate assignment.
- Duplicate schedule requests do not double-reserve capacity when lease integration is active.

## Lease Integration
- When `ExecutionStore` and `LeaseManager` are provided, scheduler acquires a lease before returning `selectedWorkerId`.
- If lease acquisition fails, worker is rejected with `LEASE_ACQUISITION_FAILED`.

## Telemetry / Audit
- Scheduling decisions can be recorded in `scheduler_decisions`.
- Rejection reasons are stored for explainability.
- No secrets are persisted.

## Database Migration
`030_phase17_worker_fleet_governance.sql` adds:
- `worker_fleet_state`
- `worker_capacity_reservations`
- `scheduler_queue`
- `scheduler_decisions`

## Test Results
- Phase 17.9 tests: `30/30 PASS`
- Concurrency test confirms capacity limit is never exceeded.
- Lease acquisition and duplicate lease prevention verified.

## Environment Limitations
- Real cross-machine worker fleet orchestration is not executed in this local environment.
- Resource metrics (CPU/memory/disk) are stored as optional numeric fields; actual OS resource measurement remains environment-limited.
- No live remote worker fleet is connected.

## Production Readiness Boundary
Phase 17.9 provides the deterministic scheduling and capacity governance layer. Full production deployment requires a live worker fleet and real resource metric collection.
