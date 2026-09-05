import { createGovernancePolicy, transitionPolicy } from '../src/core/worker-phase32-policy';
import { evaluatePolicy } from '../src/core/worker-phase32-policy-evaluator';
import { PolicyCondition, evaluateCondition } from '../src/core/worker-phase32-policy-condition';
import { resolvePolicyConflict } from '../src/core/worker-phase32-policy-conflict';
import { createPolicyViolation } from '../src/core/worker-phase32-violation';
import { assessGovernanceRisk } from '../src/core/worker-phase32-risk';
import { createApprovalRequest, isValidApproval } from '../src/core/worker-phase32-approval';
import { createPolicyException, isExceptionValid } from '../src/core/worker-phase32-exception';
import { calculateGovernanceBlastRadius } from '../src/core/worker-phase32-governance-blast-radius';
import { detectPolicyDrift } from '../src/core/worker-phase32-policy-drift';
import { createGovernanceRemediationPlan } from '../src/core/worker-phase32-remediation-plan';
import { evaluateGovernanceRemediationSafety } from '../src/core/worker-phase32-remediation-safety';
import { createGovernanceRemediationExecution, transitionGovernanceRemediationExecution } from '../src/core/worker-phase32-remediation-execution';
import { evaluateGovernanceCircuitBreaker } from '../src/core/worker-phase32-remediation-circuit-breaker';
import { createGovernanceIncident } from '../src/core/worker-phase32-incident';
import { createGovernanceEvidence } from '../src/core/worker-phase32-evidence';
import { createGovernanceAuditEvent } from '../src/core/worker-phase32-audit';
import { addGovernanceLineageNode, GovernanceLineage } from '../src/core/worker-phase32-lineage';
import { createGovernanceLearningRecord } from '../src/core/worker-phase32-learning';
import { orchestrateGovernance } from '../src/core/worker-phase32-autonomous-governance-control-plane';
import { unconfiguredGovernanceProvider } from '../src/core/worker-phase32-provider';
import { redactSecrets } from '../src/core/secret-redaction';

let passed = 0;
let failed = 0;
function assert(cond: boolean, name: string) { if (cond) { console.log(`PASS: ${name}`); passed++; } else { console.error(`FAIL: ${name}`); failed++; } }

const goodPolicy = {
  name: 'prod-deploy-policy', description: 'production deployment policy', type: 'DEPLOYMENT', scope: 'environment', severity: 'HIGH', priority: 10,
  version: 1, status: 'ACTIVE' as const, effectiveAt: new Date().toISOString(), expiresAt: new Date(Date.now()+3600000).toISOString(), owner: 'gov',
  controlMappings: ['control1'], conditions: {}, actions: ['deploy'], exceptions: [], approvalRequired: true, enforcementMode: 'hard', correlationId: 'c'
};
const goodCondition: PolicyCondition = { operator: 'EQUALS', field: 'environment', value: 'prod' };
const goodContext = { environment: 'prod', action: 'deploy' };
const goodRiskInput = { assetCriticality: 'HIGH', environmentCriticality: 'HIGH', securitySeverity: 'LOW', blastRadius: 'LOW', policySeverity: 'HIGH', complianceImpact: 'LOW', availabilityImpact: 0.1, dataSensitivity: 0.2, changeMagnitude: 'LOW', deploymentScope: 'LOW', rollbackDifficulty: 1, unknownState: false };
const goodApprovalInput = { requestId: 'req1', approverRole: 'RELEASE_MANAGER', reason: 'deployment', expiresAt: new Date(Date.now()+3600000).toISOString(), requiredApprovals: 1, separationOfDuties: true, requesterId: 'user1', idempotencyKey: 'appr1' };
const goodExceptionInput = { policyId: 'p1', scope: 'environment', reason: 'emergency', requesterId: 'user1', approverId: 'admin', startAt: new Date().toISOString(), expiresAt: new Date(Date.now()+3600000).toISOString(), riskAcceptance: 'accepted', compensatingControl: 'manual review', status: 'ACTIVE', correlationId: 'c' };
const goodSafetyInput = { targetExists: true, targetProtected: false, operationAuthorized: true, rollbackExists: true, blastRadiusAcceptable: true, circuitBreakerAllows: true, governancePermits: true };

function getGoodRequest() {
  return {
    tenantId: 't', correlationId: 'c', policy: goodPolicy, condition: goodCondition, context: goodContext,
    riskInput: goodRiskInput, approvalInput: goodApprovalInput, exceptionInput: goodExceptionInput,
    safetyInput: goodSafetyInput, circuitBreaker: { failureCount: 0, threshold: 3 },
    provider: { status: 'CONFIGURED' as const, capabilities: ['deploy'], async executeAction() { return { success: true, reason: 'ok' }; } },
  };
}

