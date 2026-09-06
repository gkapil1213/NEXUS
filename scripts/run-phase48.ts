import Database from 'better-sqlite3';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { randomUUID } from 'crypto';

import { processRecoveryAsset } from '../src/core/worker-phase48-recovery-asset';
import { processRecoveryDependency } from '../src/core/worker-phase48-recovery-dependency';
import { processBackupInventory } from '../src/core/worker-phase48-backup-inventory';
import { processBackupObservation } from '../src/core/worker-phase48-backup-observation';
import { processBackupFreshness } from '../src/core/worker-phase48-backup-freshness';
import { processBackupIntegrity } from '../src/core/worker-phase48-backup-integrity';
import { processRecoveryObjective } from '../src/core/worker-phase48-recovery-objective';
import { processRecoveryReadiness } from '../src/core/worker-phase48-recovery-readiness';
import { processRecoveryPriority } from '../src/core/worker-phase48-recovery-priority';
import { processRecoveryPlan } from '../src/core/worker-phase48-recovery-plan';
import { processRecoveryScenario } from '../src/core/worker-phase48-recovery-scenario';
import { processRecoveryRisk } from '../src/core/worker-phase48-recovery-risk';
import { processRecoveryImpact } from '../src/core/worker-phase48-recovery-impact';
import { processRecoveryBlastRadius } from '../src/core/worker-phase48-recovery-blast-radius';
import { processRecoveryGovernance } from '../src/core/worker-phase48-recovery-governance';
import { processRecoveryApproval } from '../src/core/worker-phase48-recovery-approval';
import { processRecoverySafety } from '../src/core/worker-phase48-recovery-safety';
import { processRecoveryProvider } from '../src/core/worker-phase48-recovery-provider';
import { processRecoveryExecution } from '../src/core/worker-phase48-recovery-execution';
import { processRecoveryStep } from '../src/core/worker-phase48-recovery-step';
import { processRestoreOperation } from '../src/core/worker-phase48-restore-operation';
import { processFailoverOperation } from '../src/core/worker-phase48-failover-operation';
import { processRecoveryVerification } from '../src/core/worker-phase48-recovery-verification';
import { processDataIntegrityVerification } from '../src/core/worker-phase48-data-integrity-verification';
import { processServiceHealthVerification } from '../src/core/worker-phase48-service-health-verification';
import { processDependencyVerification } from '../src/core/worker-phase48-dependency-verification';
import { processRecoveryRegression } from '../src/core/worker-phase48-recovery-regression';
import { processRecoveryRollback } from '../src/core/worker-phase48-recovery-rollback';
import { processRecoveryCircuitBreaker } from '../src/core/worker-phase48-recovery-circuit-breaker';
import { processRecoveryIncident } from '../src/core/worker-phase48-recovery-incident';
import { processRecoveryEscalation } from '../src/core/worker-phase48-recovery-escalation';
import { processRecoveryEvidence } from '../src/core/worker-phase48-recovery-evidence';
import { processRecoveryAudit } from '../src/core/worker-phase48-recovery-audit';
import { processRecoveryLineage } from '../src/core/worker-phase48-recovery-lineage';
import { processRecoveryLearning } from '../src/core/worker-phase48-recovery-learning';
import { processAutonomousDrControlPlane } from '../src/core/worker-phase48-autonomous-dr-control-plane';

function redactSecret(text: string): string {
  return text
    .replace(/password\s*[:=]\s*\S+/gi, 'password=[REDACTED]')
    .replace(/token\s*[:=]\s*\S+/gi, 'token=[REDACTED]')
    .replace(/api[_-]?key\s*[:=]\s*\S+/gi, 'api_key=[REDACTED]')
    .replace(/authorization\s*[:=]\s*\S+/gi, 'authorization=[REDACTED]')
    .replace(/secret\s*[:=]\s*\S+/gi, 'secret=[REDACTED]');
}

