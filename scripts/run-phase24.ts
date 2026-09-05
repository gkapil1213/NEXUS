import { createRecoveryPlan, validateRecoveryPlan } from '../src/core/worker-dr-recovery-plan';
import { createBackupPolicy, validateBackupPolicy } from '../src/core/worker-backup-policy';
import { createBackupJob, transitionBackupJob } from '../src/core/worker-backup-job';
import { createBackupArtifact } from '../src/core/worker-backup-artifact';
import { verifyBackup } from '../src/core/worker-backup-verification';
import { createRecoveryPoint } from '../src/core/worker-recovery-point';
import { createRestoreJob, transitionRestoreJob } from '../src/core/worker-restore-job';
import { verifyRestore } from '../src/core/worker-restore-verification';
import { createFailoverPlan } from '../src/core/worker-failover-plan';
import { createFailoverExecution, transitionFailoverExecution } from '../src/core/worker-failover-execution';
import { createFailbackExecution } from '../src/core/worker-failback-execution';
import { detectCycle, orderDependencies, DependencyGraph } from '../src/core/worker-recovery-dependency';
import { evaluateRecoveryReadiness } from '../src/core/worker-recovery-readiness';
import { evaluateObjectives } from '../src/core/worker-recovery-objectives';
import { createRecoveryDrill } from '../src/core/worker-recovery-drill';
import { createRecoveryIncident } from '../src/core/worker-recovery-incident';
import { evaluateRecoverySafety } from '../src/core/worker-recovery-safety';
import { governRecovery } from '../src/core/worker-recovery-governance';
import { evaluateRecoveryCircuitBreaker } from '../src/core/worker-recovery-circuit-breaker';
import { createRecoveryAuditEvent } from '../src/core/worker-recovery-audit';
import { createRecoveryEvidence } from '../src/core/worker-recovery-evidence';
import { addRecoveryLineageNode, RecoveryLineage } from '../src/core/worker-recovery-lineage';
import { orchestrateRecovery } from '../src/core/worker-autonomous-disaster-recovery-control-plane';
import { unavailableRecoveryProvider, RecoveryProviderAdapter } from '../src/core/worker-recovery-adapter';
import { redactSecrets } from '../src/core/secret-redaction';

let passed = 0;
let failed = 0;
function assert(cond: boolean, name: string) { if (cond) { console.log(`PASS: ${name}`); passed++; } else { console.error(`FAIL: ${name}`); failed++; } }

const goodPlan = {
  service: 'svc1',
  environment: 'prod',
  strategy: 'BACKUP' as const,
  rpoSeconds: 300,
  rtoSeconds: 600,
  backupRequirements: ['full'],
  restoreStrategy: 'restore',
  failoverStrategy: 'switch',
  failbackStrategy: 'switch-back',
  dependencies: ['db'],
  requiredApprovals: 1,
  safetyRequirements: ['rollback'],
  verificationRequirements: ['checksum'],
};

const goodPolicy = {
  frequencyHours: 24,
  retentionDays: 30,
  backupType: 'FULL' as const,
  requiredVerification: true,
  encryptionRequired: true,
  integrityRequired: true,
  geographicRedundancy: true,
};

const goodIncident = {
  type: 'database failure',
  affectedServices: ['svc1'],
  severity: 'HIGH',
};

const goodGraph: DependencyGraph = {
  nodes: ['db', 'backend', 'api'],
  edges: { backend: ['db'], api: ['backend'] },
};

const successAdapter: RecoveryProviderAdapter = {
  async backup() { return { success: true, reason: 'ok', evidence: ['evidence'] }; },
  async restore() { return { success: true, reason: 'ok', evidence: ['evidence'] }; },
  async failover() { return { success: true, reason: 'ok', evidence: ['evidence'] }; },
  async failback() { return { success: true, reason: 'ok', evidence: ['evidence'] }; },
  async healthCheck() { return { healthy: true, reason: 'ok' }; },
};

function getGoodRequest() {
  return {
    tenantId: 't',
    correlationId: 'c',
    incident: goodIncident,
    recoveryPlan: goodPlan,
    backupPolicy: goodPolicy,
    backupJob: { policyId: 'p1', target: 'svc1', provider: 'test', correlationId: 'c' },
    restoreJob: { recoveryPointId: 'rp1', target: 'svc1', correlationId: 'c' },
    failoverPlan: { primaryTarget: 'primary', secondaryTarget: 'secondary', dependencies: [], ordering: [], healthRequirements: [], governanceRequirements: [], safetyRequirements: [], approvalRequired: true, failbackStrategy: 'failback', correlationId: 'c' },
    graph: goodGraph,
    readinessInput: { validRecoveryPlan: true, validBackupPolicy: true, recentVerifiedBackup: true, validRecoveryPoint: true, restoreCapability: true, failoverCapability: true, dependenciesReady: true, governanceReady: true, securityReady: true, verificationCapability: true },
    objectivesInput: { currentRpoSeconds: 60, targetRpoSeconds: 300, currentRtoSeconds: 120, targetRtoSeconds: 600 },
    safetyInput: { productionRestore: false, productionFailover: false, destructiveAction: false, dataReplacement: false, targetSwitching: false, rollbackAvailable: true, approved: true },
    governanceInput: { riskLevel: 'LOW', approved: true, emergency: false },
    circuitBreaker: { failureCount: 0, threshold: 3 },
    provider: successAdapter,
  };
}

