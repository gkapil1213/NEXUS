# Phase 210 - Release Safety Gate

## Fail-closed rules

A release is ALLOWED only if every check PASSES:

- EVIDENCE_INTEGRITY: Phase 209 verifyStoredEvidence returns VERIFIED_PASS
- RUN_STATUS: run.status === 'PASS'
- COUNTS: failCount=0, blockedCount=0, notExecutedCount=0, unverifiedCount=0,
          passCount === requestedTestCount, requestedTestCount > 0
- DUPLICATES: no testId appears twice in results[]
- COMMIT: evidence.repositoryCommit === candidate.commitSha
- EXECUTION: evidence.executionId (if present) === candidate.executionId
- ARTIFACT: if policy.requireArtifactBinding, evidence.artifactDigest
            (if present) === candidate.artifactDigest and candidate has one
- FRESHNESS: if policy.freshnessMs is set, now - run.completedAt <= freshnessMs

## Rejection statuses

- REJECTED_MISSING         - evidence absent or malformed
- REJECTED_TAMPERED        - digest mismatch after edit
- REJECTED_FAIL            - run.status=FAIL or counts show failures
- REJECTED_BLOCKED         - run.status=BLOCKED
- REJECTED_NOT_EXECUTED    - required test not executed
- REJECTED_UNVERIFIED      - run.status=UNVERIFIED or missing required test
- REJECTED_STALE           - freshness policy exceeded
- REJECTED_MISMATCH        - commit / execution / artifact mismatch

## Policy

    interface ReleaseSafetyPolicy {
      policyVersion: string;         // audited, never trusted for authorization
      freshnessMs?: number;          // undefined = no staleness check
      requireArtifactBinding?: boolean;
    }

policyVersion is written to the decision for audit; it does not change
the checks in this phase. A future phase could dispatch on it.
