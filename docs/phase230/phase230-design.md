# Phase 230 - Real AWS ALB traffic cutover, rollback and reconciliation

## Recon at HEAD dbff3d7 (post-Phase 229)

- AWS CLI: present (C:\Users\pc\scoop\shims\aws.exe)
- AWS credentials: NOT configured (sts get-caller-identity -> NoCredentials)
- AWS region: NOT configured
- Phase 229 cutover used `elbv2 register-targets` - NOT a real ALB routing change
- Phase 229 revert used `register-targets` - NOT a real previous-route restore
- Unsafe cast: `(req as unknown as { targetId?: string }).targetId` at aws-traffic-router.ts:159

## What Phase 230 changes

1. Extends CutoverRequest with typed AWS routing identity
   (listenerArn, ruleArn, candidateTargetGroupArn, previousTargetGroupArn)
2. Extracts AwsCliRunner interface so command construction is testable
3. Rewrites cutover to modify actual ALB forwarding via modify-listener or
   modify-rule (depends on discovered routing model)
4. Rewrites revert to restore the exact previous forward configuration
5. Extends AWSTrafficRouter with real discovery:
   describe-load-balancers, describe-listeners, describe-rules,
   describe-target-groups, describe-target-health
6. Fixes resolveTarget to discover active routing (listener -> rule -> forward
   action -> target group), not just "any healthy target"
7. Rewrites reconcile to compare forward configuration, not target IDs
8. Fixes capabilities to distinguish adapter implementation from runtime readiness
9. Fixes factory to preserve AWS-selected-but-BLOCKED with the real reason

## Routing model

    ALB
     -> Listener
        -> Listener Rule (or default action)
           -> Forward Action
              -> Target Group
                 -> Target

Cutover changes the forward action from OLD TG to NEW TG via:
  - modify-rule (when a rule controls the route)
  - modify-listener (when the listener default action controls the route)

The exact command is derived from the discovered configuration.

## Previous routing snapshot

Captured BEFORE any mutation:
  loadBalancerArn, listenerArn, ruleArn, previousTargetGroupArn,
  previousForwardConfig (weights, target group), observedAt,
  releaseId, deploymentId, commitSha

Not persisted: AWS credentials, secrets.

## Configuration (env)

NEXUS_AWS_REGION or AWS_REGION or AWS_DEFAULT_REGION
NEXUS_AWS_LOAD_BALANCER_ARN
NEXUS_AWS_LISTENER_ARN
NEXUS_AWS_RULE_ARN (optional; default action used when absent)
NEXUS_AWS_TARGET_GROUP_ARN (candidate)
NEXUS_AWS_PREVIOUS_TARGET_GROUP_ARN (optional; discovered when absent)
NEXUS_AWS_TARGET_PORT (optional)

## Honest scope

In this environment, every real AWS operation returns BLOCKED with
AWS_CREDENTIALS_NOT_CONFIGURED or AWS_REGION_NOT_CONFIGURED. The command
construction is verified deterministically via an injected AwsCliRunner spy;
the actual AWS integration is BLOCKED.

## Verification matrix

  Implementation              PASS
  Compilation                 PASS
  Unit/Integration tests      PASS
  Regression                  PASS
  AWS credentials             BLOCKED
  AWS region                  BLOCKED
  ALB discovery               BLOCKED (credentials)
  Listener discovery          BLOCKED (credentials)
  Rule discovery              BLOCKED (credentials)
  Target validation           BLOCKED (credentials)
  Real traffic cutover        BLOCKED (credentials)
  Post-cutover verification   BLOCKED (credentials)
  Real rollback               BLOCKED (credentials)
  Post-rollback verification  BLOCKED (credentials)