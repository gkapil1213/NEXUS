import { createInfrastructureResource } from '../src/core/worker-phase28-infrastructure-inventory';
import { classifyCapacity } from '../src/core/worker-phase28-capacity';
import { forecastCapacity } from '../src/core/worker-phase28-capacity-forecast';
import { detectCapacityAnomaly } from '../src/core/worker-phase28-capacity-anomaly';
import { createCostObservation, hasCostData } from '../src/core/worker-phase28-cost';
import { detectCostAnomaly } from '../src/core/worker-phase28-cost-anomaly';
import { evaluateBudget } from '../src/core/worker-phase28-budget';
import { detectWaste } from '../src/core/worker-phase28-resource-waste';
import { createOptimizationOpportunity } from '../src/core/worker-phase28-optimization-opportunity';
import { createOptimizationPlan } from '../src/core/worker-phase28-optimization-plan';
import { analyzeInfrastructureImpact } from '../src/core/worker-phase28-infrastructure-impact';
import { calculateInfrastructureBlastRadius } from '../src/core/worker-phase28-infrastructure-blast-radius';
import { correlateInfrastructureChange } from '../src/core/worker-phase28-change-correlation';
import { unconfiguredInfrastructureProvider } from '../src/core/worker-phase28-provider';
import { isProviderCapable } from '../src/core/worker-phase28-provider-capability';
import { governInfrastructureAction } from '../src/core/worker-phase28-governance';
import { evaluateInfrastructureSafety } from '../src/core/worker-phase28-safety';
import { createInfrastructureExecution, transitionInfrastructureExecution } from '../src/core/worker-phase28-execution';
import { createInfrastructureHalt } from '../src/core/worker-phase28-halt';
import { createInfrastructureRollback } from '../src/core/worker-phase28-rollback';
import { evaluateRollbackSafety } from '../src/core/worker-phase28-rollback-safety';
import { verifyInfrastructureChange } from '../src/core/worker-phase28-verification';
import { evaluateInfrastructureCircuitBreaker } from '../src/core/worker-phase28-circuit-breaker';
import { createInfrastructureIncident } from '../src/core/worker-phase28-incident';
import { createInfrastructureEvidence } from '../src/core/worker-phase28-evidence';
import { createInfrastructureAuditEvent } from '../src/core/worker-phase28-audit';
import { addInfrastructureLineageNode, InfrastructureLineage } from '../src/core/worker-phase28-lineage';
import { createInfrastructureLearningRecord } from '../src/core/worker-phase28-learning';
import { orchestrateInfrastructureOperations } from '../src/core/worker-phase28-autonomous-infrastructure-control-plane';
import { redactSecrets } from '../src/core/secret-redaction';

let passed = 0;
let failed = 0;
function assert(cond: boolean, name: string) { if (cond) { console.log(`PASS: ${name}`); passed++; } else { console.error(`FAIL: ${name}`); failed++; } }

const goodResource = {
  provider: 'aws', account: '123', region: 'us-east-1', environment: 'prod', type: 'COMPUTE' as const,
  resourceName: 'i-123', lifecycleState: 'RUNNING', health: 'HEALTHY' as const, owner: 'team',
  tags: {}, dependencies: [], criticality: 'HIGH' as const, workload: 'svc1', securityClassification: 'internal',
  costCenter: 'cc1', currentCapacity: 2, allocatedCapacity: 4, utilizedCapacity: 1.5, desiredCapacity: 4,
  minCapacity: 2, maxCapacity: 8, lastObservation: new Date().toISOString(), metadata: {},
};

