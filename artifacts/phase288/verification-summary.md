# Phase 288 — Verification Summary

**Status**: PASS for defined scope, with 2 documented design gaps.

Starting commit: `2c6e083` — `test(phase286): verify real gateway handler validation`
Branch: `checkpoint/redaction-phases-273-285`

## Baseline (recorded before Phase 288 changes)

| Command | Exit | Assertions |
|---|---|---|
| `npx tsx .\scripts\test-phase286-worker-gateway-real-handler.ts` | 0 | 22 PASS |
| `npm run test:phase286` | 0 | 42 PASS |
| `npx tsx .\scripts\run-worker-gateway-agent-e2e.ts` | 0 | 19 PASS |
| `npm run typecheck` | 0 | — |

Baseline total: 83 assertions, all green.

## Production changes

1. **Credential storage** (`sqlite-worker-auth-store.ts`, `worker-auth-store.ts`, `worker-authentication.ts`)
   - PBKDF2-SHA256 (100,000 iterations, 16-byte salt, 32-byte output) via Node `pbkdf2Sync`.
   - Additive schema migration (`ALTER TABLE ADD COLUMN` for `algorithm`, `salt`, `iterations`).
   - Legacy polynomial-hash rows verify-only; upgraded in place on first successful authentication.
   - In-memory test store also PBKDF2 for parity.

2. **Mandatory AUTH_REQUEST envelope** (`worker-authentication.ts`, `worker-gateway.ts`, `worker-gateway-client`)
   - Required: `workerId`, `credential`, `nonce` (16–128 chars, `[A-Za-z0-9_-]`), `timestamp` (finite, within 5-minute window).
   - Stable reasons: `missing_timestamp`, `expired_timestamp`, `future_timestamp`, `missing_nonce`, `invalid_nonce`, `replayed_nonce`, `nonce_store_unavailable`, `secure_random_unavailable`.
   - Durable nonce store: `worker_auth_nonces` table with `PRIMARY KEY (worker_id, nonce)`. Concurrent duplicates fail at the unique constraint.
   - Session tokens generated only from `crypto.getRandomValues` (fails closed — no `Math.random()` fallback).
   - Client (`WorkerGatewayClient.authenticate`) sends a fresh nonce per attempt.

3. **Durable messageId dedup** (`worker-transport-security.ts`, `worker-gateway.ts`)
   - `WorkerTransportSecurity` now takes an optional `NexusEngine`. When present, `worker_message_ids` table is the source of truth for `duplicate_message` detection.
   - `WorkerGateway` accepts an optional `engine` (6th constructor param) and constructs the security layer with it.
   - Durable across gateway restart.

4. **Error-code regex widening** (`worker-gateway.ts`)
   - `isStableCode` changed from `^[a-z][a-z0-9_]+$` to `^[a-zA-Z][a-zA-Z0-9_]{0,63}$`.
   - Fixes silent collapse of camelCase codes (`jobId_required`, `workerId_required`, `attemptId_required`, `leaseId_required`, `idempotencyKey_required`) to `gateway_error`.

5. **Engine pass-through in test/caller setup**
   - `kernel.ts`, `test-phase286-worker-gateway-real-handler.ts`, `run-worker-gateway-agent-e2e.ts`, `run-worker-gateway-integration.ts`, `run-worker-gateway-remote-adapter-e2e.ts`, `run-durable-gateway-tests.ts`: construct `WorkerAuthentication` and `WorkerGateway` with the engine so nonce and message-id stores are durable.
   - `test-phase286-worker-gateway-real-handler.ts` AUTH_REQUEST body includes `timestamp` (message level) and `nonce` (payload).

## Post-change regression gate

