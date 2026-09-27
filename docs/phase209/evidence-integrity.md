# Phase 209 - Evidence Integrity

## Digests

### resultDigest

    sha256(canonicalize(sorted [{testId,status}]))

Order-independent over test IDs. Sensitive to status changes. Excludes notes
and timestamps so prose variation does not spuriously invalidate.

### evidenceDigest

    sha256(canonicalize({runId, phase, suite, repositoryCommit,
      repositoryBranch, testScript, counts..., resultDigest, results}))

Excludes timestamps. Any edit to a count, commit SHA, status, phase, or suite
changes it.

## Tamper scenarios verified by 209G/H/I

- Commit SHA edited    -> TAMPERED / EVIDENCE_DIGEST_MISMATCH
- PASS count edited    -> TAMPERED / EVIDENCE_DIGEST_MISMATCH
- Result status edited -> TAMPERED / RESULT_DIGEST_MISMATCH

## Legacy Phase 208 artifact

The artifact committed at 70d30e2 predates Phase 209 and has no evidenceDigest.
scripts/verify-phase208-evidence.ts returns verdict=UNVERIFIED,
reasons=MISSING_REQUIRED_FIELDS. It is never retroactively relabeled PASS.
The authoritative Phase 208 record is the verification run produced by
'npx tsx scripts/verify-phase.ts 208'.
