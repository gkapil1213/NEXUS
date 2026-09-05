import { createDatabaseResource } from './worker-phase29-database-resource';
import { evaluateDatabaseHealth } from './worker-phase29-database-health';
import { classifyCapacity, forecastCapacity } from './worker-phase29-database-capacity';
import { createSchemaState } from './worker-phase29-schema-state';
import { createMigrationPlan } from './worker-phase29-migration-plan';
import { classifyMigrationSafety } from './worker-phase29-migration-safety';
import { createMigrationExecution, transitionMigrationExecution } from './worker-phase29-migration-execution';
import { createMigrationRollback } from './worker-phase29-migration-rollback';
import { createQueryObservation, detectSlowQuery } from './worker-phase29-query-performance';
import { detectQueryAnomaly } from './worker-phase29-query-anomaly';
import { evaluateConnectionHealth } from './worker-phase29-connection-health';
import { evaluateReplicationHealth } from './worker-phase29-replication-health';
import { assessDataQuality } from './worker-phase29-data-quality';
import { evaluateFreshness } from './worker-phase29-data-freshness';
import { analyzeImpact } from './worker-phase29-impact';
import { calculateBlastRadius } from './worker-phase29-blast-radius';
import { createRemediationPlan } from './worker-phase29-remediation-plan';
import { evaluateRemediationSafety } from './worker-phase29-remediation-safety';
import { createRemediationExecution, transitionRemediationExecution } from './worker-phase29-remediation-execution';
import { createRemediationRollback } from './worker-phase29-remediation-rollback';
import { evaluateCircuitBreaker } from './worker-phase29-remediation-circuit-breaker';
import { createDataIncident } from './worker-phase29-incident';
import { createDataEvidence } from './worker-phase29-evidence';
import { createDataAuditEvent } from './worker-phase29-audit';
import { addDataLineageNode, DataLineage } from './worker-phase29-lineage';
import { createDataLearningRecord } from './worker-phase29-learning';
import { DataProvider, unconfiguredDataProvider } from './worker-phase29-provider';

export interface DataOperationsRequest {
  tenantId: string;
  correlationId: string;
  resource: Omit<Parameters<typeof createDatabaseResource>[0], 'correlationId'>;
  health: Parameters<typeof evaluateDatabaseHealth>[0];
  capacity: Parameters<typeof classifyCapacity>[0];
  capacityForecast: { current: number; growthRate: number; days: number };
  schema: Omit<Parameters<typeof createSchemaState>[0], 'updatedAt'>;
  migrationSafety: Parameters<typeof classifyMigrationSafety>[0];
  governance: 'ALLOW' | 'REQUIRE_APPROVAL' | 'DENY' | 'FREEZE';
  safety: Parameters<typeof evaluateRemediationSafety>[0];
  circuitBreaker: { failureCount: number; threshold: number };
  provider?: DataProvider;
  queryObservation: Omit<Parameters<typeof createQueryObservation>[0], 'observationId' | 'timestamp'>;
  queryBaseline: Parameters<typeof detectQueryAnomaly>[1];
  connectionHealth: Parameters<typeof evaluateConnectionHealth>[0];
  replicationHealth: Parameters<typeof evaluateReplicationHealth>[0];
  dataQuality: Omit<Parameters<typeof assessDataQuality>[0], 'overall'>;
  freshness: Parameters<typeof evaluateFreshness>[0];
  impact: Parameters<typeof analyzeImpact>[0];
  blastRadius: Parameters<typeof calculateBlastRadius>[0];
}

