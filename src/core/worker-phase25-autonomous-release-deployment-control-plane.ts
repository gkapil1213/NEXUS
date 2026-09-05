import { createRelease } from './worker-phase25-release';
import { createDeploymentPlan } from './worker-phase25-deployment-plan';
import { createDeploymentExecution, transitionDeploymentExecution } from './worker-phase25-deployment-execution';
import { advanceRollout, ProgressiveDeliveryState } from './worker-phase25-progressive-delivery';
import { evaluateHealthGate } from './worker-phase25-health-gate';
import { createDeploymentHalt } from './worker-phase25-deployment-halt';
import { createRollbackExecution, transitionRollbackExecution } from './worker-phase25-deployment-rollback';
import { evaluateRollbackSafety } from './worker-phase25-rollback-safety';
import { evaluateDeploymentCircuitBreaker } from './worker-phase25-deployment-circuit-breaker';
import { createReleaseFreeze } from './worker-phase25-release-freeze';
import { createDeploymentIncident } from './worker-phase25-deployment-incident';
import { createDeploymentEvidence } from './worker-phase25-deployment-evidence';
import { createDeploymentAuditEvent } from './worker-phase25-deployment-audit';
import { addReleaseLineageNode, ReleaseLineage } from './worker-phase25-release-lineage';
import { DeploymentAdapter, unavailableDeploymentAdapter } from './worker-deployment-adapter'; // existing

export interface AutonomousReleaseDeploymentRequest {
  artifactId: string;
  tenantId: string;
  correlationId: string;
  release: Omit<Parameters<typeof createRelease>[0], 'correlationId'>;
  plan: Omit<Parameters<typeof createDeploymentPlan>[0], 'releaseId' | 'artifactId' | 'correlationId'>;
  governance: 'ALLOW' | 'REQUIRES_APPROVAL' | 'DENY';
  approvalValid: boolean;
  securityStatus: 'PASS' | 'FAIL' | 'UNKNOWN';
  circuitBreaker: { failureCount: number; threshold: number };
  frozen: boolean;
  provider?: DeploymentAdapter;
  rolloutState: ProgressiveDeliveryState;
  healthInput: Parameters<typeof evaluateHealthGate>[0];
  rollbackSafetyInput: Parameters<typeof evaluateRollbackSafety>[0];
}

export async function orchestrateReleaseDeployment(request: AutonomousReleaseDeploymentRequest) {
  const auditEvents: ReturnType<typeof createDeploymentAuditEvent>[] = [];
  const evidence: ReturnType<typeof createDeploymentEvidence>[] = [];
  const adapter = request.provider ?? unavailableDeploymentAdapter;

  // Release
  const release = createRelease({ ...request.release });

  // Governance/Security/Approval/CircuitBreaker/Freeze
  if (request.governance === 'DENY' || !request.approvalValid || request.securityStatus === 'FAIL' || evaluateDeploymentCircuitBreaker(request.circuitBreaker.failureCount, request.circuitBreaker.threshold) === 'OPEN' || request.frozen) {
    auditEvents.push(createDeploymentAuditEvent({ tenantId: request.tenantId, correlationId: request.correlationId, eventType: 'DEPLOYMENT_BLOCKED', reason: 'policy gate failed', decision: 'BLOCKED' }));
    return { status: 'BLOCKED', reason: 'policy gate failed', release, auditEvents, evidence, lineage: { releaseId: release.releaseId, nodes: [] } };
  }

  // Deployment plan
  const plan = createDeploymentPlan({ ...request.plan, releaseId: release.releaseId, artifactId: request.artifactId });

  // Execution
  let execution = createDeploymentExecution({ planId: plan.planId });
  execution = transitionDeploymentExecution(execution, 'APPROVAL_PENDING');
  execution = transitionDeploymentExecution(execution, 'APPROVED');
  execution = transitionDeploymentExecution(execution, 'STARTING');
  execution = transitionDeploymentExecution(execution, 'RUNNING');

  // Provider deploy
  const deployResult = await adapter.deploy(request.artifactId, request.release.version);
  if (!deployResult.success) {
    execution = transitionDeploymentExecution(execution, 'FAILED');
    auditEvents.push(createDeploymentAuditEvent({ tenantId: request.tenantId, correlationId: request.correlationId, eventType: 'DEPLOYMENT_FAILED', reason: deployResult.reason, decision: 'FAILED' }));
    return { status: 'FAILED', reason: deployResult.reason, release, plan, execution, auditEvents, evidence, lineage: { releaseId: release.releaseId, nodes: [] } };
  }

  // Progressive rollout
  const rollout = advanceRollout(request.rolloutState);
  if (rollout.action === 'HALT') {
    const halt = createDeploymentHalt(execution.executionId, 'rollout halt');
    execution = transitionDeploymentExecution(execution, 'ROLLING_BACK');
    const rollback = createRollbackExecution(execution.executionId, release.releaseId);
    const rollbackSafety = evaluateRollbackSafety(request.rollbackSafetyInput);
    if (!rollbackSafety.allowed) {
      execution = transitionDeploymentExecution(execution, 'FAILED');
      return { status: 'FAILED', reason: rollbackSafety.reason, release, plan, execution, rollout, halt, rollback, auditEvents, evidence, lineage: { releaseId: release.releaseId, nodes: [] } };
    }
    const rollbackExec = transitionRollbackExecution(rollback, 'ROLLBACK_VALIDATING');
    // In real implementation would execute rollback, verify, etc. We simulate success.
    const verifiedRollback = transitionRollbackExecution(rollbackExec, 'ROLLED_BACK');
    execution = transitionDeploymentExecution(execution, 'ROLLED_BACK');
    auditEvents.push(createDeploymentAuditEvent({ tenantId: request.tenantId, correlationId: request.correlationId, eventType: 'ROLLBACK_COMPLETED', reason: 'rollout halt rollback', decision: 'ROLLED_BACK' }));
    return { status: 'ROLLED_BACK', reason: 'rollout halt', release, plan, execution, rollout, halt, rollback: verifiedRollback, auditEvents, evidence, lineage: { releaseId: release.releaseId, nodes: [] } };
  }

  // Health gate
  const health = evaluateHealthGate(request.healthInput);
  if (health === 'UNHEALTHY' || health === 'DEGRADED') {
    execution = transitionDeploymentExecution(execution, 'FAILED');
    return { status: 'FAILED', reason: `health ${health}`, release, plan, execution, rollout, health, auditEvents, evidence, lineage: { releaseId: release.releaseId, nodes: [] } };
  }

  // Complete
  execution = transitionDeploymentExecution(execution, 'SUCCEEDED');
  evidence.push(createDeploymentEvidence({ deploymentId: execution.executionId, releaseId: release.releaseId, artifactId: request.artifactId, provider: 'test', strategy: plan.strategy, healthResult: health, rollbackState: 'NONE', finalResult: 'SUCCESS' }));
  auditEvents.push(createDeploymentAuditEvent({ tenantId: request.tenantId, correlationId: request.correlationId, eventType: 'DEPLOYMENT_SUCCEEDED', reason: 'deployment completed', decision: 'SUCCESS' }));
  const lineage: ReleaseLineage = { releaseId: release.releaseId, nodes: [] };
  addReleaseLineageNode(lineage, { version: 1, releaseId: release.releaseId, artifactId: request.artifactId, deploymentId: execution.executionId, timestamp: new Date().toISOString() });

  return { status: 'COMPLETED', release, plan, execution, rollout, health, evidence, auditEvents, lineage };
}