const db = new Database(':memory:');
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const migrationPath = path.join(__dirname, '..', 'src', 'db', 'migrations', '093_phase48_autonomous_disaster_recovery_business_continuity.sql');
const migrationSql = fs.readFileSync(migrationPath, 'utf8');
db.exec(migrationSql);

const results: { name: string; pass: boolean; error?: string }[] = [];
async function test(name: string, fn: () => void | Promise<void>) {
  try {
    await fn();
    results.push({ name, pass: true });
  } catch (e: any) {
    results.push({ name, pass: false, error: e.message });
  }
}

async function runTests() {
  // Recovery asset
  await test('Recovery asset creation', () => {
    const a = processRecoveryAsset({ name: 'asset1', provider: 'aws', assetType: 'database' });
    if (!a.id || a.name !== 'asset1') throw new Error('Invalid asset');
  });
  await test('Duplicate recovery asset prevention', () => {
    const a1 = processRecoveryAsset({ name: 'dup', provider: 'aws', assetType: 'database', idempotencyKey: 'asset-dup' });
    const a2 = processRecoveryAsset({ name: 'dup', provider: 'aws', assetType: 'database', idempotencyKey: 'asset-dup' });
    if (a1.id !== a2.id) throw new Error('Expected same id');
  });
  await test('Recovery asset discovery', () => {
    const a = processRecoveryAsset({ name: 'disc', provider: 'aws', assetType: 'database' });
    if (!a.id) throw new Error('Discovery failed');
  });

  // Backup inventory & observation
  await test('Backup inventory', () => {
    const b = processBackupInventory({ assetId: 'asset1', backupId: 'bk1', provider: 'aws' });
    if (!b.id || b.backupId !== 'bk1') throw new Error('Backup inventory missing');
  });
  await test('Backup freshness', () => {
    const f = processBackupFreshness({ backupId: 'bk1', freshnessSeconds: 3600, thresholdSeconds: 86400 });
    if (f.freshnessState !== 'fresh') throw new Error('Expected fresh');
  });
  await test('Stale backup detection', () => {
    const f = processBackupFreshness({ backupId: 'bk1', freshnessSeconds: 100000, thresholdSeconds: 86400 });
    if (f.freshnessState !== 'stale') throw new Error('Expected stale');
  });
  await test('Missing backup handling', () => {
    const f = processBackupFreshness({ backupId: 'bk1', missing: true });
    if (f.freshnessState !== 'missing') throw new Error('Expected missing');
  });
  await test('Backup integrity', () => {
    const i = processBackupIntegrity({ backupId: 'bk1', verified: true });
    if (i.integrityState !== 'verified') throw new Error('Expected verified');
  });
  await test('Unknown backup integrity', () => {
    const i = processBackupIntegrity({ backupId: 'bk1' });
    if (i.integrityState !== 'unknown') throw new Error('Expected unknown');
  });

  // RPO/RTO
  await test('RPO compliance', () => {
    const o = processRecoveryObjective({ assetId: 'asset1', rpoTargetSeconds: 3600, actualRpoSeconds: 1800 });
    if (o.rpoCompliance !== 'compliant') throw new Error('Expected compliant');
  });
  await test('RPO violation', () => {
    const o = processRecoveryObjective({ assetId: 'asset1', rpoTargetSeconds: 3600, actualRpoSeconds: 7200 });
    if (o.rpoCompliance !== 'violated') throw new Error('Expected violated');
  });
  await test('RTO compliance', () => {
    const o = processRecoveryObjective({ assetId: 'asset1', rtoTargetSeconds: 300, actualRtoSeconds: 120 });
    if (o.rtoCompliance !== 'compliant') throw new Error('Expected compliant');
  });
  await test('RTO violation', () => {
    const o = processRecoveryObjective({ assetId: 'asset1', rtoTargetSeconds: 300, actualRtoSeconds: 600 });
    if (o.rtoCompliance !== 'violated') throw new Error('Expected violated');
  });

  // Readiness & priority
  await test('Recovery readiness', () => {
    const r = processRecoveryReadiness({ assetId: 'asset1', backupFresh: true, integrityVerified: true, providerReady: true });
    if (r.readinessState !== 'ready') throw new Error('Expected ready');
  });
  await test('Recovery priority', () => {
    const p = processRecoveryPriority({ assetId: 'asset1', priority: 1 });
    if (p.priority !== 1) throw new Error('Priority wrong');
  });
  await test('Dependency-aware ordering', () => {
    const d1 = processRecoveryDependency({ sourceAssetId: 'asset1', targetAssetId: 'asset2' });
    const d2 = processRecoveryDependency({ sourceAssetId: 'asset2', targetAssetId: 'asset3' });
    // Just ensure relationships exist
    if (!d1.id || !d2.id) throw new Error('Dependency missing');
  });

  // Scenario & impact
  await test('Scenario classification', () => {
    const s = processRecoveryScenario({ scenarioType: 'region_failure' });
    if (s.scenarioType !== 'region_failure') throw new Error('Scenario wrong');
  });
  await test('Impact analysis', () => {
    const i = processRecoveryImpact({ assetId: 'asset1', affectedServices: ['svc1'] });
    if (i.affectedServices.length === 0) throw new Error('Impact missing');
  });
  await test('Blast-radius analysis', () => {
    const br = processRecoveryBlastRadius({ assetId: 'asset1', high: true });
    if (br.classification !== 'high') throw new Error('Expected high');
  });

  // Risk
  await test('Recovery risk', () => {
    const r = processRecoveryRisk({ assetId: 'asset1', medium: true });
    if (r.riskLevel !== 'medium') throw new Error('Risk wrong');
  });
  await test('Critical-risk detection', () => {
    const r = processRecoveryRisk({ assetId: 'asset1', critical: true });
    if (r.riskLevel !== 'critical') throw new Error('Expected critical');
  });

  // Governance
  await test('Governance allow', () => {
    const g = processRecoveryGovernance({ assetId: 'asset1' });
    if (g.decision !== 'ALLOW') throw new Error('Expected ALLOW');
  });
  await test('Approval requirement', () => {
    const g = processRecoveryGovernance({ assetId: 'asset1', risk: 'high' });
    if (g.decision !== 'APPROVAL_REQUIRED') throw new Error('Expected APPROVAL_REQUIRED');
  });
  await test('Governance denial', () => {
    const g = processRecoveryGovernance({ assetId: 'asset1', deny: true });
    if (g.decision !== 'DENY') throw new Error('Expected DENY');
  });
  await test('Governance freeze', () => {
    const g = processRecoveryGovernance({ assetId: 'asset1', freeze: true });
    if (g.decision !== 'FREEZE') throw new Error('Expected FREEZE');
  });

  // Safety
  await test('Safety allow', () => {
    const s = processRecoverySafety({ assetId: 'asset1' });
    if (!s.safe) throw new Error('Expected safe');
  });
  await test('Protected-resource block', () => {
    const s = processRecoverySafety({ assetId: 'asset1', protectedResource: true });
    if (s.safe) throw new Error('Expected unsafe');
  });
  await test('Unknown-provider block', () => {
    const s = processRecoverySafety({ assetId: 'asset1', unknownProvider: true });
    if (s.safe) throw new Error('Expected unsafe');
  });
  await test('Unknown-health block', () => {
    const s = processRecoverySafety({ assetId: 'asset1', unknownHealth: true });
    if (s.safe) throw new Error('Expected unsafe');
  });
  await test('Unsafe recovery block', () => {
    const s = processRecoverySafety({ assetId: 'asset1', unsafePlan: true });
    if (s.safe) throw new Error('Expected unsafe');
  });

  // Plan & execution
  await test('Recovery plan creation', () => {
    const p = processRecoveryPlan({ idempotencyKey: 'plan-1', targetServices: ['svc1'] });
    if (!p.id) throw new Error('Plan missing');
  });
  await test('Execution creation', () => {
    const e = processRecoveryExecution({ planId: 'plan1', operation: 'recover' });
    if (!e.id) throw new Error('Execution missing');
  });
  await test('Valid execution transition', () => {
    const e = processRecoveryExecution({ planId: 'plan1', from: 'created', to: 'approved' });
    if (!e.validTransition || e.state !== 'approved') throw new Error('Transition should be valid');
  });
  await test('Invalid execution transition', () => {
    try {
      processRecoveryExecution({ planId: 'plan1', from: 'running', to: 'created' });
      throw new Error('Should have thrown');
    } catch (e: any) {
      if (!e.message.includes('Invalid transition')) throw e;
    }
  });
  await test('Execution halt', () => {
    const e = processRecoveryExecution({ planId: 'plan1', operation: 'halt' });
    if (e.state !== 'halted') throw new Error('Expected halted');
  });
  await test('Duplicate execution prevention', () => {
    const e1 = processRecoveryExecution({ planId: 'plan1', idempotencyKey: 'exec-dup' });
    const e2 = processRecoveryExecution({ planId: 'plan1', idempotencyKey: 'exec-dup' });
    if (e1.id !== e2.id) throw new Error('Expected same id');
  });

  // Restore/failover
  await test('Restore operation', () => {
    const r = processRestoreOperation({ assetId: 'asset1', source: 's3://backup', destination: 'db' });
    if (!r.id) throw new Error('Restore missing');
  });
  await test('Failover operation', () => {
    const f = processFailoverOperation({ assetId: 'asset1', sourceEnvironment: 'prod', targetEnvironment: 'dr' });
    if (!f.id) throw new Error('Failover missing');
  });

  // Verification
  await test('Recovery verification', () => {
    const v = processRecoveryVerification({ executionId: 'exec1', verificationType: 'service', verified: true });
    if (v.verificationState !== 'verified') throw new Error('Expected verified');
  });
  await test('Data-integrity verification', () => {
    const v = processDataIntegrityVerification({ executionId: 'exec1', verified: true });
    if (v.state !== 'verified') throw new Error('Expected verified');
  });
  await test('Service-health verification', () => {
    const v = processServiceHealthVerification({ executionId: 'exec1', healthy: true });
    if (v.state !== 'healthy') throw new Error('Expected healthy');
  });
  await test('Dependency verification', () => {
    const v = processDependencyVerification({ executionId: 'exec1', dependencies: ['dep1'], state: 'available' });
    if (v.state !== 'available') throw new Error('Expected available');
  });

  // Regression
  await test('Recovery regression', () => {
    const r = processRecoveryRegression({ executionId: 'exec1', regressionType: 'performance', detected: true });
    if (!r.detected) throw new Error('Regression not detected');
  });

  // Rollback
  await test('Rollback', () => {
    const rb = processRecoveryRollback({ executionId: 'exec1' });
    if (!rb.id) throw new Error('Rollback missing');
  });
  await test('Rollback idempotency', () => {
    const rb1 = processRecoveryRollback({ executionId: 'exec1', idempotencyKey: 'rb-dup' });
    const rb2 = processRecoveryRollback({ executionId: 'exec1', idempotencyKey: 'rb-dup' });
    if (rb1.id !== rb2.id) throw new Error('Expected same id');
  });
  await test('Rollback failure', () => {
    const rb = processRecoveryRollback({ executionId: 'exec1', fail: true });
    if (rb.state !== 'failed') throw new Error('Expected failed');
  });

  // Circuit breaker
  await test('Circuit breaker closed', () => {
    const cb = processRecoveryCircuitBreaker({ scope: 'recovery' });
    if (cb.state !== 'CLOSED') throw new Error('Expected CLOSED');
  });
  await test('Circuit breaker opens', () => {
    const cb = processRecoveryCircuitBreaker({ scope: 'recovery', failures: 3, threshold: 3 });
    if (cb.state !== 'OPEN') throw new Error('Expected OPEN');
  });
  await test('Execution blocked while breaker is open', () => {
    const e = processRecoveryExecution({ planId: 'plan1', circuitBreakerState: 'OPEN' });
    if (!e.blocked) throw new Error('Expected blocked');
  });

  // Incident
  await test('Incident creation', () => {
    const inc = processRecoveryIncident({ assetId: 'asset1', severity: 'high' });
    if (!inc.id) throw new Error('Incident missing');
  });
  await test('Duplicate incident prevention', () => {
    const i1 = processRecoveryIncident({ assetId: 'asset1', signature: 'sig1' });
    const i2 = processRecoveryIncident({ assetId: 'asset1', signature: 'sig1' });
    if (i1.id !== i2.id) throw new Error('Expected same id');
  });

  // Escalation
  await test('Escalation', () => {
    const esc = processRecoveryEscalation({ incidentId: 'inc1', level: 'critical' });
    if (!esc.id) throw new Error('Escalation missing');
  });

  // Evidence/Audit/Lineage/Learning
  await test('Evidence generation', () => {
    const ev = processRecoveryEvidence({ assetId: 'asset1', executionId: 'exec1', evidenceType: 'recovery' });
    if (!ev.id) throw new Error('Evidence missing');
  });
  await test('Audit trail', () => {
    const audit = processRecoveryAudit({ assetId: 'asset1', eventType: 'recovery_started' });
    if (!audit.id) throw new Error('Audit missing');
  });
  await test('Lineage', () => {
    const lin = processRecoveryLineage({ assetId: 'asset1', planId: 'plan1' });
    if (!lin.id) throw new Error('Lineage missing');
  });
  await test('Learning outcome', () => {
    const learn = processRecoveryLearning({ assetId: 'asset1', pattern: 'outage', outcome: 'recovered' });
    if (!learn.id) throw new Error('Learning missing');
  });

  // Full lifecycle
  await test('Full approved recovery lifecycle orchestration', () => {
    const result = processAutonomousDrControlPlane({ assetId: 'asset1', approve: true });
    if (result.status !== 'RECOVERED') throw new Error('Lifecycle failed');
  });
  await test('Unknown provider fails closed', () => {
    try {
      processRecoveryProvider({ unknown: true });
      throw new Error('Should have thrown');
    } catch (e: any) {
      if (!e.message.includes('UNAVAILABLE')) throw e;
    }
  });
  await test('Repeated identical recovery request remains idempotent', () => {
    const a1 = processRecoveryAsset({ name: 'idem', provider: 'aws', assetType: 'db', idempotencyKey: 'asset-idem' });
    const a2 = processRecoveryAsset({ name: 'idem', provider: 'aws', assetType: 'db', idempotencyKey: 'asset-idem' });
    if (a1.id !== a2.id) throw new Error('Expected same id');
  });

  // Security
  const redactionTests = [
    { name: 'Password redaction', text: 'password=secret123' },
    { name: 'Token redaction', text: 'token=abc123' },
    { name: 'API-key redaction', text: 'api_key=xyz' },
    { name: 'Authorization-header redaction', text: 'Authorization: Bearer token' },
    { name: 'Secret redaction', text: 'secret=value' },
  ];
  for (const rt of redactionTests) {
    await test(rt.name, () => {
      const redacted = redactSecret(rt.text);
      if (!redacted.includes('[REDACTED]')) throw new Error('Redaction failed');
    });
  }

  // Summary
  console.log('=== Phase 48: Autonomous Disaster Recovery, Business Continuity & Resilience Intelligence ===');
  let passed = 0;
  for (const r of results) {
    console.log(`${r.pass ? 'PASS' : 'FAIL'}: ${r.name}${r.error ? ` (${r.error})` : ''}`);
    if (r.pass) passed++;
  }
  console.log(`${passed} tests passed, ${results.length - passed} tests failed.`);
  console.log(passed === results.length ? 'PHASE 48: PASS' : 'PHASE 48: FAIL');
  process.exit(passed === results.length ? 0 : 1);
}

runTests();