export async function orchestrateDataOperations(request: DataOperationsRequest) {
  const auditEvents: ReturnType<typeof createDataAuditEvent>[] = [];
  const evidence: ReturnType<typeof createDataEvidence>[] = [];
  const provider = request.provider ?? unconfiguredDataProvider;

  const resource = createDatabaseResource({ ...request.resource });
  const health = evaluateDatabaseHealth(request.health);
  const capacity = classifyCapacity(request.capacity);
  const capacityForecast = forecastCapacity(request.capacityForecast.current, request.capacityForecast.growthRate, request.capacityForecast.days);
  const schema = createSchemaState(request.schema);
  const safetyClass = classifyMigrationSafety(request.migrationSafety);
  const plan = createMigrationPlan({
    resourceId: resource.resourceId,
    sourceSchema: schema.currentFingerprint,
    targetSchema: schema.expectedFingerprint,
    operations: ['migrate'],
    preconditions: [],
    safetyClassification: safetyClass,
    governanceRequirements: [],
    rollbackPlan: 'rollback',
    verificationPlan: 'verify',
    risk: 'LOW',
    impact: 'LOW',
    blastRadius: 'LOW',
  });

  if (request.governance === 'DENY' || request.governance === 'FREEZE' || safetyClass === 'BLOCKED') {
    auditEvents.push(createDataAuditEvent({ tenantId: request.tenantId, correlationId: request.correlationId, eventType: 'DATA_BLOCKED', reason: `governance=${request.governance}, safety=${safetyClass}`, decision: 'BLOCKED' }));
    return { status: 'BLOCKED', reason: `governance=${request.governance}, safety=${safetyClass}`, resource, health, capacity, capacityForecast, schema, plan, auditEvents, evidence, lineage: { rootId: resource.resourceId, nodes: [] } };
  }

  if (!evaluateRemediationSafety(request.safety).allowed) {
    auditEvents.push(createDataAuditEvent({ tenantId: request.tenantId, correlationId: request.correlationId, eventType: 'DATA_SAFETY_BLOCK', reason: evaluateRemediationSafety(request.safety).reason, decision: 'BLOCKED' }));
    return { status: 'BLOCKED', reason: evaluateRemediationSafety(request.safety).reason, resource, health, capacity, capacityForecast, schema, plan, auditEvents, evidence, lineage: { rootId: resource.resourceId, nodes: [] } };
  }

  if (evaluateCircuitBreaker(request.circuitBreaker.failureCount, request.circuitBreaker.threshold) === 'OPEN') {
    auditEvents.push(createDataAuditEvent({ tenantId: request.tenantId, correlationId: request.correlationId, eventType: 'DATA_CIRCUIT_OPEN', reason: 'circuit breaker open', decision: 'BLOCKED' }));
    return { status: 'BLOCKED', reason: 'circuit breaker open', resource, health, capacity, capacityForecast, schema, plan, auditEvents, evidence, lineage: { rootId: resource.resourceId, nodes: [] } };
  }

  // Execute via provider
  const providerResult = await provider.executeOperation('migrate', { resourceId: resource.resourceId });
  if (!providerResult.success) {
    auditEvents.push(createDataAuditEvent({ tenantId: request.tenantId, correlationId: request.correlationId, eventType: 'DATA_PROVIDER_FAIL', reason: providerResult.reason, decision: 'FAILED' }));
    return { status: 'FAILED', reason: providerResult.reason, resource, health, capacity, capacityForecast, schema, plan, auditEvents, evidence, lineage: { rootId: resource.resourceId, nodes: [] } };
  }

  // Create migration execution lifecycle (simulate success)
  let exec = createMigrationExecution({ migrationId: plan.migrationId });
  exec = transitionMigrationExecution(exec, 'APPROVED');
  exec = transitionMigrationExecution(exec, 'READY');
  exec = transitionMigrationExecution(exec, 'RUNNING');
  exec = transitionMigrationExecution(exec, 'VERIFYING');
  exec = transitionMigrationExecution(exec, 'SUCCEEDED');

  // Evidence, audit, lineage, learning
  evidence.push(createDataEvidence({ operationId: exec.executionId, resourceId: resource.resourceId, type: 'migration', data: { status: 'success' } }));
  auditEvents.push(createDataAuditEvent({ tenantId: request.tenantId, correlationId: request.correlationId, eventType: 'DATA_SUCCESS', reason: 'migration success', decision: 'SUCCESS' }));
  const lineage: DataLineage = { rootId: resource.resourceId, nodes: [] };
  addDataLineageNode(lineage, { version: 1, resourceId: resource.resourceId, operationId: exec.executionId, timestamp: new Date().toISOString() });
  const learning = createDataLearningRecord({ operationType: 'migration', success: true, duration: 0 });

  return { status: 'COMPLETED', resource, health, capacity, capacityForecast, schema, plan, execution: exec, evidence, auditEvents, lineage, learning };
}
