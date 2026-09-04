# Phase 17.2: Secure Worker Transport & Session Layer

## Overview
Phase 17.2 transforms the Phase 16 WorkerTransport abstraction into a real authenticated worker/control-plane communication layer. It introduces durable worker sessions, strongly typed transport messages, replay protection, sequence validation, and a local loopback transport implementation for integration testing.

## Architecture
- Worker session model and durable store (`worker-session.ts`, `worker-session-store.ts`)
- Typed transport message contracts (`worker-transport-messages.ts`)
- Transport security (replay/sequence detection) (`worker-transport-security.ts`)
- Secure loopback transport server/client (`secure-worker-transport.ts`)

## Session Lifecycle
Sessions progress through:
- CREATED
- AUTHENTICATING
- ACTIVE
- IDLE / BUSY
- DRAINING
- EXPIRED / REVOKED / DISCONNECTED

A worker must successfully authenticate before a session becomes ACTIVE. Revoked workers cannot authenticate. Expired sessions reject privileged operations.

## Authentication Flow
1. Connect
2. Authenticate with worker ID and credential
3. Verify worker exists and is not revoked
4. Validate enrollment/session state
5. Create durable ACTIVE session
6. Heartbeats and job/result messages proceed

## Message Protocol
Transport messages include:
- messageId
- type
- sessionId
- workerId
- timestamp
- protocolVersion
- sequence
- correlationId
- payload

Supported message types include AUTH, HEARTBEAT, JOB_OFFER, JOB_ACCEPT, JOB_REJECT, JOB_CANCEL, JOB_RESULT, SESSION_REVOKED, SESSION_EXPIRED, and ERROR.

## Replay & Sequence Protection
- Duplicate message IDs are rejected.
- Sequence numbers must be strictly increasing per session.
- Stale timestamps are rejected via authentication time window.
- Session/worker binding is enforced for all privileged messages.

## Reconnect Strategy
Reconnect is bounded and must create a new authenticated session. Stale sessions are not reused. Exponential backoff with jitter is recommended but not yet implemented in the loopback transport.

## Database Migration
`024_phase17_worker_sessions.sql` extends the existing `worker_sessions` table with:
- status
- protocol_version
- connection_id
- last_seen_at
- last_heartbeat_at
- last_sequence
- authenticated_at
- metadata

No previous migrations were modified.

## Test Results
- Phase 17.2 tests: `34/34 PASS`
- Phase 15 regression: `21/21 PASS`
- Phase 16 regression: `41/41 PASS`
- Phase 17.1 regression: `23/23 PASS`
- TypeScript: PASS
- Production build: PASS
- git diff --check: PASS

## Environment Limitations
- TLS/network transport is not yet implemented; local loopback transport is used for verification.
- Live remote worker/CI/CD integrations remain `SKIPPED_ENVIRONMENT`.
- No real production network deployment was performed.

## Production Readiness Boundary
This phase establishes the secure session and transport foundation. It is not yet a production network protocol implementation.
