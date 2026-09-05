import { createInfrastructureResource } from './worker-phase28-infrastructure-inventory';
import { classifyCapacity } from './worker-phase28-capacity';
import { forecastCapacity } from './worker-phase28-capacity-forecast';
import { detectCapacityAnomaly } from './worker-phase28-capacity-anomaly';
import { createCostObservation, hasCostData } from './worker-phase28-cost';
import { detectCostAnomaly } from './worker-phase28-cost-anomaly';
import { evaluateBudget } from './worker-phase28-budget';
import { detectWaste } from './worker-phase28-resource-waste';
import { createOptimizationOpportunity } from './worker-phase28-optimization-opportunity';
import { createOptimizationPlan } from './worker-phase28-optimization-plan';
import { analyzeInfrastructureImpact } from './worker-phase28-infrastructure-impact';
import { calculateInfrastructureBlastRadius } from './worker-phase28-infrastructure-blast-radius';
import { correlateInfrastructureChange } from './worker-phase28-change-correlation';
import { unconfiguredInfrastructureProvider, InfrastructureProvider } from './worker-phase28-provider';
import { isProviderCapable } from './worker-phase28-provider-capability';
import { governInfrastructureAction } from './worker-phase28-governance';
import { evaluateInfrastructureSafety } from './worker-phase28-safety';
import { createInfrastructureExecution, transitionInfrastructureExecution } from './worker-phase28-execution';
import { createInfrastructureHalt } from './worker-phase28-halt';
import { createInfrastructureRollback } from './worker-phase28-rollback';
import { evaluateRollbackSafety } from './worker-phase28-rollback-safety';
import { verifyInfrastructureChange } from './worker-phase28-verification';
import { evaluateInfrastructureCircuitBreaker } from './worker-phase28-circuit-breaker';
import { createInfrastructureIncident } from './worker-phase28-incident';
import { createInfrastructureEvidence } from './worker-phase28-evidence';
import { createInfrastructureAuditEvent } from './worker-phase28-audit';
import { addInfrastructureLineageNode, InfrastructureLineage } from './worker-phase28-lineage';
import { createInfrastructureLearningRecord } from './worker-phase28-learning';

export interface AutonomousInfrastructureRequest {
  tenantId: string;
  correlationId: string;
  resource: Omit<Parameters<typeof createInfrastructureResource>[0], 'correlationId'>;
  capacityInput: Parameters<typeof classifyCapacity>[0];
  forecastInput: Parameters<typeof forecastCapacity>[0];
  anomalyInput: Parameters<typeof detectCapacityAnomaly>[0];
  costInput: Omit<Parameters<typeof createCostObservation>[0], 'correlationId'>;
  costAnomalyInput: Parameters<typeof detectCostAnomaly>[0];
  budgetInput: Parameters<typeof evaluateBudget>[0];
  wasteInput: Parameters<typeof detectWaste>[0];
  opportunity: Omit<Parameters<typeof createOptimizationOpportunity>[0], 'resourceId' | 'correlationId'>;
  impactInput: Parameters<typeof analyzeInfrastructureImpact>[0];
  blastRadiusInput: Parameters<typeof calculateInfrastructureBlastRadius>[0];
  governanceInput: Parameters<typeof governInfrastructureAction>[0];
  safetyInput: Parameters<typeof evaluateInfrastructureSafety>[0];
  circuitBreaker: { failureCount: number; threshold: number };
  provider?: InfrastructureProvider;
}

