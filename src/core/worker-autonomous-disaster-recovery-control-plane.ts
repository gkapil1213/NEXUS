import { createRecoveryPlan, validateRecoveryPlan } from './worker-dr-recovery-plan';
import { createBackupPolicy, validateBackupPolicy } from './worker-backup-policy';
import { createBackupJob, transitionBackupJob } from './worker-backup-job';
import { createBackupArtifact } from './worker-backup-artifact';
import { verifyBackup } from './worker-backup-verification';
import { createRecoveryPoint } from './worker-recovery-point';
import { createRestoreJob, transitionRestoreJob } from './worker-restore-job';
import { verifyRestore } from './worker-restore-verification';
import { createFailoverPlan } from './worker-failover-plan';
import { createFailoverExecution, transitionFailoverExecution } from './worker-failover-execution';
import { createFailbackExecution } from './worker-failback-execution';
import { detectCycle, orderDependencies, DependencyGraph } from './worker-recovery-dependency';
import { evaluateRecoveryReadiness } from './worker-recovery-readiness';
import { evaluateObjectives } from './worker-recovery-objectives';
import { createRecoveryDrill } from './worker-recovery-drill';
import { createRecoveryIncident } from './worker-recovery-incident';
import { evaluateRecoverySafety } from './worker-recovery-safety';
import { governRecovery } from './worker-recovery-governance';
import { evaluateRecoveryCircuitBreaker } from './worker-recovery-circuit-breaker';
import { createRecoveryAuditEvent } from './worker-recovery-audit';
import { createRecoveryEvidence } from './worker-recovery-evidence';
import { addRecoveryLineageNode, RecoveryLineage } from './worker-recovery-lineage';
import { RecoveryProviderAdapter, unavailableRecoveryProvider } from './worker-recovery-adapter';

export interface AutonomousRecoveryRequest {
  tenantId: string;
  correlationId: string;
  incident: Omit<Parameters<typeof createRecoveryIncident>[0], 'correlationId'>;
  recoveryPlan: Omit<Parameters<typeof createRecoveryPlan>[0], 'correlationId'>;
  backupPolicy: Omit<Parameters<typeof createBackupPolicy>[0], 'correlationId'>;
  backupJob: Omit<Parameters<typeof createBackupJob>[0], 'correlationId'>;
  restoreJob: Omit<Parameters<typeof createRestoreJob>[0], 'correlationId'>;
  failoverPlan: Omit<Parameters<typeof createFailoverPlan>[0], 'correlationId'>;
  graph: DependencyGraph;
  readinessInput: Parameters<typeof evaluateRecoveryReadiness>[0];
  objectivesInput: Parameters<typeof evaluateObjectives>[0];
  safetyInput: Parameters<typeof evaluateRecoverySafety>[0];
  governanceInput: Parameters<typeof governRecovery>[0];
  circuitBreaker: { failureCount: number; threshold: number };
  provider?: RecoveryProviderAdapter;
  idempotencyKey?: string;
}