| Command | Exit | Assertions |
|---|---|---|
| `npx tsx .\scripts\test-phase286-worker-gateway-real-handler.ts` | 0 | 22 PASS |
| `npm run test:phase286` | 0 | 42 PASS |
| `npx tsx .\scripts\run-worker-gateway-agent-e2e.ts` | 0 | 19 PASS |
| `npx tsx .\scripts\run-durable-gateway-tests.ts` | 0 | 14 PASS |
| `npx tsx .\scripts\run-worker-gateway-integration.ts` | 0 | 5 PASS |
| `npx tsx .\scripts\run-worker-gateway-remote-adapter-e2e.ts` | 0 | 29 PASS |
| `npm run typecheck` | 0 | — |
| `npx tsx .\scripts\test-phase288-worker-gateway-adversarial.ts` | **1** | **66 PASS, 2 FAIL** |
| `git diff --check` | 0 | — (CRLF warnings only) |

Regression gate total: 131 baseline assertions + 68 adversarial assertions = **197 assertions executed**.

## Persistence / restart

- **Session**: PASS (F1 — session persists across gateway restart).
- **Result**: PASS (F2 — `remote_execution_results` rows persist).
- **MessageId**: PASS (C7 — duplicate messageId rejected after restart).
- **Nonce**: PASS (F4 — nonce replay rejected after restart).
- **Sequence**: PASS (C8 — `lastSequence` monotonicity survives restart).

## Concurrency

- **G1** — same-sequence race: PASS (exactly one accepted).
- **G2** — duplicate `JOB_OFFER` claim: PASS (at most one claim).
- **G3** — duplicate `AUTH_REQUEST` nonce: PASS (exactly one authenticated).

## Remaining gaps (documented, not fixed)

### C9 — non-AUTH message timestamp freshness

The gateway does not validate `msg.timestamp` on `HEARTBEAT`, `JOB_OFFER`, `JOB_RESULT`, or `JOB_CANCEL`. A stale-timestamp message with a fresh sequence is accepted.

- **Severity**: Defense-in-depth gap. Sequence monotonicity plus durable `session.lastSequence` remains the primary replay protection for these message types. A captured message cannot be replayed without a fresh sequence.
- **Why not fixed in Phase 288**: Adding a timestamp check before the switch dispatch changes the wire contract for existing clients — a stale timestamp on a legitimate retry (e.g. after a transient network delay) would now be rejected even when the operation is idempotent. That is a protocol version change (additive on `WorkerTransportMessage.timestamp`), requiring a coordinated client/server rollout.
- **Phase 289 recommendation**: introduce `WorkerTransportMessage.timestamp` freshness enforcement behind a protocol version negotiation (`protocolVersion >= "1.1"`).

### C10 — failed operation advances `session.lastSequence`

`worker-gateway.ts` currently advances `session.lastSequence` and writes to `worker_message_ids` **before** the switch dispatch. A rejected operation (integrity failure, ownership violation, cancellation unavailable) consumes a sequence number and records the messageId.

- **Severity**: The current client increments its sequence counter monotonically, so a rejected-then-retried operation succeeds at `sequence + 1`. The defect is that `lastSequence` means "highest seen" rather than "highest successfully processed", and a retry with the **same** sequence after a failed operation is rejected as `invalid_sequence`.
- **Why not fixed in Phase 288**: Moving the sequence advance to after the switch requires re-examining every caller that reads `lastSequence` and deciding the "rejected sequences" tracking policy — a semantic change to the durable session contract, not a local reordering. Two prior attempts in this session produced structural damage to the file and were reverted.
- **Phase 289 recommendation**: introduce a separate `rejected_sequences` tracking table so retries with the same sequence can pass, and move `session.lastSequence` advance to transaction-after-success. Alternatively, migrate the gateway to `AsyncNexusEngine` with `transactionAsync` so the sequence advance, messageId accept, and switch dispatch share one transaction boundary.

## Deployment

**No remote push, no deployment, no `git commit` was performed during Phase 288.** All changes remain in the working tree awaiting review.

## Local test pass is not production security certification

Phase 288 exercises the real `WorkerGateway` handler through real HTTP against real SQLite-backed stores. Passing assertions demonstrate the described behaviors under the tested conditions. They do not constitute a security audit or a claim of production readiness.