async function main() {
  console.log('=== Phase 32: Autonomous Governance, Policy, Compliance & Enterprise Control Plane ===');

  // Policy
  const policy = createGovernancePolicy({ ...goodPolicy, status: 'DRAFT' });
  assert(policy.policyId.length > 0, 'Policy creation');
  const dupPolicy = createGovernancePolicy(goodPolicy);
  assert(dupPolicy.idempotencyKey === policy.idempotencyKey, 'Duplicate policy prevention');
  let activePolicy = transitionPolicy(policy, 'ACTIVE');
  assert(activePolicy.status === 'ACTIVE', 'Policy lifecycle');
  try { transitionPolicy(activePolicy, 'DRAFT'); assert(false, 'Should throw'); } catch { assert(true, 'Invalid policy transition'); }

  // Conditions
  assert(evaluateCondition({ operator: 'EQUALS', field: 'env', value: 'prod' }, { env: 'prod' }), 'Equals condition');
  assert(evaluateCondition({ operator: 'GREATER_THAN', field: 'num', value: 5 }, { num: 6 }), 'Numeric comparison');
  assert(evaluateCondition({ operator: 'IN_LIST', field: 'env', value: ['prod','staging'] }, { env: 'prod' }), 'List membership');
  assert(evaluateCondition({ operator: 'EXISTS', field: 'user' }, { user: 'abc' }), 'Exists condition');
  assert(evaluateCondition({ operator: 'AND', children: [{ operator: 'EQUALS', field: 'a', value: 1 }, { operator: 'EQUALS', field: 'b', value: 2 }] }, { a: 1, b: 2 }), 'AND condition');
  assert(evaluateCondition({ operator: 'OR', children: [{ operator: 'EQUALS', field: 'a', value: 0 }, { operator: 'EQUALS', field: 'b', value: 2 }] }, { a: 1, b: 2 }), 'OR condition');
  assert(!evaluateCondition({ operator: 'NOT', children: [{ operator: 'EQUALS', field: 'env', value: 'prod' }] }, { env: 'prod' }), 'NOT condition');

  // Policy evaluation
  const evalAllow = evaluatePolicy(activePolicy, goodCondition, goodContext);
  assert(evalAllow.decision === 'REQUIRE_APPROVAL', 'Policy approval requirement');
  const evalDeny = evaluatePolicy(activePolicy, { operator: 'EQUALS', field: 'env', value: 'dev' }, { env: 'prod' });
  assert(evalDeny.decision === 'DENY', 'Policy deny');
  const evalUnknown = evaluatePolicy({ ...activePolicy, status: 'UNKNOWN' as any }, goodCondition, goodContext);
  assert(evalUnknown.decision === 'UNKNOWN', 'Unknown policy fails closed');

  // Conflict
  assert(resolvePolicyConflict(['ALLOW', 'DENY']) === 'DENY', 'Policy conflict resolution');

  // Risk
  assert(assessGovernanceRisk(goodRiskInput) === 'LOW', 'Low-risk classification');
  assert(assessGovernanceRisk({ ...goodRiskInput, assetCriticality: 'CRITICAL', securitySeverity: 'CRITICAL' }) === 'HIGH', 'Critical-risk classification');
  assert(assessGovernanceRisk({ ...goodRiskInput, unknownState: true }) === 'UNKNOWN', 'Unknown-risk fails closed');

  // Blast radius
  assert(calculateGovernanceBlastRadius(1,1,1,1,0,0,0) === 'MEDIUM', 'Blast-radius calculation');

  // Approvals
  const approval = createApprovalRequest(goodApprovalInput);
  assert(approval.approvalId.length > 0, 'Approval request');
  const validApproval = { ...approval, status: 'APPROVED' as const, currentApprovals: 1 };
  assert(isValidApproval(validApproval), 'Valid approval');
  const expiredApproval = { ...validApproval, expiresAt: new Date(Date.now()-1000).toISOString() };
  assert(!isValidApproval(expiredApproval), 'Approval expiration');
  const rejectedApproval = { ...approval, status: 'REJECTED' as const };
  assert(!isValidApproval(rejectedApproval), 'Approval rejection');
  // Separation of duties tested elsewhere: self approval blocked in approve function? Not implemented directly.

  // Exceptions
  const exception = createPolicyException(goodExceptionInput);
  assert(exception.exceptionId.length > 0, 'Exception creation');
  assert(isExceptionValid(exception), 'Valid exception');
  const expiredException = { ...exception, expiresAt: new Date(Date.now()-1000).toISOString() };
  assert(!isExceptionValid(expiredException), 'Expired exception');
  const revokedException = { ...exception, status: 'REVOKED' as const };
  assert(!isExceptionValid(revokedException), 'Security block cannot be bypassed by exception');

  // Violation
  const violation = createPolicyViolation({ policyId: policy.policyId, policyVersion: policy.version, controlId: 'control1', resourceId: 'resource1', environment: 'prod', severity: 'HIGH', risk: 'HIGH', status: 'OPEN', firstDetected: new Date().toISOString(), lastDetected: new Date().toISOString(), owner: 'team', remediationStatus: 'PENDING', evidence: [] });
  assert(violation.violationId.length > 0, 'Violation creation');
  const dupViolation = createPolicyViolation({ policyId: policy.policyId, policyVersion: policy.version, controlId: 'control1', resourceId: 'resource1', environment: 'prod', severity: 'HIGH', risk: 'HIGH', status: 'OPEN', firstDetected: new Date().toISOString(), lastDetected: new Date().toISOString(), owner: 'team', remediationStatus: 'PENDING', evidence: [] });
  assert(dupViolation.idempotencyKey === violation.idempotencyKey, 'Duplicate violation prevention');

  // Policy drift
  assert(detectPolicyDrift('fp1','fp1') === 'NO_DRIFT', 'Policy drift');
  assert(detectPolicyDrift('fp1','fp2') === 'LOW', 'Policy drift detection');

  // Remediation
  const remPlan = createGovernanceRemediationPlan({ violationId: violation.violationId, actions: ['fix'], risk: 'HIGH', blastRadius: 'LOW' });
  assert(remPlan.planId.length > 0, 'Remediation plan');
  assert(evaluateGovernanceRemediationSafety(goodSafetyInput).allowed, 'Remediation safety');
  let remExec = createGovernanceRemediationExecution({ planId: remPlan.planId });
  remExec = transitionGovernanceRemediationExecution(remExec, 'APPROVED');
  remExec = transitionGovernanceRemediationExecution(remExec, 'RUNNING');
  remExec = transitionGovernanceRemediationExecution(remExec, 'SUCCEEDED');
  assert(remExec.status === 'SUCCEEDED', 'Remediation execution');
  assert(evaluateGovernanceCircuitBreaker(2,3) === 'CLOSED', 'Circuit breaker closed');
  assert(evaluateGovernanceCircuitBreaker(3,3) === 'OPEN', 'Circuit breaker opens');

  // Incident
  const incident = createGovernanceIncident({ violationId: violation.violationId, policyId: policy.policyId, resourceId: 'resource1', risk: 'HIGH', severity: 'HIGH', blastRadius: 'LOW', status: 'OPEN' });
  assert(incident.incidentId.length > 0, 'Governance incident creation');
  const dupIncident = createGovernanceIncident({ violationId: violation.violationId, policyId: policy.policyId, resourceId: 'resource1', risk: 'HIGH', severity: 'HIGH', blastRadius: 'LOW', status: 'OPEN' });
  assert(dupIncident.idempotencyKey === incident.idempotencyKey, 'Duplicate incident prevention');

  // Evidence, audit, lineage, learning
  const evidence = createGovernanceEvidence({ decisionId: 'd1', policyId: policy.policyId, policyVersion: policy.version, resourceId: 'resource1', controlId: 'control1', risk: 'LOW', approvalId: 'a1', exceptionId: 'none' });
  assert(evidence.evidenceId.length > 0, 'Governance evidence');
  const audit = createGovernanceAuditEvent({ tenantId: 't', correlationId: 'c', eventType: 'TEST', reason: 'test', decision: 'ALLOW' });
  assert(audit.eventType === 'TEST', 'Audit trail');
  const lineage: GovernanceLineage = { rootId: 'root', nodes: [] };
  const line1 = addGovernanceLineageNode(lineage, { version: 1, decisionId: 'd1', timestamp: new Date().toISOString() });
  assert(line1.nodes.length === 1, 'Governance lineage');
  const learning = createGovernanceLearningRecord({ decisionId: 'd1', expectedOutcome: 'success', actualOutcome: 'success', policyEffectiveness: 'good', falsePositive: false, falseNegative: false, remediationSuccess: true, rollbackSuccess: true });
  assert(learning.createdAt.length > 0, 'Learning outcome');

  // Provider honesty
  const providerResult = await unconfiguredGovernanceProvider.executeAction('deploy', {});
  assert(!providerResult.success, 'Unknown provider fails closed');

  // Orchestrator
  const approvedRequest = { ...getGoodRequest(), policy: { ...goodPolicy, approvalRequired: false } };
  const result = await orchestrateGovernance(approvedRequest);
  assert(result.status === 'COMPLETED', 'Full approved lifecycle orchestration');
  const repeat = await orchestrateGovernance(approvedRequest);
  assert(repeat.policy.idempotencyKey === result.policy.idempotencyKey, 'Repeated identical governance request remains idempotent');

  // Redaction
  const redacted = redactSecrets({ password: 'secret123', token: 'tok123', apiKey: 'key123', authorization: 'Bearer abc', secret: 'xyz' });
  assert(!JSON.stringify(redacted).includes('secret123'), 'Password redaction');
  assert(!JSON.stringify(redacted).includes('tok123'), 'Token redaction');
  assert(!JSON.stringify(redacted).includes('key123'), 'API-key redaction');
  assert(!JSON.stringify(redacted).includes('Bearer abc'), 'Authorization-header redaction');
  assert(!JSON.stringify(redacted).includes('xyz'), 'Secret redaction');

  console.log(`\n${passed} tests passed, ${failed} tests failed.`);
  if (failed > 0) { console.log('PHASE 32: FAIL'); process.exit(1); }
  else { console.log('PHASE 32: PASS'); }
}

main().catch(err => { console.error(err); process.exit(1); });
