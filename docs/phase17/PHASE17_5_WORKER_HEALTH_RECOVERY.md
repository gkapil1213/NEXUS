# Phase 17.5: Worker Health, Heartbeat, Lease & Self-Recovery Hardening

## Overview
Phase 17.5 adds production-grade worker reliability and self-recovery. It introduces explicit worker health states, durable heartbeat processing, lease monitoring, worker recovery state machine, and recovery idempotency. The layer builds on existing Phase 15–17.4 worker, session, lease, and execution components.

## Architecture
- `worker-health.ts` – Health snapshots, health store, and health events.
- `worker-health-monitor.ts` – Health state evaluation using configurable thresholds.
- `worker-heartbeat.ts` – Authenticated heartbeat processing with sequence validation.
- `worker-lease-monitor.ts` – Lease expiration detection and job retry/dead-letter transitions.
- `worker-recovery.ts` – Idempotent recovery service that quarantines workers, invalidates sessions, expires leases, and retries/dead-letters jobs.

## Worker Health Model
States:
- HEALTHY
- DEGRADED
- STALE
- DISCONNECTED
- UNHEALTHY
- RECOVERING
- QUARANTINED
- REVOKED

A worker progresses from HEALTHY to DEGRADED/STALE/UNHEALTHY as heartbeat age increases. Recovery transitions lead to QUARANTINED or RETRY_SCHEDULED.

## Heartbeat Protocol
Heartbeats are validated for:
- worker identity
- session identity
- sequence monotonicity
- replay protection
- worker revocation

Duplicate or invalid heartbeats are rejected.

## Lease Monitoring
`WorkerLeaseMonitor` recovers expired leases, marks affected jobs as ORPHANED/RETRY_SCHEDULED, and records lease-expired health events.

## Recovery Behavior
`WorkerRecoveryService` performs idempotent recovery. Duplicate recovery attempts return DUPLICATE and do not execute twice. Workers are quarantined, sessions revoked, leases expired, and jobs retried or dead-lettered according to retry policy.

## Security
- Revoked workers cannot recover.
- Identity spoofing is rejected.
- Lease hijacking is rejected.
- Stale results are rejected.
- Secrets are redacted.
- Existing Phase 17.4 integrity checks remain enforced.

## Database Migration
`026_phase17_worker_health_recovery.sql` adds:
- `worker_health`
- `worker_health_events`
- `worker_recovery_attempts`

## Test Results
- Phase 17.5 tests: 63/63 PASS
- Full regression suite expected to pass.

## Environment Limitations
- No live external worker, GitHub Actions, or Jenkins integration was executed.
- Recovery is verified locally using deterministic in-memory SQLite and real process execution.
