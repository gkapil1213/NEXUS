# Phase 13: Durable Execution, Worker Runtime, and Deployment Safety

## Overview
Phase 13 extends NEXUS with a durable execution substrate. It provides persistent jobs, attempts, workers, leases, retries, artifacts, releases, deployments, approval gates, and rollback.

## Architecture
- execution-models.ts - Core types for all execution entities.
- execution-store.ts - SQLite persistence layer.
- execution-state-machine.ts - Validated state transitions.
- execution-engine.ts - Central execution orchestrator with timeout, cancellation, and crash recovery.
- worker-registry.ts - Worker registration, heartbeats, and status.
- lease-manager.ts - Lease acquisition, renewal, expiration, and recovery.
- retry-engine.ts - Policy-based retry and backoff.
- artifact-store.ts - Artifact registration and checksum verification.
- release-manager.ts - Release lifecycle.
- deployment-gates.ts - Deployment safety gates.
- deployment-verifier.ts - Deployment verification interface.
- deployment-manager.ts - Deployment orchestration.
- rollback-manager.ts - Rollback execution and verification.
- approval-gate.ts - Human approval decision gate.

## Database Migration
src/db/migrations/020_phase13_execution.sql adds execution tables and indexes. All changes are additive.

## Testing
npx tsx scripts/run-phase13-pass1.ts

## Security
- SQL parameterization
- Idempotency keys
- Worker-lease ownership validation
- No arbitrary command execution

## Limitations
- Execution and deployment functions are in-memory test doubles; real external adapters are future work.
- Observability integration is not yet fully wired.
