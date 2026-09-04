# Phase 15: Remote Execution & Cloud/CI/CD Control Plane

## Overview
Phase 15 extends NEXUS into a remote execution control plane. It adds durable remote worker management, worker authentication, secure job dispatch, CI/CD provider abstractions, and control-plane crash recovery. The implementation builds on the Phase 13 durable execution engine and Phase 14 adapter architecture.

## Architecture
- Remote worker registry and store
- Worker authentication with credential abstraction, nonce/timestamp validation, and revocation
- Remote execution adapter and manager
- Job dispatcher with lease/capability validation
- Control-plane recovery for expired leases and lost workers
- Provider-neutral CI/CD registry and run manager
- GitHub Actions and Jenkins adapter boundaries

## Worker Lifecycle
Workers can be in these states:
- REGISTERING
- ONLINE
- BUSY
- DRAINING
- OFFLINE
- UNHEALTHY
- REVOKED

Workers authenticate, heartbeat, and may be revoked. Lost workers are detected after heartbeat expiration.

## Remote Dispatch Flow
1. Validate worker authentication
2. Verify worker capabilities
3. Acquire/validate lease ownership
4. Dispatch job through remote execution adapter
5. Collect result and evidence

## CI/CD Providers
Provider registry supports:
- github-actions
- jenkins
- remote-worker
- local-process

Actual GitHub/Jenkins execution is not performed in this environment because credentials/network are not available. Adapter boundaries fail safely.

## Database Migration
`021_phase15_remote_control_plane.sql` adds:
- remote_workers
- remote_dispatches
- remote_execution_events
- cicd_providers
- cicd_runs
- cicd_events

## Security
- Worker authentication required
- Replay protection via nonce/timestamp validation
- Lease ownership enforced
- Capability checks before dispatch
- No secrets logged or stored in source
- Provider registry prevents unauthorized execution

## Testing
`scripts/run-phase15-pass1.ts` includes 21 tests covering workers, dispatch, CI/CD providers, security, and regressions.

## Environment Limitations
- GitHub Actions adapter is implemented as a real adapter boundary but not executed live because credentials/network are unavailable.
- Jenkins adapter is implemented as a real adapter boundary but not executed live.
- Remote worker execution is represented by durable dispatch/lease/control-plane recovery tests, not by a live remote agent.

## Production-Readiness Boundary
This phase establishes the control-plane foundations. It is not yet a live multi-cloud orchestrator.
