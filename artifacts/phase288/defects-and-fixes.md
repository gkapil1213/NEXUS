# Phase 288 — Defects and Fixes

Three items recorded: one found-and-fixed, two documented and deferred.

---

## F-1 — camelCase error codes collapsed to `gateway_error` (FIXED)

**File**: `src/core/worker-gateway.ts:93`

**Defect**: The error-boundary regex `^[a-z][a-z0-9_]+$` rejected any code containing uppercase letters. `jobId_required`, `workerId_required`, `attemptId_required`, `leaseId_required`, and `idempotencyKey_required` — all thrown by `createDispatch` and the `JOB_CANCEL` handler — were silently converted to the generic `gateway_error`. Clients could not distinguish "you forgot the jobId" from "something internal broke".

**Fix**: Widened the regex to `^[a-zA-Z][a-zA-Z0-9_]{0,63}$`. Codes up to 64 chars, starting with a letter, alphanumeric or underscore. Still rejects free-form messages (spaces, colons, slashes, dots, newlines are all disallowed).

**Regression coverage**: A-E9 in `scripts/test-phase288-worker-gateway-adversarial.ts` — asserts `JOB_CANCEL` with no `jobId` returns `{error: "jobId_required"}` (not `gateway_error`).

**Status**: PASS. Discovered by Phase 288, fixed in Phase 288, covered by regression.

---

## C9 — non-AUTH message timestamp freshness (DOCUMENTED, DEFERRED)

**File**: `src/core/worker-gateway.ts` — non-AUTH message branch (before the switch dispatch).

**Defect**: The gateway does not validate `msg.timestamp` on `HEARTBEAT`, `JOB_OFFER`, `JOB_RESULT`, or `JOB_CANCEL`. A message with a stale timestamp and a fresh sequence is accepted. The `AUTH_REQUEST` branch enforces timestamp freshness (via `WorkerAuthentication`), but the non-AUTH path does not.

**Severity**: Defense-in-depth gap, not a replay vulnerability on its own. Sequence monotonicity plus the durable `session.lastSequence` check remain the primary protection — a captured message cannot be replayed without also fabricating a fresh sequence, and the durable sequence check rejects the replay in that case.

**Why not fixed in Phase 288**: Adding a timestamp check before the switch dispatch changes the wire contract for existing clients. A legitimate retry (e.g. after a transient delay) carrying a stale `msg.timestamp` would now be rejected even when the operation is idempotent and safe. That is a protocol-version change, requiring coordinated rollout.

**Phase 289 recommendation**: Gate the timestamp enforcement on `protocolVersion >= "1.1"`, negotiated at AUTH time. Existing "1.0" clients retain current behavior; "1.1" clients must keep `msg.timestamp` within ±5 minutes of server time on every non-AUTH message. New regression assertions added to `coverage-matrix.md` (A–G) when the version gate lands.

**Status**: FAIL. Asserted against required behavior; observed behavior is accepted-with-stale-timestamp. Reported in the coverage matrix as FAIL per the Phase 288 policy that documented gaps are not silently marked PASS.

---

## C10 — failed operation advances `session.lastSequence` (DOCUMENTED, DEFERRED)

**File**: `src/core/worker-gateway.ts:157-162` (pre-switch sequence advance).

**Defect**: `session.lastSequence` and the durable `worker_message_ids` insert happen **before** the switch dispatch. A rejected operation — an integrity failure, ownership violation, or non-cancellable dispatch — consumes a sequence number and records the messageId, so:
- `session.lastSequence` reflects "highest seen" rather than "highest successfully processed".
- A retry with the **same** sequence number after a failed operation is rejected as `invalid_sequence`.
- The client must increment its sequence counter to retry, which it already does via `++this.sequence`, so retries succeed — but the semantics do not match the "failed operations cannot create an unrecoverable session" property.

**Severity**: The current client behavior masks the defect. A failing operation forces the sequence counter forward, and the retry succeeds at `sequence + 1`. The defect becomes a real problem if any future caller assumes `lastSequence` means "successfully processed" or expects same-sequence retries to work.

**Why not fixed in Phase 288**: The reorder was attempted twice in this session and both attempts produced structural damage to `worker-gateway.ts` (misplaced fragments, truncated sequence advance, broken auth path). The correct fix requires either:
1. A `rejected_sequences` tracking table so retries with the same sequence pass, plus moving the durable advance to after the switch returns, or
2. Migrating the gateway to `SQLiteAsyncEngine.transactionAsync` so the sequence advance, messageId accept, and switch dispatch share one atomic boundary. That migration is nontrivial — the current gateway uses the synchronous `NexusEngine` and `JOB_CANCEL` awaits an async `DispatchService.cancelDetailed` call, which cannot be wrapped in a synchronous `transaction<T>` block.

Both options change the durable session contract (`lastSequence` meaning). The change is worth doing carefully, not under time pressure.

**Phase 289 recommendation**: Implement option (1) — a `rejected_sequences` table plus moving the durable advance post-switch — as a focused change with new assertions covering same-sequence retry, sequence monotonicity after mixed success/failure, and cross-restart durability of both. The alternative (2) is larger and should follow once `ExecutionStore` completes its async migration.

**Status**: FAIL. Asserted against required behavior; observed behavior advances the sequence on failure. Reported in the coverage matrix as FAIL.

---

## Regression protection

- Every Phase 286, 287, and durable-gateway test remains at its pre-Phase-288 green baseline (131 assertions, exit 0 across 6 suites).
- Phase 288's adversarial suite covers 66 PASS across A–G. The 2 FAIL are C9 and C10, both documented above with Phase 289 recommendations.
- `git diff --check` reports no whitespace errors (only informational CRLF warnings on files that use CRLF line endings).