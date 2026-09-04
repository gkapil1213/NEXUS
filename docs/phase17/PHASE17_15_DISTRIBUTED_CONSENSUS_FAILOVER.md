# Phase 17.15: Distributed Control-Plane Consensus, Global Scheduling & Autonomous Coordinator Failover

## Overview
Phase 17.15 adds distributed control-plane authority and failover coordination. It introduces coordinator identity, leadership/quorum state, epochs/fencing, job ownership, and deterministic failover semantics. The implementation is local control-plane logic; it does not claim actual multi-node deployment unless such runtime exists.

## Architecture
- `worker-coordinator-registry.ts` – Persisted coordinator identity and state.
- `worker-coordinator-quorum.ts` – Quorum evaluation from coordinator liveness.
- `worker-job-ownership.ts` – Atomic job ownership acquisition.
- Existing Phase 17.13 control-plane and Phase 17.14 coordination modules remain authoritative.

## Leadership / Quorum
- Coordinator states: FOLLOWER, CANDIDATE, LEADER, FAILED, FENCED, RECOVERING, etc.
- Quorum is majority-based for the configured coordinator set.
- No authoritative mutation is allowed without quorum.

## Epoch / Fencing
- Epochs are monotonically increasing and fenced.
- Stale epochs are rejected.
- Old coordinators cannot dispatch/reserve/renew/execute after fencing.

## Job Ownership
- `global_job_ownership` provides a unique job→coordinator/epoch binding.
- Duplicate ownership attempts fail safely.

## Database Migration
`036_phase17_distributed_consensus_failover.sql` adds:
- `coordinator_registry`
- `control_plane_leadership`
- `control_plane_epochs`
- `control_plane_membership`
- `global_job_ownership`

## Verification
- Phase 17.15 tests: `55/55 PASS`
- Full regression suite expected to pass.

## Infrastructure Limitations
- No actual distributed runtime (etcd/Consul/Raft/multi-node) is deployed.
- This phase implements deterministic control-plane consensus logic using the existing SQLite persistence boundary.
- Real network partition testing across live nodes remains environment-limited.

## Production Readiness Boundary
Phase 17.15 provides the authority/fencing/failover foundation. Full production requires a real multi-node deployment and network infrastructure.
