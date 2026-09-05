import { createGovernedResource } from '../src/core/worker-phase33-resource';
import { createResourceOwnership, isOrphan } from '../src/core/worker-phase33-resource-ownership';
import { classifyResource } from '../src/core/worker-phase33-resource-classification';
import { createCostObservation, hasCostData } from '../src/core/worker-phase33-cost-observation';
import { detectCostAnomaly } from '../src/core/worker-phase33-cost-anomaly';
import { evaluateBudget } from '../src/core/worker-phase33-budget';
import { evaluateFinOps } from '../src/core/worker-phase33-finops';
import { createOptimizationOpportunity } from '../src/core/worker-phase33-optimization-opportunity';
import { evaluatePolicy } from '../src/core/worker-phase33-policy-evaluation';
import { createComplianceFinding } from '../src/core/worker-phase33-compliance';
import { createGovernanceException, isExceptionActive } from '../src/core/worker-phase33-exception';
import { createGovernanceFreeze, isFreezeActive } from '../src/core/worker-phase33-governance-freeze';
import { calculateBlastRadius } from '../src/core/worker-phase33-blast-radius';
import { assessRisk } from '../src/core/worker-phase33-risk';
import { evaluateSafety } from '../src/core/worker-phase33-safety';
import { createChangePlan } from '../src/core/worker-phase33-change-plan';
import { createRemediationPlan } from '../src/core/worker-phase33-remediation-plan';
import { createRemediationExecution, transitionRemediationExecution } from '../src/core/worker-phase33-remediation-execution';
import { verifyRemediation } from '../src/core/worker-phase33-remediation-verification';
import { createRemediationRollback } from '../src/core/worker-phase33-remediation-rollback';
import { evaluateCircuitBreaker } from '../src/core/worker-phase33-remediation-circuit-breaker';
import { createIncident } from '../src/core/worker-phase33-incident';
import { determineEscalation } from '../src/core/worker-phase33-escalation';
import { createEvidence } from '../src/core/worker-phase33-evidence';
import { createAuditEvent } from '../src/core/worker-phase33-audit';
import { addLineageNode, Lineage } from '../src/core/worker-phase33-lineage';
import { createLearningRecord } from '../src/core/worker-phase33-learning';
import { orchestrateResourceGovernance } from '../src/core/worker-phase33-autonomous-resource-governance-control-plane';
import { unconfiguredProvider } from '../src/core/worker-phase33-provider';
import { redactSecrets } from '../src/core/secret-redaction';

let passed = 0;
let failed = 0;
function assert(cond: boolean, name: string) { if (cond) { console.log(`PASS: ${name}`); passed++; } else { console.error(`FAIL: ${name}`); failed++; } }

const goodResource = {
  provider: 'aws', account: '123', environment: 'prod', region: 'us-east-1', type: 'compute', owner: 'team', team: 'platform',
  application: 'app1', lifecycleState: 'RUNNING', tags: {}, configurationFingerprint: 'cfg1', costMetadata: {}, securityMetadata: {}, complianceMetadata: {}, correlationId: 'c'
};
const goodPolicyInput = { resourceType: 'compute', environment: 'prod', criticality: 'HIGH', securityPolicy: 'ALLOW', costPolicy: 'ALLOW', compliancePolicy: 'ALLOW', productionProtection: false };
const goodRiskInput = { criticality: 'HIGH', blastRadius: 'LOW', securitySeverity: 'LOW', policySeverity: 'LOW', unknownState: false };
const goodSafetyInput = { resourceProtection: false, environmentProtection: false, dependencyRisk: false, blastRadiusAcceptable: true, rollbackAvailable: true, providerAvailable: true, policyAllows: true, approvalValid: true, circuitBreakerAllows: true, freezeActive: false };
const goodProvider = { status: 'CONFIGURED' as const, capabilities: ['resize'], async executeAction() { return { success: true, reason: 'ok' }; } };

function getGoodRequest() {
  return {
    tenantId: 't', correlationId: 'c',
    resource: goodResource,
    policyInput: goodPolicyInput,
    riskInput: goodRiskInput,
    blastRadiusInput: { affectedResources: 1, dependentResources: 0, environments: 1, fleets: 1, securityImpact: 0, complianceImpact: 0 },
    safetyInput: goodSafetyInput,
    circuitBreaker: { failureCount: 0, threshold: 3 },
    provider: goodProvider,
    opportunityInput: { type: 'RIGHTSIZE', reason: 'low utilization', estimatedSavings: 10, confidence: 0.8, blastRadius: 'LOW', risk: 'LOW', governanceRequirement: 'ALLOW', approvalRequired: false, rollbackPossible: true, correlationId: 'c' },
  };
}

