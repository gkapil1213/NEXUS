# Phase 210 - Architecture

Phase 210 adds an evidence-backed release safety gate on top of Phase 209's
verification-integrity primitives. It does not touch SecurityReleaseGate or
ProductionReleaseDecisionService, which cover SAST/SCA/SIGNATURE/approval
and remain unchanged.

## Components

- src/core/release-safety-gate.ts       - pure evaluateReleaseSafety() decision
- src/db/migrations/168_phase210_release_attestations.sql
- src/core/pg-bootstrap.ts               - mirror for Postgres
- src/core/verification-manifest.ts      - PHASE_210 registered
- scripts/test-phase210-release-safety.ts
- scripts/phase210-evidence.ts

## Verifiable chain

    source -> commit -> execution -> verification -> resultDigest
          -> evidenceDigest -> artifact -> release candidate -> safety gate

Each link is checked. Any mismatch fails closed with a specific
REJECTED_* status and a human-readable reason.

## Decision surface

evaluateReleaseSafety({candidate, verificationRun, policy, now}) returns:

    {
      allowed: boolean,
      status:  ALLOWED | REJECTED_MISSING | REJECTED_FAIL | REJECTED_BLOCKED
             | REJECTED_NOT_EXECUTED | REJECTED_UNVERIFIED | REJECTED_TAMPERED
             | REJECTED_STALE | REJECTED_MISMATCH,
      reasons: string[],
      checks:  [{name, status, reason?}],
      releaseCandidate, verificationRunId, commit, execution,
      resultDigest, evidenceDigest, policyVersion, decidedAt
    }

It never returns a bare boolean. Every rejection names the invariant that
failed.

## Database

Migration 168 creates release_attestations, one row per
(release_id, verification_run_id, commit_sha). Idempotent via UNIQUE INDEX.
The pure decision function does not require the table; only the durable
wrapper does. Phase 210 ships the pure function + table; a wrapper that
writes attestations on ALLOWED can be added later without changing the gate.

## No bypass

There is no force=true / skipVerification=true path. The gate is the sole
decision point; callers that want to allow must produce a valid verification
run for the exact commit and execution being released.
