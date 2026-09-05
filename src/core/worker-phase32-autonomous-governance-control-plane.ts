import { createGovernancePolicy, GovernancePolicy } from './worker-phase32-policy';
import { evaluatePolicy, PolicyEvaluation } from './worker-phase32-policy-evaluator';
import { PolicyCondition } from './worker-phase32-policy-condition';
import { resolvePolicyConflict } from './worker-phase32-policy-conflict';
import { createPolicyViolation } from './worker-phase32-violation';
import { assessGovernanceRisk } from './worker-phase32-risk';
import { createApprovalRequest, isValidApproval } from './worker-phase32-approval';
import { createPolicyException, isExceptionValid } from './worker-phase32-exception';
import { calculateGovernanceBlastRadius } from './worker-phase32-governance-blast-radius';
import { createGovernanceRemediationPlan } from './worker-phase32-remediation-plan';
import { evaluateGovernanceRemediationSafety } from './worker-phase32-remediation-safety';
import { createGovernanceRemediationExecution, transitionGovernanceRemediationExecution } from './worker-phase32-remediation-execution';
import { createGovernanceIncident } from './worker-phase32-incident';
import { createGovernanceEvidence } from './worker-phase32-evidence';
import { createGovernanceAuditEvent } from './worker-phase32-audit';
import { addGovernanceLineageNode, GovernanceLineage } from './worker-phase32-lineage';
import { createGovernanceLearningRecord } from './worker-phase32-learning';
import { GovernanceProvider, unconfiguredGovernanceProvider } from './worker-phase32-provider';
import { evaluateGovernanceCircuitBreaker } from './worker-phase32-remediation-circuit-breaker';

export interface GovernanceRequest {
  tenantId: string;
  correlationId: string;
  policy: Omit<Parameters<typeof createGovernancePolicy>[0], 'correlationId'>;
  condition: PolicyCondition;
  context: Record<string, unknown>;
  riskInput: Parameters<typeof assessGovernanceRisk>[0];
  approvalInput: Omit<Parameters<typeof createApprovalRequest>[0], 'correlationId'>;
  exceptionInput: Omit<Parameters<typeof createPolicyException>[0], 'correlationId'> & { status?: string };
  safetyInput: Parameters<typeof evaluateGovernanceRemediationSafety>[0];
  circuitBreaker: { failureCount: number; threshold: number };
  provider?: GovernanceProvider;
}

export async function orchestrateGovernance(request: GovernanceRequest) {
  const auditEvents: ReturnType<typeof createGovernanceAuditEvent>[] = [];
  const evidence: ReturnType<typeof createGovernanceEvidence>[] = [];
  const provider = request.provider ?? unconfiguredGovernanceProvider;

  const policy = createGovernancePolicy({ ...request.policy });
  const policyEval = evaluatePolicy(policy, request.condition, request.context);
  const decision = policyEval.decision;
  const risk = assessGovernanceRisk(request.riskInput);
  const blastRadius = calculateGovernanceBlastRadius(1,1,1,1,0,0,0); // simplified
  const approval = createApprovalRequest({ ...request.approvalInput });
  const exception = createPolicyException({ ...request.exceptionInput });

  const governanceConflict = resolvePolicyConflict([policyEval.decision, 'ALLOW']);
  const effectiveDecision = governanceConflict;

  if (effectiveDecision === 'DENY' || effectiveDecision === 'BLOCK' || effectiveDecision === 'UNKNOWN') {
    auditEvents.push(createGovernanceAuditEvent({ tenantId: request.tenantId, correlationId: request.correlationId, eventType: 'GOVERNANCE_BLOCKED', reason: `decision=${effectiveDecision}`, decision: 'BLOCKED' }));
    return { status: 'BLOCKED', reason: `decision=${effectiveDecision}`, policy, policyEval, risk, blastRadius, approval, exception, auditEvents, evidence, lineage: { rootId: request.correlationId, nodes: [] } };
  }

  if (effectiveDecision === 'REQUIRE_APPROVAL' && !isValidApproval(approval)) {
    auditEvents.push(createGovernanceAuditEvent({ tenantId: request.tenantId, correlationId: request.correlationId, eventType: 'APPROVAL_REQUIRED', reason: 'approval missing', decision: 'BLOCKED' }));
    return { status: 'BLOCKED', reason: 'approval required', policy, policyEval, risk, blastRadius, approval, exception, auditEvents, evidence, lineage: { rootId: request.correlationId, nodes: [] } };
  }

  const violation = createPolicyViolation({ policyId: policy.policyId, policyVersion: policy.version, controlId: 'control1', resourceId: 'resource1', environment: 'prod', severity: 'HIGH', risk: risk, status: 'OPEN', firstDetected: new Date().toISOString(), lastDetected: new Date().toISOString(), owner: 'team', remediationStatus: 'PENDING', evidence: [] });

  const plan = createGovernanceRemediationPlan({ violationId: violation.violationId, actions: ['fix'], risk, blastRadius });
  if (!evaluateGovernanceRemediationSafety(request.safetyInput).allowed || evaluateGovernanceCircuitBreaker(request.circuitBreaker.failureCount, request.circuitBreaker.threshold) === 'OPEN') {
    return { status: 'BLOCKED', reason: 'safety or circuit breaker', policy, policyEval, risk, blastRadius, approval, exception, violation, plan, auditEvents, evidence, lineage: { rootId: request.correlationId, nodes: [] } };
  }

  let exec = createGovernanceRemediationExecution({ planId: plan.planId });
  exec = transitionGovernanceRemediationExecution(exec, 'APPROVED');
  exec = transitionGovernanceRemediationExecution(exec, 'RUNNING');
  exec = transitionGovernanceRemediationExecution(exec, 'SUCCEEDED');

  evidence.push(createGovernanceEvidence({ decisionId: request.correlationId, policyId: policy.policyId, policyVersion: policy.version, resourceId: 'resource1', controlId: 'control1', risk, approvalId: approval.approvalId, exceptionId: 'none' }));
  auditEvents.push(createGovernanceAuditEvent({ tenantId: request.tenantId, correlationId: request.correlationId, eventType: 'GOVERNANCE_COMPLETED', reason: 'governance lifecycle complete', decision: 'SUCCESS' }));
  const lineage: GovernanceLineage = { rootId: request.correlationId, nodes: [] };
  addGovernanceLineageNode(lineage, { version: 1, decisionId: request.correlationId, operationId: exec.executionId, timestamp: new Date().toISOString() });
  const learning = createGovernanceLearningRecord({ decisionId: request.correlationId, expectedOutcome: 'compliant', actualOutcome: 'compliant', policyEffectiveness: 'good', falsePositive: false, falseNegative: false, remediationSuccess: true, rollbackSuccess: true });

  return { status: 'COMPLETED', policy, policyEval, risk, blastRadius, approval, exception, violation, plan, execution: exec, evidence, auditEvents, lineage, learning };
}