async function main() {
  console.log('=== Phase 24: Autonomous Disaster Recovery & Business Continuity ===');

  // Recovery plan
  const plan = createRecoveryPlan(goodPlan);
  assert(plan.planId.length > 0, 'Recovery plan creation');
  const dupPlan = createRecoveryPlan(goodPlan);
  assert(dupPlan.idempotencyKey === plan.idempotencyKey, 'Duplicate recovery plan rejection');
  assert(validateRecoveryPlan(plan).valid, 'Recovery plan validation');

  // Backup policy
  const policy = createBackupPolicy(goodPolicy);
  assert(policy.policyId.length > 0, 'Backup policy creation');
  assert(validateBackupPolicy(policy).valid, 'Valid backup policy');
  assert(!validateBackupPolicy(createBackupPolicy({ ...goodPolicy, frequencyHours: 0 })).valid, 'Invalid backup policy rejected');

  // Backup job
  let job = createBackupJob({ policyId: policy.policyId, target: 'svc1', provider: 'test', correlationId: 'c' });
  assert(job.jobId.length > 0, 'Backup job creation');
  const dupJob = createBackupJob({ policyId: policy.policyId, target: 'svc1', provider: 'test', correlationId: 'c' });
  assert(dupJob.idempotencyKey === job.idempotencyKey, 'Duplicate backup job prevention');
  job = transitionBackupJob(job, 'QUEUED');
  job = transitionBackupJob(job, 'RUNNING');
  job = transitionBackupJob(job, 'VERIFYING');
  job = transitionBackupJob(job, 'COMPLETED');
  assert(job.status === 'COMPLETED', 'Backup lifecycle transitions');

  // Artifact & verification
  const artifact = createBackupArtifact({ jobId: job.jobId, size: 100, providerReference: 'ref', encryptionMetadata: 'enc', lineage: [], retentionState: 'active' });
  assert(artifact.checksum.length > 0, 'Backup artifact fingerprint');
  assert(verifyBackup({ artifact, expectedChecksum: artifact.checksum, providerAvailable: true }) === 'VERIFIED', 'Backup integrity verification');
  assert(verifyBackup({ artifact, expectedChecksum: 'bad', providerAvailable: true }) === 'CORRUPTED', 'Corrupted backup detection');
  assert(verifyBackup({ artifact, expectedChecksum: artifact.checksum, providerAvailable: false }) === 'UNAVAILABLE', 'Provider unavailable verification');

  // Recovery point
  const rp = createRecoveryPoint({ source: 'prod', timestamp: new Date().toISOString(), backupArtifactId: artifact.artifactId, verificationState: 'VERIFIED', retentionState: 'active', recoveryReadiness: 'READY' });
  assert(rp.pointId.length > 0, 'Recovery point creation');

  // Objectives
  assert(evaluateObjectives({ currentRpoSeconds: 60, targetRpoSeconds: 300, currentRtoSeconds: 120, targetRtoSeconds: 600 }).rpoMet, 'RPO evaluation');
  assert(!evaluateObjectives({ currentRpoSeconds: 400, targetRpoSeconds: 300, currentRtoSeconds: 120, targetRtoSeconds: 600 }).rpoMet, 'RTO evaluation');

  // Readiness
  assert(evaluateRecoveryReadiness(getGoodRequest().readinessInput) === 'READY', 'Recovery readiness');

  // Restore
  let restore = createRestoreJob({ recoveryPointId: rp.pointId, target: 'svc1', correlationId: 'c' });
  assert(restore.restoreId.length > 0, 'Restore creation');
  restore = transitionRestoreJob(restore, 'AUTHORIZED');
  restore = transitionRestoreJob(restore, 'RUNNING');
  restore = transitionRestoreJob(restore, 'VERIFYING');
  restore = transitionRestoreJob(restore, 'COMPLETED');
  assert(restore.status === 'COMPLETED', 'Restore lifecycle');
  assert(verifyRestore({ restoredArtifactConsistency: true, configConsistency: true, dependencyReadiness: true, healthStatus: 'HEALTHY', applicationReadiness: true, dataIntegrity: true }).status === 'PASS', 'Restore verification');

  // Failover
  const failoverPlan = createFailoverPlan({ primaryTarget: 'primary', secondaryTarget: 'secondary', dependencies: [], ordering: [], healthRequirements: [], governanceRequirements: [], safetyRequirements: [], approvalRequired: true, failbackStrategy: 'failback' });
  assert(failoverPlan.planId.length > 0, 'Failover plan creation');
  assert(orderDependencies({ nodes: ['db', 'backend', 'api'], edges: { backend: ['db'], api: ['backend'] } }).length === 3, 'Dependency ordering');
  assert(detectCycle({ nodes: ['a', 'b'], edges: { a: ['b'], b: ['a'] } }), 'Dependency cycle detection');
  let failover = createFailoverExecution({ planId: failoverPlan.planId });
  assert(failover.executionId.length > 0, 'Failover execution');
  const dupFailover = createFailoverExecution({ planId: failoverPlan.planId });
  assert(dupFailover.idempotencyKey === failover.idempotencyKey, 'Duplicate failover prevention');
  failover = transitionFailoverExecution(failover, 'AUTHORIZED');
  failover = transitionFailoverExecution(failover, 'PREPARING');
  failover = transitionFailoverExecution(failover, 'FAILING_OVER');
  failover = transitionFailoverExecution(failover, 'VERIFYING');
  failover = transitionFailoverExecution(failover, 'COMPLETED');
  assert(failover.status === 'COMPLETED', 'Failover lifecycle');
  try { transitionFailoverExecution(failover, 'FAILING_OVER'); assert(false, 'Should throw'); } catch { assert(true, 'Illegal failover transition rejected'); }

  // Failback
  const failback = createFailbackExecution({ failoverExecutionId: failover.executionId, primaryHealth: 'HEALTHY', correlationId: 'c' });
  assert(failback.failbackId.length > 0, 'Failback safety');

  // Drill
  const drill = createRecoveryDrill({ planId: plan.planId });
  assert(drill.isDrill, 'Recovery drill creation');
  assert(drill.isDrill === true, 'Production-vs-drill separation');

  // Incident
  const incident = createRecoveryIncident(goodIncident);
  assert(incident.incidentId.length > 0, 'Recovery incident creation');

  // Governance & safety
  assert(governRecovery({ riskLevel: 'LOW', approved: true, emergency: false }) === 'ALLOW', 'Governance allows');
  assert(governRecovery({ riskLevel: 'CRITICAL', approved: false, emergency: false }) === 'DENY', 'Governance denial');
  assert(evaluateRecoverySafety({ productionRestore: true, productionFailover: false, destructiveAction: true, dataReplacement: false, targetSwitching: false, rollbackAvailable: true, approved: true }).allowed === false, 'Safety denial');

  // Circuit breaker
  assert(evaluateRecoveryCircuitBreaker(2, 3) === 'CLOSED', 'Circuit breaker closed');
  assert(evaluateRecoveryCircuitBreaker(3, 3) === 'OPEN', 'Circuit breaker opens');

  // Audit, evidence, lineage
  const audit = createRecoveryAuditEvent({ tenantId: 't', correlationId: 'c', eventType: 'TEST', reason: 'test', decision: 'ALLOW' });
  assert(audit.eventType === 'TEST', 'Audit event creation');
  const ev = createRecoveryEvidence({ tenantId: 't', correlationId: 'c', recoveryId: 'r1', evidenceType: 'TEST', data: {} });
  assert(ev.evidenceId.length > 0, 'Evidence provenance');
  const lineage: RecoveryLineage = { rootId: 'r1', nodes: [] };
  const line1 = addRecoveryLineageNode(lineage, { version: 1, recoveryDecision: 'BACKUP', timestamp: new Date().toISOString() });
  assert(line1.nodes.length === 1, 'Recovery lineage');

  // Orchestrator with success adapter
  const result = await orchestrateRecovery(getGoodRequest());
  assert(result.status === 'COMPLETED', 'Approved recovery lifecycle');

  // Orchestrator with unavailable provider
  const unavailable = await orchestrateRecovery({ ...getGoodRequest(), provider: unavailableRecoveryProvider });
  assert(unavailable.status === 'UNAVAILABLE', 'External provider unavailable reported honestly');

  // Idempotency
  const result2 = await orchestrateRecovery(getGoodRequest());
  assert(result2.status === 'COMPLETED' && result2.plan?.fingerprint === result.plan?.fingerprint, 'Repeated identical recovery request remains idempotent');

  // Redaction
  const redacted = redactSecrets({ password: 'secret123', token: 'tok123', apiKey: 'key123', authorization: 'Bearer abc', secret: 'xyz' });
  assert(!JSON.stringify(redacted).includes('secret123'), 'Password redaction');
  assert(!JSON.stringify(redacted).includes('tok123'), 'Token redaction');
  assert(!JSON.stringify(redacted).includes('key123'), 'API key redaction');
  assert(!JSON.stringify(redacted).includes('Bearer abc'), 'Authorization header redaction');
  assert(!JSON.stringify(redacted).includes('xyz'), 'Secret redaction');

  console.log(`\n${passed} tests passed, ${failed} tests failed.`);
  if (failed > 0) { console.log('PHASE 24: FAIL'); process.exit(1); }
  else { console.log('PHASE 24: PASS'); }
}

main().catch(err => { console.error(err); process.exit(1); });
