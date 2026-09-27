# Phase 212 - Recovery

## Recovery states (existing ReleaseIntentStatus)

    AUTHORIZED | DEPLOYING | UNKNOWN | ROLLING_BACK | RECOVERY_REQUIRED
    | VERIFICATION_FAILED | KNOWN_GOOD | FAILED | BLOCKED | CANCELLED

## Classifier routing (verified)

| Status | Action | Requires inspection |
|---|---|---|
| AUTHORIZED (complete) | RESUME_FROM_INTENT | no |
| DEPLOYMENT_INTENT_CREATED | RESUME_FROM_INTENT | no |
| DEPLOYING | RECOVERY_REQUIRED | yes |
| HEALTH_CHECKING / SMOKE_TESTING (with deploymentId) | RESUME_VERIFICATION | yes |
| VERIFICATION_FAILED | MARK_FAILED_AND_ROLLBACK | no |
| ROLLING_BACK | RESUME_ROLLBACK | yes |
| KNOWN_GOOD | ALREADY_KNOWN_GOOD | no |
| FAILED | ALREADY_FAILED | no |
| BLOCKED | ALREADY_BLOCKED | no |
| CANCELLED | ALREADY_CANCELLED | no |
| UNKNOWN | RECOVERY_REQUIRED | yes |
| RECOVERY_REQUIRED | RECOVERY_REQUIRED | yes |

## Crash boundaries covered (per prompt §6)

- Before provider invocation: intent at DEPLOYMENT_INTENT_CREATED, classifier says RESUME_FROM_INTENT
- After provider accepts but response lost: intent at DEPLOYING, classifier says RECOVERY_REQUIRED
- After provider reports DEPLOYED but before verification: intent at HEALTH_CHECKING, classifier says RESUME_VERIFICATION
- During rollback: intent at ROLLING_BACK, classifier says RESUME_ROLLBACK
- After rollback: intent at FAILED or BLOCKED, terminal — classifier says no action

## No auto-redeploy

Nothing in Phase 212 will re-invoke provider.execute() for an intent whose
status is DEPLOYING or UNKNOWN. The classifier returns RECOVERY_REQUIRED
with requiresDockerInspection=true, forcing external reconciliation first.