const goodRequest = {
  tenantId: 't', correlationId: 'c',
  resource: goodResource,
  capacityInput: { currentUtilization: 0.375, allocatedCapacity: 4, utilizedCapacity: 1.5, minUtilization: 0.2, maxUtilization: 0.8 },
  forecastInput: { currentLoad: 100, growthTrend: 0.01, horizonDays: 30, confidence: 0.8 },
  anomalyInput: { baseline: 100, observed: 100, threshold: 0.2 },
  costInput: { resourceId: 'i-123', service: 'EC2', environment: 'prod', periodStart: '2025-01-01', periodEnd: '2025-01-31', cost: 100, currency: 'USD', budget: 1000, forecastCost: 120 },
  costAnomalyInput: { expectedCost: 100, actualCost: 100, threshold: 0.2 },
  budgetInput: { total: 1000, consumed: 100, forecast: 500, threshold: 0.8 },
  wasteInput: { resourceId: 'i-123', utilization: 0.05, idleDays: 10 },
  opportunity: { type: 'RIGHTSIZE', rationale: 'low utilization', evidence: [], estimatedImpact: 'cost save', risk: 'LOW', confidence: 0.8, blastRadius: 'LOW' as const, recommendedAction: 'resize', rollbackPlan: 'restore', governanceState: 'PENDING', executionState: 'PENDING', correlationId: 'c' },
  impactInput: { affectedResources: 1, dependentResources: 0, affectedWorkloads: 1, availabilityImpact: 0.1, costImpact: 0.5, securityImpact: 0, dataImpact: 0 },
  blastRadiusInput: { dependentResources: 0, affectedWorkloads: 1, networkChange: false, databaseChange: false },
  governanceInput: { environment: 'prod', resourceCriticality: 'HIGH', operationType: 'RIGHTSIZE', blastRadius: 'LOW' as const, businessImpact: 1, securityRestriction: false, deploymentState: 'STABLE', incidentState: 'NONE', freezeState: false, approvalRequired: false, providerCapable: true, rollbackAvailable: true },
  safetyInput: { deleteCriticalResource: false, reduceBelowMinimum: false, disableRedundancy: false, modifyProtectedResource: false, criticalIncidentActive: false, securitySensitive: false, rollbackRequiredButMissing: false },
  circuitBreaker: { failureCount: 0, threshold: 3 },
  provider: { status: 'CONFIGURED' as const, capabilities: ['resize'], async executeAction() { return { success: true, reason: 'ok' }; } },
};

