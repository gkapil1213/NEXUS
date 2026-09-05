import { createDeploymentTarget, isTargetAvailable } from './worker-deployment-target';
import { DeploymentAdapter, unavailableDeploymentAdapter } from './worker-deployment-adapter';
import { createDeploymentPlan } from './worker-deployment-plan';
import { runDeploymentPreflight } from './worker-deployment-preflight';
import { acquireDeploymentLock, releaseDeploymentLock, isLockActive, DeploymentLock } from './worker-deployment-lock';
import { createDeploymentExecution, transitionDeploymentExecution, DeploymentExecution } from './worker-deployment-execution';
import { evaluateCanaryRollout } from './worker-deployment-rollout';
import { evaluateRuntimeHealth } from './worker-deployment-health';
import { verifyDeployment } from './worker-deployment-verification';
import { evaluateDeploymentRollback } from './worker-deployment-rollback';
import { classifyFailure } from './worker-deployment-recovery';
import { evaluateCircuitBreaker } from './worker-deployment-circuit-breaker';
import { governDeployment } from './worker-deployment-governance';
import { evaluateDeploymentSafety } from './worker-deployment-safety';
import { createDeploymentAuditEvent } from './worker-deployment-audit';
import { createDeploymentEvidence } from './worker-deployment-evidence';
import { addDeploymentLineageNode, DeploymentLineage } from './worker-deployment-lineage';

export interface DeploymentRequest {
  tenantId: string;
  correlationId: string;
  releaseId: string;
  artifactId: string;
  target: Omit<Parameters<typeof createDeploymentTarget>[0], 'correlationId'>;
  plan: Omit<Parameters<typeof createDeploymentPlan>[0], 'releaseId' | 'artifactId' | 'targetId' | 'correlationId'>;
  preflight: Parameters<typeof runDeploymentPreflight>[0];
  governanceInput: Parameters<typeof governDeployment>[0];
  safetyInput: Parameters<typeof evaluateDeploymentSafety>[0];
  rollout: Parameters<typeof evaluateCanaryRollout>[0];
  health: Parameters<typeof evaluateRuntimeHealth>[0];
  verification: Parameters<typeof verifyDeployment>[0];
  rollbackInput: Parameters<typeof evaluateDeploymentRollback>[0];
  recoveryInput: Parameters<typeof classifyFailure>[0];
  circuitBreakerInput: Parameters<typeof evaluateCircuitBreaker>[0];
  adapter?: DeploymentAdapter;
  idempotencyKey?: string;
}

