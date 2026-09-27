# Phase 209 - Failure Modes

## Historical 208D/208H/208S/208T discrepancy

During Phase 208 development, four scenarios were observed FAILing in direct
runtime output, and later evidence claimed 20/0. Phase 209 investigated.

Root cause (two independent defects, both fixed before commit 70d30e2):

1. pg-bootstrap.ts was missing last_progress_at. 208D could not persist
   progress in shared mode. Fixed in commit a72a91d.
2. admitFully() in the test called DistributedScheduler.tick() as a fallback;
   tick() runs dispatchTick(), which moves ADMITTED -> CLAIMED behind the
   caller. 208S raced with that movement. Fixed by replacing the fallback
   with a pure admitNextJobAsync loop.

The 20/0 result at 70d30e2 reflects the fixed state; it was not retroactively
stamped onto a stale artifact.

## Detectable failures

| Failure | Detection | Response |
|---|---|---|
| Test process exits non-zero | exit code | FAIL |
| Required test missing | manifest diff | UNVERIFIED |
| Unexpected test present | manifest diff | FAIL (UNEXPECTED_TEST) |
| Duplicate result for one testId | result map | FAIL (DUPLICATE_RESULT) |
| Persisted result edited | evidenceDigest mismatch | TAMPERED |
| Persisted count edited | evidenceDigest mismatch | TAMPERED |
| Commit SHA edited | evidenceDigest mismatch | TAMPERED |
| Required test BLOCKED | status count | BLOCKED |
| Required test NOT_EXECUTED | status count | UNVERIFIED |

## Not detectable in-band

A fully coherent regeneration of the artifact at a different commit is only
detectable by re-running the verifier against the current HEAD. The verifier
records the commit it ran on; cross-checking 'git rev-parse HEAD' at read time
is a required out-of-band step.
