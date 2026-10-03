# Phase 240 — Durable Supervisor Lease Hardening, Renewal Watchdog, Fencing & Crash-Safe Recovery

## Durable supervisor lease hardening
Builds on Phase 239 `supervisor_leases`. PostgreSQL remains authoritative
for supervisor ownership. No second scheduler, no second lease table.

## Renewal result classification
`SupervisorLeaseRenewalResult` distinguishes:
- RENEWED — fenced UPDATE succeeded; expiry extended.
- OWNERSHIP_LOST — DB responded, zero rows affected (generation change,
  lease expired, owner mismatch).
- PERSISTENCE_UNAVAILABLE — DB threw; ownership could not be determined.

A persistence failure is never falsely reported as ownership loss. A
DB outage is never converted into OWNERSHIP_LOST, and RENEWED is never
returned without a confirmed fenced UPDATE.

## Ownership fencing
Fenced by (scopeKey, ownerId, generation) on every renew/release.

## Execution admission fencing
`executeOnce()` calls `renewSupervisorLeaseClassified()` immediately before
admitting owned work. Non-RENEWED -> `execution_blocked_by_lease` event and
NOT_OWNER report.

## Watchdog renewal
`tick()` and `runNow()` renew before admitting work. Local
`supervisorLeaseUntil` is diagnostic only.

## Concurrency / takeover
- Concurrent acquisition: exactly one winner.
- Concurrent takeover after expiry: exactly one winner.
- Renewal/takeover race fenced.
- Generation monotonically increases.

## Crash / restart
A disappears -> lease expires -> B acquires generation+1. A cannot renew
or admit recovery.

## Phase 238 checkpoint compatibility
`active_health_checkpoints` is untouched. Two durable tables, two fencing
domains. Verified by 240S.

## Phase 239 regression
Child execution of `npm run test:phase239` -> PASS: 56.

## Actual test result
Phase 240: PASS 25 / FAIL 0 / BLOCKED 0 / NOT EXECUTED 0

## Known limitations
- In-flight recovery cannot be transactionally cancelled.
- AWS_REGION_NOT_CONFIGURED remains BLOCKED for real-AWS paths.
- Pre-existing Vite browser-boundary build failure unrelated to Phase 240.