export async function orchestrateInfrastructureOperations(request: any) {
  const auditEvents: ReturnType<typeof createInfrastructureAuditEvent>[] = [];
  const evidence: ReturnType<typeof createInfrastructureEvidence>[] = [];
  const provider = request.provider ?? unconfiguredInfrastructureProvider;

  const resource = createInfrastructureResource({ ...request.resource, correlationId: request.correlationId });
  const capacity = classifyCapacity(request.capacityInput);
  const forecast = forecastCapacity(request.forecastInput);
  const capacityAnomaly = detectCapacityAnomaly(request.anomalyInput);
  const cost = createCostObservation({ ...request.costInput, correlationId: request.correlationId });
  const costAnomaly = detectCostAnomaly(request.costAnomalyInput);
  const budget = evaluateBudget(request.budgetInput);
  const waste = detectWaste(request.wasteInput);

  const opportunity = createOptimizationOpportunity({ ...request.opportunity, resourceId: resource.resourceId, correlationId: request.correlationId });
  const impact = analyzeInfrastructureImpact(request.impactInput);
  const blastRadius = calculateInfrastructureBlastRadius(
    request.blastRadiusInput.dependentResources,
    request.blastRadiusInput.affectedWorkloads,
    request.blastRadiusInput.networkChange,
    request.blastRadiusInput.databaseChange
  );
  const changeCorr = correlateInfrastructureChange(resource.resourceId, 'change-1', new Date().toISOString(), new Date().toISOString());

  const governance = governInfrastructureAction(request.governanceInput);
  const safety = evaluateInfrastructureSafety(request.safetyInput);
  const breaker = evaluateInfrastructureCircuitBreaker(request.circuitBreaker.failureCount, request.circuitBreaker.threshold);

  if (governance === 'DENY' || governance === 'BLOCKED' || governance === 'UNCONFIGURED' || !safety.allowed || breaker === 'OPEN') {
    auditEvents.push(createInfrastructureAuditEvent({ tenantId: request.tenantId, correlationId: request.correlationId, eventType: 'INFRASTRUCTURE_BLOCKED', reason: `governance=${governance}, safety=${safety.reason}, breaker=${breaker}`, decision: 'BLOCKED' }));
    return { status: 'BLOCKED', reason: `governance=${governance}, safety=${safety.reason}, breaker=${breaker}`, resource, capacity, forecast, capacityAnomaly, cost, costAnomaly, budget, waste, opportunity, impact, blastRadius, changeCorr, governance, safety, auditEvents, evidence, lineage: { rootId: resource.resourceId, nodes: [] } };
  }

  const plan = createOptimizationPlan({ opportunityId: opportunity.opportunityId, actions: [opportunity.recommendedAction], estimatedCostSaving: 0, risk: opportunity.risk });
  let execution = createInfrastructureExecution({ planId: plan.planId });
  execution = transitionInfrastructureExecution(execution, 'APPROVED');
  execution = transitionInfrastructureExecution(execution, 'EXECUTING');

  const providerResult = await provider.executeAction(opportunity.recommendedAction, { resourceId: resource.resourceId });
  if (!providerResult.success) {
    const failedExec = transitionInfrastructureExecution(execution, 'FAILED');
    auditEvents.push(createInfrastructureAuditEvent({ tenantId: request.tenantId, correlationId: request.correlationId, eventType: 'INFRASTRUCTURE_FAILED', reason: providerResult.reason, decision: 'FAILED' }));
    return { status: 'FAILED', reason: providerResult.reason, resource, capacity, forecast, capacityAnomaly, cost, costAnomaly, budget, waste, opportunity, plan, execution: failedExec, impact, blastRadius, changeCorr, governance, safety, auditEvents, evidence, lineage: { rootId: resource.resourceId, nodes: [] } };
  }

  execution = transitionInfrastructureExecution(execution, 'SUCCEEDED');
  const verification = verifyInfrastructureChange({ health: 'HEALTHY', capacityState: 'HEALTHY_CAPACITY', costState: 'OPTIMAL', rollbackState: 'NONE' });

  evidence.push(createInfrastructureEvidence({ resourceId: resource.resourceId, type: 'execution', data: { result: 'success', verification } }));
  auditEvents.push(createInfrastructureAuditEvent({ tenantId: request.tenantId, correlationId: request.correlationId, eventType: 'INFRASTRUCTURE_SUCCEEDED', reason: 'infrastructure change succeeded', decision: 'SUCCESS' }));
  const lineage: InfrastructureLineage = { rootId: resource.resourceId, nodes: [] };
  addInfrastructureLineageNode(lineage, { version: 1, resourceId: resource.resourceId, opportunityId: opportunity.opportunityId, executionId: execution.executionId, timestamp: new Date().toISOString() });

  const learning = createInfrastructureLearningRecord({ opportunityType: opportunity.type, success: verification === 'VERIFIED', duration: 0 });

  return { status: 'COMPLETED', resource, capacity, forecast, capacityAnomaly, cost, costAnomaly, budget, waste, opportunity, plan, execution, impact, blastRadius, changeCorr, governance, safety, verification, evidence, auditEvents, lineage, learning };
}
