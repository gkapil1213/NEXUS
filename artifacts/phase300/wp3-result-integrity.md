# WP3 — Result integrity and ownership

**Classification: PASS — 7/7 integration tests**

ExecutionStore.persistRemoteExecutionResultAndDispatchAsOwnerAsync:
single PostgreSQL transaction with pre-transaction caller-identity checks
(dispatchId, jobId, attemptId), FOR UPDATE dispatch row lock, stored job_id
guard, worker and lease identity verification, live lease lock and expiry
check, duplicate detection via unique dispatch_id + result_sha256 comparison
(missing digests NOT treated as sameness), atomic INSERT + UPDATE with
row-count checks on both writes.

Return contract:
  Success:             { persisted: true,  duplicate: false }
  Matching duplicate:  { persisted: true,  duplicate: true } (dispatch reconciled)
  Wrong worker/lease:  { persisted: false, reason: "WORKER_OWNERSHIP_LOST" }
  Caller id mismatch:  { persisted: false, reason: "DISPATCH_IDENTITY_MISMATCH" }
  Expired lease:       { persisted: false, reason: "LEASE_EXPIRED" }
  Conflicting dup:     { persisted: false, reason: "RESULT_CONFLICT" }

Caller error mapping (handler-registry.ts, worker-gateway.ts):
  RESULT_CONFLICT -> "conflicting_duplicate_result"
  all others      -> "ownership_lost"
  duplicate: true flows through to JOB_RESULT_ACK (spec: "identical previously
  persisted result: ACK").

Test: scripts/test-phase268-remote-result-integrity.ts, 336 lines,
7 cases against live PostgreSQL at DATABASE_URL. Verbose output is in
test-results/2026-11-08-phase268-ri-7-7-PASS.txt.

Prior commit f47a32d failed 4 of 7 cases (C, D, F, G). Contract v2 at
977ed86 fixes all four. 9153d5c is a cosmetic encoding fix; test re-run
confirms 7/7 still holds.