export async function orchestrateDeployment(request: DeploymentRequest) {
  const auditEvents: ReturnType<typeof createDeploymentAuditEvent>[] = [];
  const evidence: ReturnType<typeof createDeploymentEvidence>[] = [];
  const adapter = request.adapter ?? unavailableDeploymentAdapter;

  // 1. Target
  const target = createDeploymentTarget({ ...request.target, correlationId: request.correlationId });
  if (!isTargetAvailable(target)) {
    auditEvents.push(createDeploymentAuditEvent({ tenantId: request.tenantId, correlationId: request.correlationId, targetId: target.targetId, eventType: 'DEPLOYMENT_BLOCKED', reason: 'target unavailable', decision: 'BLOCKED' }));
    return { status: 'BLOCKED', reason: 'target unavailable', target, auditEvents, evidence, lineage: { rootId: 'none', nodes: [] } };
  }

  // 2. Governance and Safety
  const governance = governDeployment(request.governanceInput);
  const safety = evaluateDeploymentSafety(request.safetyInput);
  if (governance === 'DENY' || safety === 'DENY') {
    auditEvents.push(createDeploymentAuditEvent({ tenantId: request.tenantId, correlationId: request.correlationId, targetId: target.targetId, eventType: 'DEPLOYMENT_DENIED', reason: `governance=${governance}, safety=${safety}`, decision: 'DENIED' }));
    return { status: 'DENIED', reason: `governance=${governance}, safety=${safety}`, target, auditEvents, evidence, lineage: { rootId: 'none', nodes: [] } };
  }

  // 3. Preflight
  const preflight = runDeploymentPreflight(request.preflight);
  if (!preflight.passed) {
    auditEvents.push(createDeploymentAuditEvent({ tenantId: request.tenantId, correlationId: request.correlationId, targetId: target.targetId, eventType: 'PREFLIGHT_FAILED', reason: preflight.reasons.join(', '), decision: 'BLOCKED' }));
    return { status: 'BLOCKED', reason: preflight.reasons.join(', '), target, preflight, auditEvents, evidence, lineage: { rootId: 'none', nodes: [] } };
  }

  // 4. Lock
  const lockResult = acquireDeploymentLock(target.environment, target.targetId, request.plan.createdBy, 60000, request.correlationId);
  if (!lockResult.success) {
    return { status: 'BLOCKED', reason: lockResult.reason, target, auditEvents, evidence, lineage: { rootId: 'none', nodes: [] } };
  }
  const lock = lockResult.lock!;

  // 5. Plan and Execution
  const plan = createDeploymentPlan({ ...request.plan, releaseId: request.releaseId, artifactId: request.artifactId, targetId: target.targetId, correlationId: request.correlationId });
  let execution = createDeploymentExecution({ planId: plan.planId, correlationId: request.correlationId });
  execution = transitionDeploymentExecution(execution, 'PRECHECKING');
  execution = transitionDeploymentExecution(execution, 'APPROVED');
  execution = transitionDeploymentExecution(execution, 'EXECUTING');

  // 6. Deploy via adapter
  const deployResult = await adapter.deploy(request.artifactId, 'v1');
  if (!deployResult.success) {
    execution = transitionDeploymentExecution(execution, 'FAILED');
    releaseDeploymentLock(lock);
    auditEvents.push(createDeploymentAuditEvent({ tenantId: request.tenantId, correlationId: request.correlationId, deploymentId: execution.executionId, eventType: 'DEPLOYMENT_FAILED', reason: deployResult.reason, decision: 'FAILED' }));
    return { status: 'FAILED', reason: deployResult.reason, target, plan, execution, lock, auditEvents, evidence, lineage: { rootId: 'none', nodes: [] } };
  }

  execution = transitionDeploymentExecution(execution, 'ROLLOUT');

  // 7. Rollout evaluation
  const rollout = evaluateCanaryRollout(request.rollout);
  if (rollout.nextState === 'ABORTED') {
    execution = transitionDeploymentExecution(execution, 'FAILED');
    releaseDeploymentLock(lock);
    return { status: 'FAILED', reason: 'rollout aborted', target, plan, execution, rollout, auditEvents, evidence, lineage: { rootId: 'none', nodes: [] } };
  }
  execution = transitionDeploymentExecution(execution, 'VERIFYING');

  // 8. Health & Verification
  const health = evaluateRuntimeHealth(request.health);
  const verification = verifyDeployment(request.verification);
  if (!verification.verified || health !== 'HEALTHY') {
    execution = transitionDeploymentExecution(execution, 'FAILED');
    releaseDeploymentLock(lock);
    return { status: 'FAILED', reason: `verification=${verification.verified}, health=${health}`, target, plan, execution, rollout, health, verification, auditEvents, evidence, lineage: { rootId: 'none', nodes: [] } };
  }

  execution = transitionDeploymentExecution(execution, 'PROMOTING');
  execution = transitionDeploymentExecution(execution, 'SUCCEEDED');
  releaseDeploymentLock(lock);

  // 9. Evidence, Lineage, Audit
  evidence.push(createDeploymentEvidence({ tenantId: request.tenantId, correlationId: request.correlationId, deploymentId: execution.executionId, evidenceType: 'DEPLOYMENT_SUCCESS', data: { releaseId: request.releaseId, artifactId: request.artifactId } }));
  const lineage: DeploymentLineage = { rootId: execution.executionId, nodes: [] };
  addDeploymentLineageNode(lineage, { version: 1, releaseId: request.releaseId, artifactId: request.artifactId, targetId: target.targetId, deploymentId: execution.executionId, timestamp: new Date().toISOString() });
  auditEvents.push(createDeploymentAuditEvent({ tenantId: request.tenantId, correlationId: request.correlationId, deploymentId: execution.executionId, eventType: 'DEPLOYMENT_SUCCEEDED', reason: 'deployment completed', decision: 'SUCCEEDED' }));

  return { status: 'COMPLETED', target, plan, execution, rollout, health, verification, lock, auditEvents, evidence, lineage };
}