export async function orchestrateRecovery(request: AutonomousRecoveryRequest) {
  const auditEvents: ReturnType<typeof createRecoveryAuditEvent>[] = [];
  const evidence: ReturnType<typeof createRecoveryEvidence>[] = [];
  const provider = request.provider ?? unavailableRecoveryProvider;

  const incident = createRecoveryIncident({ ...request.incident });
  const plan = createRecoveryPlan({ ...request.recoveryPlan });
  const planValidation = validateRecoveryPlan(plan);
  if (!planValidation.valid) return { status: 'BLOCKED', reason: 'invalid recovery plan', incident, plan, auditEvents, evidence, lineage: { rootId: incident.incidentId, nodes: [] } };

  const policy = createBackupPolicy({ ...request.backupPolicy });
  const policyValidation = validateBackupPolicy(policy);
  if (!policyValidation.valid) return { status: 'BLOCKED', reason: 'invalid backup policy', incident, plan, auditEvents, evidence, lineage: { rootId: incident.incidentId, nodes: [] } };

  // Dependencies
  if (detectCycle(request.graph)) return { status: 'BLOCKED', reason: 'dependency cycle detected', incident, plan, auditEvents, evidence, lineage: { rootId: incident.incidentId, nodes: [] } };
  const ordered = orderDependencies(request.graph);

  // Readiness
  const readiness = evaluateRecoveryReadiness(request.readinessInput);
  if (readiness === 'NOT_READY') return { status: 'BLOCKED', reason: 'not ready', incident, plan, auditEvents, evidence, lineage: { rootId: incident.incidentId, nodes: [] } };

  // Objectives
  const objectives = evaluateObjectives(request.objectivesInput);

  // Safety & Governance
  const safety = evaluateRecoverySafety(request.safetyInput);
  const governance = governRecovery(request.governanceInput);
  if (!safety.allowed || governance === 'DENY' || governance === 'REQUIRES_APPROVAL') {
    auditEvents.push(createRecoveryAuditEvent({ tenantId: request.tenantId, correlationId: request.correlationId, recoveryId: incident.incidentId, eventType: 'RECOVERY_BLOCKED', reason: `safety=${safety.allowed}, governance=${governance}`, decision: 'BLOCKED' }));
    return { status: 'BLOCKED', reason: 'safety/governance denial', incident, plan, safety, governance, auditEvents, evidence, lineage: { rootId: incident.incidentId, nodes: [] } };
  }

  // Circuit breaker
  const breaker = evaluateRecoveryCircuitBreaker(request.circuitBreaker.failureCount, request.circuitBreaker.threshold);
  if (breaker === 'OPEN') {
    auditEvents.push(createRecoveryAuditEvent({ tenantId: request.tenantId, correlationId: request.correlationId, recoveryId: incident.incidentId, eventType: 'CIRCUIT_OPEN', reason: 'circuit breaker open', decision: 'BLOCKED' }));
    return { status: 'BLOCKED', reason: 'circuit breaker open', incident, plan, auditEvents, evidence, lineage: { rootId: incident.incidentId, nodes: [] } };
  }

  // Simulate provider action (backup or restore/failover based on strategy)
  let providerResult;
  if (plan.strategy === 'BACKUP') {
    providerResult = await provider.backup();
  } else if (plan.strategy === 'RESTORE') {
    providerResult = await provider.restore();
  } else if (plan.strategy === 'FAILOVER') {
    providerResult = await provider.failover();
  } else if (plan.strategy === 'FAILBACK') {
    providerResult = await provider.failback();
  } else {
    providerResult = await provider.healthCheck();
  }

  const providerSucceeded = 'success' in providerResult ? providerResult.success : providerResult.healthy;
  if (!providerSucceeded) {
    auditEvents.push(createRecoveryAuditEvent({ tenantId: request.tenantId, correlationId: request.correlationId, recoveryId: incident.incidentId, eventType: 'PROVIDER_UNAVAILABLE', reason: providerResult.reason, decision: 'UNAVAILABLE' }));
    return { status: 'UNAVAILABLE', reason: providerResult.reason, incident, plan, auditEvents, evidence, lineage: { rootId: incident.incidentId, nodes: [] } };
  }

  // Evidence & lineage
  evidence.push(createRecoveryEvidence({ tenantId: request.tenantId, correlationId: request.correlationId, recoveryId: incident.incidentId, evidenceType: 'RECOVERY_SUCCESS', data: { strategy: plan.strategy } }));
  const lineage: RecoveryLineage = { rootId: incident.incidentId, nodes: [] };
  addRecoveryLineageNode(lineage, { version: 1, incidentId: incident.incidentId, recoveryDecision: plan.strategy, timestamp: new Date().toISOString() });
  auditEvents.push(createRecoveryAuditEvent({ tenantId: request.tenantId, correlationId: request.correlationId, recoveryId: incident.incidentId, eventType: 'RECOVERY_COMPLETED', reason: 'recovery completed', decision: 'SUCCESS' }));

  return { status: 'COMPLETED', incident, plan, readiness, objectives, safety, governance, breaker, ordered, providerResult, auditEvents, evidence, lineage };
}