async function main() {
  console.log('=== Phase 28: Autonomous Cloud Infrastructure, Capacity & Cost Operations ===');

  const resource = createInfrastructureResource(goodResource);
  assert(resource.resourceId.length > 0, 'Infrastructure resource creation');
  const dupResource = createInfrastructureResource(goodResource);
  assert(dupResource.idempotencyKey === resource.idempotencyKey, 'Duplicate resource prevention');

  assert(classifyCapacity({ currentUtilization: 0.375, allocatedCapacity: 4, utilizedCapacity: 1.5, minUtilization: 0.2, maxUtilization: 0.8 }) === 'HEALTHY_CAPACITY', 'Capacity classification');
  const forecast = forecastCapacity({ currentLoad: 100, growthTrend: 0.01, horizonDays: 30, confidence: 0.8 });
  assert(forecast.expectedDemand > 100, 'Capacity forecast');
  assert(forecast.confidence === 0.8, 'Forecast uncertainty');
  const anomaly = detectCapacityAnomaly({ baseline: 100, observed: 200, threshold: 0.2 });
  assert(anomaly.detected, 'Capacity anomaly detection');

  const cost = createCostObservation({ resourceId: 'i-123', service: 'EC2', environment: 'prod', periodStart: '2025-01-01', periodEnd: '2025-01-31', cost: 100, currency: 'USD', budget: 1000, forecastCost: 120 });
  assert(hasCostData(cost), 'Cost observation');
  assert(!hasCostData({ ...cost, cost: null }), 'Missing cost data');
  assert(detectCostAnomaly({ expectedCost: 100, actualCost: 200, threshold: 0.2 }).detected, 'Cost anomaly detection');
  assert(evaluateBudget({ total: 1000, consumed: 900, forecast: 1000, threshold: 0.8 }).state === 'AT_RISK', 'Budget threshold');
  const waste = detectWaste({ resourceId: 'i-123', utilization: 0.05, idleDays: 10 });
  assert(waste !== null, 'Resource waste detection');

  const opportunity = createOptimizationOpportunity({ ...goodRequest.opportunity, resourceId: resource.resourceId, correlationId: 'c' });
  assert(opportunity.opportunityId.length > 0, 'Optimization opportunity');
  const dupOpportunity = createOptimizationOpportunity({ ...goodRequest.opportunity, resourceId: resource.resourceId, correlationId: 'c' });
  assert(dupOpportunity.idempotencyKey === opportunity.idempotencyKey, 'Duplicate opportunity prevention');

  const plan = createOptimizationPlan({ opportunityId: opportunity.opportunityId, actions: ['resize'], estimatedCostSaving: 50, risk: 'LOW' });
  assert(plan.planId.length > 0, 'Optimization plan');

  assert(analyzeInfrastructureImpact(goodRequest.impactInput).impact === 'LOW', 'Impact analysis');
  assert(calculateInfrastructureBlastRadius(0, 1, false, false) === 'LOW', 'Blast radius');

  assert(governInfrastructureAction(goodRequest.governanceInput) === 'ALLOW', 'Governance allow');
  assert(governInfrastructureAction({ ...goodRequest.governanceInput, approvalRequired: true }) === 'ALLOW_WITH_APPROVAL', 'Governance approval requirement');
  assert(governInfrastructureAction({ ...goodRequest.governanceInput, freezeState: true }) === 'BLOCKED', 'Governance denial/freeze');
  assert(governInfrastructureAction({ ...goodRequest.governanceInput, providerCapable: false }) === 'UNCONFIGURED', 'Unknown provider fails closed');
  assert(!isProviderCapable(unconfiguredInfrastructureProvider, 'resize'), 'Unavailable capability');

  assert(evaluateInfrastructureSafety(goodRequest.safetyInput).allowed, 'Safety allows');
  assert(!evaluateInfrastructureSafety({ ...goodRequest.safetyInput, deleteCriticalResource: true }).allowed, 'Safety blocks protected resource');

  let exec = createInfrastructureExecution({ planId: plan.planId });
  assert(exec.executionId.length > 0, 'Execution creation');
  const dupExec = createInfrastructureExecution({ planId: plan.planId });
  assert(dupExec.idempotencyKey === exec.idempotencyKey, 'Duplicate execution prevention');
  exec = transitionInfrastructureExecution(exec, 'APPROVED');
  exec = transitionInfrastructureExecution(exec, 'EXECUTING');
  exec = transitionInfrastructureExecution(exec, 'SUCCEEDED');
  assert(exec.status === 'SUCCEEDED', 'Provider execution success');
  try { transitionInfrastructureExecution(exec, 'RUNNING' as any); assert(false, 'Should throw'); } catch { assert(true, 'Invalid transition rejected'); }

  const halt = createInfrastructureHalt(exec.executionId, 'test');
  assert(halt.haltId.length > 0, 'Execution halt');
  const rollback = createInfrastructureRollback(exec.executionId);
  assert(rollback.rollbackId.length > 0, 'Rollback creation');
  assert(evaluateRollbackSafety({ previousStateExists: true, rollbackTargetAvailable: true, governanceAllows: true, blastRadiusAcceptable: true }).allowed, 'Rollback safety');
  assert(!evaluateRollbackSafety({ previousStateExists: false, rollbackTargetAvailable: true, governanceAllows: true, blastRadiusAcceptable: true }).allowed, 'Rollback failure');

  assert(evaluateInfrastructureCircuitBreaker(2, 3) === 'CLOSED', 'Circuit breaker closed');
  assert(evaluateInfrastructureCircuitBreaker(3, 3) === 'OPEN', 'Circuit breaker opening');

  const incident = createInfrastructureIncident({ resourceId: resource.resourceId, changeId: 'chg1', severity: 'HIGH', status: 'OPEN' });
  assert(incident.incidentId.length > 0, 'Incident creation');
  const dupIncident = createInfrastructureIncident({ resourceId: resource.resourceId, changeId: 'chg1', severity: 'HIGH', status: 'OPEN' });
  assert(dupIncident.idempotencyKey === incident.idempotencyKey, 'Duplicate incident prevention');

  const evidence = createInfrastructureEvidence({ resourceId: resource.resourceId, type: 'observation', data: {} });
  assert(evidence.evidenceId.length > 0, 'Evidence generation');
  const audit = createInfrastructureAuditEvent({ tenantId: 't', correlationId: 'c', eventType: 'TEST', reason: 'test', decision: 'ALLOW' });
  assert(audit.eventType === 'TEST', 'Audit trail');
  const lineage: InfrastructureLineage = { rootId: resource.resourceId, nodes: [] };
  const line1 = addInfrastructureLineageNode(lineage, { version: 1, resourceId: resource.resourceId, timestamp: new Date().toISOString() });
  assert(line1.nodes.length === 1, 'Lineage');
  const learning = createInfrastructureLearningRecord({ opportunityType: 'RIGHTSIZE', success: true, duration: 0 });
  assert(learning.createdAt.length > 0, 'Learning outcome');

  const result = await orchestrateInfrastructureOperations(goodRequest);
  assert(result.status === 'COMPLETED', 'Orchestrator executes approved lifecycle');
  const repeat = await orchestrateInfrastructureOperations(goodRequest);
  assert(repeat.resource.idempotencyKey === result.resource.idempotencyKey, 'Repeated identical infrastructure request remains idempotent');

  const redacted = redactSecrets({ password: 'secret123', token: 'tok123', apiKey: 'key123', authorization: 'Bearer abc', secret: 'xyz' });
  assert(!JSON.stringify(redacted).includes('secret123'), 'Password redaction');
  assert(!JSON.stringify(redacted).includes('tok123'), 'Token redaction');
  assert(!JSON.stringify(redacted).includes('key123'), 'API key redaction');
  assert(!JSON.stringify(redacted).includes('Bearer abc'), 'Authorization header redaction');
  assert(!JSON.stringify(redacted).includes('xyz'), 'Secret redaction');

  console.log(`\n${passed} tests passed, ${failed} tests failed.`);
  if (failed > 0) { console.log('PHASE 28: FAIL'); process.exit(1); }
  else { console.log('PHASE 28: PASS'); }
}

main().catch(err => { console.error(err); process.exit(1); });
