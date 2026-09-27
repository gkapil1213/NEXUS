# Phase 212 - Failure Modes

## Fail-closed invariants

| Condition | Detection | Outcome |
|---|---|---|
| Missing/unknown provider state | classifier UNKNOWN | RECOVERY_REQUIRED, no redeploy |
| Provider reports NOT_FOUND | provider.reconcile | no RESUME_FROM_INTENT |
| Provider reports PENDING | provider.reconcile | no RESUME_FROM_INTENT |
| Lease held by another worker | acquireLeaseAsync | BLOCKED, no side effects |
| Stale worker attempts transition | transitionIfOwnedAsync | rejected (updated=false) |
| Intent in terminal state | classifier | ALREADY_* (no action) |
| Intent in RECOVERY_REQUIRED | classifier | RECOVERY_REQUIRED (no automatic resume) |
| Artifact mismatch | different artifactDigest => different intentKey | separate intent |
| Commit mismatch | different commitSha => different intentKey | separate intent |
| Environment mismatch | different environment => different intentKey | separate intent |

## Secret leakage

212AD confirms intent rows carry no password/secret/token/apikey/bearer
tokens. Audit events use intentKey (a deterministic non-secret string) as
the correlation identity.
