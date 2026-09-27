# Phase 210 - Failure Modes

Every failure surface produces a specific rejection status. None of them
can be converted into ALLOWED without re-running the underlying verification.

| Failure | Detection | Status |
|---|---|---|
| Missing verification run | shape check | REJECTED_MISSING |
| Malformed JSON | shape check | REJECTED_MISSING |
| Evidence digest edited | Phase 209 verifyStoredEvidence | REJECTED_TAMPERED |
| Result digest edited | Phase 209 verifyStoredEvidence | REJECTED_TAMPERED |
| Commit SHA edited in evidence | COMMIT check | REJECTED_MISMATCH |
| Execution ID mismatch | EXECUTION check | REJECTED_MISMATCH |
| Artifact digest mismatch | ARTIFACT check | REJECTED_MISMATCH |
| PASS count edited in evidence | EVIDENCE_INTEGRITY | REJECTED_TAMPERED |
| Required test deleted | missing in results | REJECTED_UNVERIFIED |
| Duplicate testId | DUPLICATES check | REJECTED_FAIL |
| Verification BLOCKED | RUN_STATUS + COUNTS | REJECTED_BLOCKED |
| Verification NOT_EXECUTED | RUN_STATUS + COUNTS | REJECTED_NOT_EXECUTED |
| Verification FAIL | RUN_STATUS + COUNTS | REJECTED_FAIL |
| Evidence older than freshnessMs | FRESHNESS | REJECTED_STALE |
| Repository moved past verified commit | COMMIT check | REJECTED_MISMATCH |
| Replay old evidence on new candidate | COMMIT check | REJECTED_MISMATCH |

## Not detectable in-band

A fully coherent regeneration of the verification run at a different commit
is rejected by the COMMIT check unless the candidate itself also claims that
commit. Cross-checking 'git rev-parse HEAD' at decision time is the
out-of-band control; the gate records the commit it evaluated so audits can
verify the decision's inputs.

## Concurrency

evaluateReleaseSafety is a pure function over (candidate, verificationRun,
policy, now). It holds no shared mutable state. Concurrent evaluations of the
same inputs produce identical outputs by construction, verified by 210N.
Persistence of attestations uses UNIQUE(release_id, verification_run_id,
commit_sha) so concurrent writers cannot create duplicates.
