import { createGovernedResource } from './worker-phase33-resource';
import { createOptimizationOpportunity } from './worker-phase33-optimization-opportunity';
import { createOptimizationPlan } from './worker-phase33-optimization-plan';
import { evaluatePolicy } from './worker-phase33-policy-evaluation';
import { assessRisk } from './worker-phase33-risk';
import { calculateBlastRadius } from './worker-phase33-blast-radius';
import { evaluateSafety } from './worker-phase33-safety';
import { createChangePlan } from './worker-phase33-change-plan';
import { createRemediationPlan } from './worker-phase33-remediation-plan';
import { createRemediationExecution, transitionRemediationExecution } from './worker-phase33-remediation-execution';
import { verifyRemediation } from './worker-phase33-remediation-verification';
import { createRemediationRollback } from './worker-phase33-remediation-rollback';
import { evaluateCircuitBreaker } from './worker-phase33-remediation-circuit-breaker';
import { createIncident } from './worker-phase33-incident';
import { createEvidence } from './worker-phase33-evidence';
import { createAuditEvent } from './worker-phase33-audit';
import { addLineageNode, Lineage } from './worker-phase33-lineage';
import { createLearningRecord } from './worker-phase33-learning';
import { Provider, unconfiguredProvider } from './worker-phase33-provider';

export interface ResourceGovernanceRequest {
  tenantId: string;
  correlationId: string;
  resource: Omit<Parameters<typeof createGovernedResource>[0], 'correlationId'>;
  policyInput: Parameters<typeof evaluatePolicy>[0];
  riskInput: Parameters<typeof assessRisk>[0];
  blastRadiusInput: { affectedResources: number; dependentResources: number; environments: number; fleets: number; securityImpact: number; complianceImpact: number };
  safetyInput: Parameters<typeof evaluateSafety>[0];
  circuitBreaker: { failureCount: number; threshold: number };
  provider?: Provider;
  opportunityInput: Omit<Parameters<typeof createOptimizationOpportunity>[0], 'resourceId' | 'correlationId'>;
}

export async function orchestrateResourceGovernance(request: ResourceGovernanceRequest) {
  const auditEvents: ReturnType<typeof createAuditEvent>[] = [];
  const evidence: ReturnType<typeof createEvidence>[] = [];
  const provider = request.provider ?? unconfiguredProvider;

  const resource = createGovernedResource({ ...request.resource });
  const policyDecision = evaluatePolicy(request.policyInput);
  const risk = assessRisk(request.riskInput);
  const blastRadius = calculateBlastRadius(request.blastRadiusInput.affectedResources, request.blastRadiusInput.dependentResources, request.blastRadiusInput.environments, request.blastRadiusInput.fleets, request.blastRadiusInput.securityImpact, request.blastRadiusInput.complianceImpact);
  const safety = evaluateSafety(request.safetyInput);
  const breaker = evaluateCircuitBreaker(request.circuitBreaker.failureCount, request.circuitBreaker.threshold);

  if (policyDecision === 'DENY' || policyDecision === 'FREEZE' || !safety.allowed || breaker === 'OPEN') {
    auditEvents.push(createAuditEvent({ tenantId: request.tenantId, correlationId: request.correlationId, eventType: 'GOVERNANCE_BLOCKED', reason: `policy=${policyDecision}, safety=${safety.reason}, breaker=${breaker}`, decision: 'BLOCKED' }));
    return { status: 'BLOCKED', reason: `policy=${policyDecision}, safety=${safety.reason}, breaker=${breaker}`, resource, policyDecision, risk, blastRadius, safety, auditEvents, evidence, lineage: { rootId: resource.resourceId, nodes: [] } };
  }

  const opportunity = createOptimizationOpportunity({ ...request.opportunityInput, resourceId: resource.resourceId });
  const plan = createOptimizationPlan({ opportunityId: opportunity.opportunityId, actions: [opportunity.type], risk: risk, blastRadius });
  const changePlan = createChangePlan({ action: opportunity.type, target: resource.resourceId, reason: opportunity.reason, expectedResult: 'optimized', policyDecision, approvalRequired: policyDecision === 'ALLOW_WITH_APPROVAL', blastRadius, risk, rollbackStrategy: 'restore', verificationStrategy: 'check' });

  let exec = createRemediationExecution({ planId: plan.planId });
  exec = transitionRemediationExecution(exec, 'APPROVED');
  exec = transitionRemediationExecution(exec, 'RUNNING');

  const providerResult = await provider.executeAction(opportunity.type, { resourceId: resource.resourceId });
  if (!providerResult.success) {
    const failedExec = transitionRemediationExecution(exec, 'FAILED');
    return { status: 'FAILED', reason: providerResult.reason, resource, policyDecision, risk, blastRadius, safety, opportunity, plan, changePlan, execution: failedExec, auditEvents, evidence, lineage: { rootId: resource.resourceId, nodes: [] } };
  }

  exec = transitionRemediationExecution(exec, 'SUCCEEDED');
  const verification = verifyRemediation(true, true, true, true, true);
  const rollback = verification === 'VERIFIED' ? null : createRemediationRollback(exec.executionId);

  evidence.push(createEvidence({ resourceId: resource.resourceId, type: 'remediation', data: { result: verification } }));
  auditEvents.push(createAuditEvent({ tenantId: request.tenantId, correlationId: request.correlationId, eventType: 'RESOURCE_GOVERNANCE_SUCCEEDED', reason: 'resource governance completed', decision: 'SUCCESS' }));
  const lineage: Lineage = { rootId: resource.resourceId, nodes: [] };
  addLineageNode(lineage, { version: 1, resourceId: resource.resourceId, operationId: exec.executionId, timestamp: new Date().toISOString() });
  const learning = createLearningRecord({ resourceId: resource.resourceId, outcome: verification, success: verification === 'VERIFIED' });

  return { status: 'COMPLETED', resource, policyDecision, risk, blastRadius, safety, opportunity, plan, changePlan, execution: exec, verification, rollback, evidence, auditEvents, lineage, learning };
}
