# Phase 243 — Crash Recovery

## A11 — scheduler crashes before claim
PENDING remains PENDING and is picked up on next tick.

## A12 — scheduler crashes after claim
Claim lease expires. Replacement worker claims. Original owner fenced.

## A13 — worker crashes during retry
Same as A12 for a retry attempt; replacement resumes from durable state.

## A14 — PostgreSQL restart
Live operation persists across `docker restart nexus-pg`. Verifier asserts
last_failure_class and next_attempt_at survive; recovery can continue.

## A15 — retry exhaustion
5 attempted retries -> RECOVERY_REQUIRED. No infinite loop.

## A23 — Phase 242 regression
The Phase 242 verifier is run as a child process from the Phase 243 verifier
and must report PASS:30 / FAIL:0.