async function main() {
  console.log('=== Phase 33: Autonomous Resource Governance, FinOps & Continuous Policy Enforcement ===');

  // Resource
  const resource = createGovernedResource(goodResource);
  assert(resource.resourceId.length > 0, 'Resource creation');
  const dupResource = createGovernedResource(goodResource);
  assert(dupResource.idempotencyKey === resource.idempotencyKey, 'Duplicate resource prevention');
  assert(createResourceOwnership({ resourceId: resource.resourceId, owner: '', teamOwner: '', serviceOwner: '', costOwner: '', securityOwner: '', complianceOwner: '' }).owner === '', 'Resource ownership');
  assert(isOrphan(createResourceOwnership({ resourceId: resource.resourceId, owner: '', teamOwner: 'team', serviceOwner: 'svc', costOwner: 'team', securityOwner: 'team', complianceOwner: 'team' })), 'Orphan resource detection');
  assert(classifyResource({ lifecycleState: 'RUNNING', criticality: 'CRITICAL', environment: 'prod' }) === 'PROTECTED', 'Resource classification');

  // Cost
  const costObs = createCostObservation({ resourceId: resource.resourceId, date: '2025-01-01', cost: 100, currency: 'USD', provider: 'aws' });
  assert(hasCostData(costObs), 'Cost observation');
  assert(!hasCostData({ ...costObs, cost: null }), 'Missing cost handling');
  assert(detectCostAnomaly({ expectedCost: 100, actualCost: 200, threshold: 0.2 }).detected, 'Cost anomaly detection');
  const budget = evaluateBudget({ amount: 1000, consumed: 900, forecast: 1000, threshold: 0.8 });
  assert(budget.state === 'AT_RISK', 'Budget threshold/breach');
  assert(evaluateFinOps({ currentCost: 100, projectedCost: 1200, budget: 1000, utilization: 0.1 }).state === 'BREACHED', 'FinOps');

  // Optimization
  const opportunity = createOptimizationOpportunity({ ...getGoodRequest().opportunityInput, resourceId: resource.resourceId, correlationId: 'c' });
  assert(opportunity.opportunityId.length > 0, 'Optimization opportunity');
  const dupOpportunity = createOptimizationOpportunity({ ...getGoodRequest().opportunityInput, resourceId: resource.resourceId, correlationId: 'c' });
  assert(dupOpportunity.idempotencyKey === opportunity.idempotencyKey, 'Duplicate optimization prevention');

  // Policy/Compliance/Exception/Freeze
  assert(evaluatePolicy(goodPolicyInput) === 'ALLOW', 'Policy evaluation/allow');
  assert(evaluatePolicy({ ...goodPolicyInput, securityPolicy: 'DENY' }) === 'DENY', 'Policy denial');
  assert(evaluatePolicy({ ...goodPolicyInput, environment: 'production', productionProtection: true }) === 'ALLOW_WITH_APPROVAL', 'Policy approval requirement');
  const finding = createComplianceFinding({ resourceId: resource.resourceId, controlId: 'c1', status: 'NON_COMPLIANT', severity: 'HIGH', reason: 'test' });
  assert(finding.findingId.length > 0, 'Compliance finding');
  const exception = createGovernanceException({ policyId: 'p1', resourceId: resource.resourceId, reason: 'test', requesterId: 'u1', approverId: 'a1', startTime: new Date().toISOString(), expirationTime: new Date(Date.now()+3600000).toISOString(), status: 'ACTIVE' });
  assert(isExceptionActive(exception), 'Exception approval/active');
  const expiredException = { ...exception, expirationTime: new Date(Date.now()-1000).toISOString() };
  assert(!isExceptionActive(expiredException), 'Exception expiration');
  const freeze = createGovernanceFreeze('prod', 'test', 'admin', new Date(Date.now()+3600000).toISOString());
  assert(isFreezeActive(freeze), 'Governance freeze');
  assert(!isFreezeActive({ ...freeze, expiresAt: new Date(Date.now()-1000).toISOString() }), 'Expired freeze');

  // Blast radius/risk/safety
  assert(calculateBlastRadius(1,0,1,1,0,0) === 'MEDIUM', 'Blast-radius calculation');
  assert(assessRisk(goodRiskInput) === 'LOW', 'Risk evaluation');
  assert(evaluateSafety(goodSafetyInput).allowed, 'Safety allow');
  assert(!evaluateSafety({ ...goodSafetyInput, resourceProtection: true }).allowed, 'Safety block');

  // Change/remediation
  const changePlan = createChangePlan({ action: 'RIGHTSIZE', target: resource.resourceId, reason: 'test', expectedResult: 'ok', policyDecision: 'ALLOW', approvalRequired: false, blastRadius: 'LOW', risk: 'LOW', rollbackStrategy: 'restore', verificationStrategy: 'check' });
  assert(changePlan.planId.length > 0, 'Change plan creation');
  const remPlan = createRemediationPlan({ opportunityId: opportunity.opportunityId, actions: ['resize'], risk: 'LOW', blastRadius: 'LOW' });
  assert(remPlan.planId.length > 0, 'Remediation plan');
  let exec = createRemediationExecution({ planId: remPlan.planId });
  exec = transitionRemediationExecution(exec, 'APPROVED');
  exec = transitionRemediationExecution(exec, 'RUNNING');
  exec = transitionRemediationExecution(exec, 'SUCCEEDED');
  assert(exec.status === 'SUCCEEDED', 'Remediation execution');
  try { transitionRemediationExecution(exec, 'RUNNING'); assert(false, 'Should throw'); } catch { assert(true, 'Invalid transition rejection'); }
  assert(verifyRemediation(true,true,true,true,true) === 'VERIFIED', 'Verification success');
  assert(verifyRemediation(false,true,true,true,true) === 'FAILED', 'Verification failure');

  // Rollback/circuit breaker/incident/escalation
  const rollback = createRemediationRollback(exec.executionId);
  assert(rollback.rollbackId.length > 0, 'Rollback creation');
  assert(createRemediationRollback(exec.executionId).idempotencyKey === rollback.idempotencyKey, 'Rollback idempotency');
  assert(evaluateCircuitBreaker(2,3) === 'CLOSED', 'Circuit breaker closed');
  assert(evaluateCircuitBreaker(3,3) === 'OPEN', 'Circuit breaker opens');
  const incident = createIncident({ resourceId: resource.resourceId, type: 'budget_breach', severity: 'HIGH', status: 'OPEN' });
  assert(incident.incidentId.length > 0, 'Incident creation');
  const dupIncident = createIncident({ resourceId: resource.resourceId, type: 'budget_breach', severity: 'HIGH', status: 'OPEN' });
  assert(dupIncident.idempotencyKey === incident.idempotencyKey, 'Duplicate incident prevention');
  assert(determineEscalation('CRITICAL', 'HIGH', 'prod', 'HIGH', false) === 'CRITICAL', 'Escalation');

  // Evidence/audit/lineage/learning
  const evidence = createEvidence({ resourceId: resource.resourceId, type: 'test', data: {} });
  assert(evidence.evidenceId.length > 0, 'Evidence generation');
  const audit = createAuditEvent({ tenantId: 't', correlationId: 'c', eventType: 'TEST', reason: 'test', decision: 'ALLOW' });
  assert(audit.eventType === 'TEST', 'Audit trail');
  const lineage: Lineage = { rootId: resource.resourceId, nodes: [] };
  const line1 = addLineageNode(lineage, { version: 1, resourceId: resource.resourceId, timestamp: new Date().toISOString() });
  assert(line1.nodes.length === 1, 'Lineage');
  const learning = createLearningRecord({ resourceId: resource.resourceId, outcome: 'VERIFIED', success: true });
  assert(learning.createdAt.length > 0, 'Learning outcome');

  // Provider honesty
  const providerResult = await unconfiguredProvider.executeAction('resize', {});
  assert(!providerResult.success, 'Unknown provider fails closed');

  // Orchestrator
  const result = await orchestrateResourceGovernance(getGoodRequest());
  assert(result.status === 'COMPLETED', 'Full approved lifecycle orchestration');
  const repeat = await orchestrateResourceGovernance(getGoodRequest());
  assert(repeat.resource.idempotencyKey === result.resource.idempotencyKey, 'Repeated identical resource request remains idempotent');

  // Redaction
  const redacted = redactSecrets({ password: 'secret123', token: 'tok123', apiKey: 'key123', authorization: 'Bearer abc', secret: 'xyz' });
  assert(!JSON.stringify(redacted).includes('secret123'), 'Password redaction');
  assert(!JSON.stringify(redacted).includes('tok123'), 'Token redaction');
  assert(!JSON.stringify(redacted).includes('key123'), 'API-key redaction');
  assert(!JSON.stringify(redacted).includes('Bearer abc'), 'Authorization-header redaction');
  assert(!JSON.stringify(redacted).includes('xyz'), 'Secret redaction');

  console.log(`\n${passed} tests passed, ${failed} tests failed.`);
  if (failed > 0) { console.log('PHASE 33: FAIL'); process.exit(1); }
  else { console.log('PHASE 33: PASS'); }
}

main().catch(err => { console.error(err); process.exit(1); });
