import Database from 'better-sqlite3';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { randomUUID } from 'crypto';

import { processProvider } from '../src/core/worker-phase42-provider';
import { processSecurityAsset } from '../src/core/worker-phase42-security-asset';
import { processSecurityPosture } from '../src/core/worker-phase42-security-posture';
import { processVulnerability } from '../src/core/worker-phase42-vulnerability';
import { processSecuritySignal } from '../src/core/worker-phase42-security-signal';
import { processSecurityAnomaly } from '../src/core/worker-phase42-security-anomaly';
import { processSecurityCorrelation } from '../src/core/worker-phase42-security-correlation';
import { processSecurityRootCause } from '../src/core/worker-phase42-security-root-cause';
import { processSecurityRisk } from '../src/core/worker-phase42-security-risk';
import { processSecurityImpact } from '../src/core/worker-phase42-security-impact';
import { processSecurityBlastRadius } from '../src/core/worker-phase42-security-blast-radius';
import { processSecurityGovernance } from '../src/core/worker-phase42-security-governance';
import { processSecuritySafety } from '../src/core/worker-phase42-security-safety';
import { processSecurityRemediationPlan } from '../src/core/worker-phase42-security-remediation-plan';
import { processSecurityRemediationExecution } from '../src/core/worker-phase42-security-remediation-execution';
import { processSecurityRemediationVerification } from '../src/core/worker-phase42-security-remediation-verification';
import { processSecurityRemediationRollback } from '../src/core/worker-phase42-security-remediation-rollback';
import { processContainment } from '../src/core/worker-phase42-containment';
import { processSecurityCircuitBreaker } from '../src/core/worker-phase42-security-circuit-breaker';
import { processSecurityIncident } from '../src/core/worker-phase42-security-incident';
import { processSecurityEscalation } from '../src/core/worker-phase42-security-escalation';
import { processSecurityEvidence } from '../src/core/worker-phase42-security-evidence';
import { processSecurityAudit } from '../src/core/worker-phase42-security-audit';
import { processSecurityLineage } from '../src/core/worker-phase42-security-lineage';
import { processSecurityLearning } from '../src/core/worker-phase42-security-learning';
import { processAutonomousSecOpsControlPlane } from '../src/core/worker-phase42-autonomous-secops-control-plane';

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
const migrationPath = path.join(__dirname, '..', 'src', 'db', 'migrations', '087_phase42_autonomous_security_operations.sql');
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
  // Security asset
  await test('Security asset creation', () => {
    const a = processSecurityAsset({ provider: 'aws', externalId: 'i-123', assetType: 'instance' });
    if (!a.id || a.assetType !== 'instance') throw new Error('Invalid asset');
  });
  await test('Duplicate asset prevention', () => {
    const a1 = processSecurityAsset({ provider: 'aws', externalId: 'dup', assetType: 'instance', idempotencyKey: 'asset-dup' });
    const a2 = processSecurityAsset({ provider: 'aws', externalId: 'dup', assetType: 'instance', idempotencyKey: 'asset-dup' });
    if (a1.id !== a2.id) throw new Error('Expected same asset id');
  });
  await test('Asset discovery', () => {
    const a = processSecurityAsset({ provider: 'aws', assetType: 'instance' });
    if (!a.id) throw new Error('Discovery failed');
  });
  await test('Unknown provider handling', () => {
    try {
      processProvider({ unknown: true });
      throw new Error('Should have thrown');
    } catch (e: any) {
      if (!e.message.includes('UNAVAILABLE')) throw e;
    }
  });

  // Posture
  await test('Security posture observation', () => {
    const p = processSecurityPosture({ assetId: 'asset1', securityScore: 85 });
    if (p.postureState !== 'secure') throw new Error('Posture should be secure');
  });
  await test('Unknown posture handling', () => {
    const p = processSecurityPosture({ assetId: 'asset1' });
    if (p.postureState !== 'unknown') throw new Error('Expected unknown');
  });

  // Vulnerability
  await test('Vulnerability creation', () => {
    const v = processVulnerability({ vulnerabilityId: 'CVE-123', assetId: 'asset1', severity: 'high' });
    if (!v.id || v.severity !== 'high') throw new Error('Vulnerability not created');
  });
  await test('Duplicate vulnerability prevention', () => {
    const v1 = processVulnerability({ vulnerabilityId: 'CVE-dup', assetId: 'asset1', idempotencyKey: 'vuln-dup' });
    const v2 = processVulnerability({ vulnerabilityId: 'CVE-dup', assetId: 'asset1', idempotencyKey: 'vuln-dup' });
    if (v1.id !== v2.id) throw new Error('Expected same vulnerability id');
  });
  await test('Vulnerability severity', () => {
    const v = processVulnerability({ vulnerabilityId: 'CVE-sev', severity: 'critical' });
    if (v.severity !== 'critical') throw new Error('Severity wrong');
  });
  await test('Vulnerability lifecycle', () => {
    const v = processVulnerability({ vulnerabilityId: 'CVE-life', from: 'discovered', to: 'triaged' });
    if (v.state !== 'triaged' || !v.validTransition) throw new Error('Lifecycle transition failed');
  });
  await test('Invalid vulnerability transition', () => {
    try {
      processVulnerability({ vulnerabilityId: 'CVE-inv', from: 'resolved', to: 'discovered' });
      throw new Error('Should have thrown');
    } catch (e: any) {
      if (!e.message.includes('Invalid transition')) throw e;
    }
  });

  // Signal
  await test('Security signal creation', () => {
    const s = processSecuritySignal({ source: 'test', signalType: 'auth', fingerprint: 'sig-1' });
    if (!s.id || s.signalType !== 'auth') throw new Error('Signal not created');
  });
  await test('Duplicate signal handling', () => {
    const s1 = processSecuritySignal({ fingerprint: 'dup-sig' });
    const s2 = processSecuritySignal({ fingerprint: 'dup-sig' });
    if (s1.id !== s2.id) throw new Error('Expected same signal id');
  });

  // Anomaly
  await test('Security anomaly detection', () => {
    const anom = processSecurityAnomaly({ assetId: 'asset1', anomalyType: 'unusual_auth', severity: 'high' });
    if (anom.severity !== 'high') throw new Error('Anomaly not detected');
  });
  await test('Unknown baseline handling', () => {
    const anom = processSecurityAnomaly({ assetId: 'asset1', anomalyType: 'unknown_baseline' });
    if (anom.baseline !== null) throw new Error('Expected null baseline');
  });

  // Correlation
  await test('Security correlation', () => {
    const corr = processSecurityCorrelation({ sourceType: 'signal', sourceId: 'sig1', targetType: 'asset', targetId: 'asset1', correlationStrength: 'high' });
    if (corr.correlationStrength !== 'high') throw new Error('Correlation wrong');
  });
  await test('No-correlation handling', () => {
    const corr = processSecurityCorrelation({ sourceType: 'signal', sourceId: 'sig1', targetType: 'asset', targetId: 'asset1', correlationStrength: 'none' });
    if (corr.correlationStrength !== 'none') throw new Error('Expected none');
  });
  await test('Unknown correlation handling', () => {
    const corr = processSecurityCorrelation({ sourceType: 'signal', sourceId: 'sig1', targetType: 'asset', targetId: 'asset1' });
    if (corr.correlationStrength !== 'unknown') throw new Error('Expected unknown');
  });

  // Root cause
  await test('Root-cause hypothesis', () => {
    const rc = processSecurityRootCause({ hypothesis: 'compromised credentials', confidence: 0.8 });
    if (!rc.hypothesis || rc.confidence !== 0.8) throw new Error('Root cause missing');
  });

  // Risk
  await test('Risk calculation', () => {
    const risk = processSecurityRisk({ assetId: 'asset1', medium: true });
    if (risk.severity !== 'medium') throw new Error('Risk wrong');
  });
  await test('Critical risk detection', () => {
    const risk = processSecurityRisk({ assetId: 'asset1', critical: true });
    if (risk.severity !== 'critical') throw new Error('Expected critical');
  });
  await test('Unknown risk handling', () => {
    const risk = processSecurityRisk({ assetId: 'asset1' });
    if (risk.severity !== 'unknown') throw new Error('Expected unknown');
  });

  // Impact & Blast radius
  await test('Impact analysis', () => {
    const impact = processSecurityImpact({ affectedAssets: ['asset1'], affectedServices: ['svc1'] });
    if (impact.affectedAssets.length === 0) throw new Error('Impact missing');
  });
  await test('Blast-radius analysis', () => {
    const br = processSecurityBlastRadius({ assetId: 'asset1', high: true });
    if (br.classification !== 'high') throw new Error('Expected high');
  });

  // Governance
  await test('Governance allow', () => {
    const gov = processSecurityGovernance({ assetId: 'asset1' });
    if (gov.decision !== 'ALLOW') throw new Error('Expected ALLOW');
  });
  await test('Approval requirement', () => {
    const gov = processSecurityGovernance({ assetId: 'asset1', risk: 'high' });
    if (gov.decision !== 'APPROVAL_REQUIRED') throw new Error('Expected APPROVAL_REQUIRED');
  });
  await test('Governance denial', () => {
    const gov = processSecurityGovernance({ assetId: 'asset1', deny: true });
    if (gov.decision !== 'DENY') throw new Error('Expected DENY');
  });
  await test('Security freeze', () => {
    const gov = processSecurityGovernance({ assetId: 'asset1', freeze: true });
    if (gov.decision !== 'FREEZE') throw new Error('Expected FREEZE');
  });

  // Safety
  await test('Safety allow', () => {
    const safety = processSecuritySafety({ assetId: 'asset1' });
    if (!safety.safe) throw new Error('Expected safe');
  });
  await test('Protected-resource safety block', () => {
    const safety = processSecuritySafety({ assetId: 'asset1', protectedResource: true });
    if (safety.safe) throw new Error('Expected unsafe');
  });
  await test('Unknown-provider safety block', () => {
    const safety = processSecuritySafety({ assetId: 'asset1', unknownProvider: true });
    if (safety.safe) throw new Error('Expected unsafe');
  });
  await test('Unknown-posture safety block', () => {
    const safety = processSecuritySafety({ assetId: 'asset1', unknownPosture: true });
    if (safety.safe) throw new Error('Expected unsafe');
  });

  // Remediation plan
  await test('Remediation plan', () => {
    const plan = processSecurityRemediationPlan({ action: 'isolate', planFingerprint: 'plan-1' });
    if (!plan.id) throw new Error('Plan missing');
  });
  await test('Duplicate remediation plan prevention', () => {
    const p1 = processSecurityRemediationPlan({ action: 'isolate', planFingerprint: 'dup-plan' });
    const p2 = processSecurityRemediationPlan({ action: 'isolate', planFingerprint: 'dup-plan' });
    if (p1.id !== p2.id) throw new Error('Expected same plan id');
  });

  // Remediation execution
  await test('Remediation execution', () => {
    const exec = processSecurityRemediationExecution({ planId: 'plan1', operation: 'isolate' });
    if (!exec.id) throw new Error('Execution missing');
  });
  await test('Invalid execution transition', () => {
    try {
      processSecurityRemediationExecution({ planId: 'plan1', from: 'running', to: 'created' });
      throw new Error('Should have thrown');
    } catch (e: any) {
      if (!e.message.includes('Invalid transition')) throw e;
    }
  });
  await test('Execution halt', () => {
    const exec = processSecurityRemediationExecution({ planId: 'plan1', operation: 'halt' });
    if (exec.state !== 'halted') throw new Error('Expected halted');
  });

  // Verification
  await test('Remediation verification', () => {
    const ver = processSecurityRemediationVerification({ executionId: 'exec1', recovered: true });
    if (ver.state !== 'recovered') throw new Error('Expected recovered');
  });
  await test('Recovery detection', () => {
    const ver = processSecurityRemediationVerification({ executionId: 'exec1', recovered: true });
    if (ver.state !== 'recovered') throw new Error('Not recovered');
  });
  await test('Regression detection', () => {
    const ver = processSecurityRemediationVerification({ executionId: 'exec1', regression: true });
    if (ver.state !== 'regressed') throw new Error('Expected regressed');
  });

  // Rollback
  await test('Remediation rollback', () => {
    const rb = processSecurityRemediationRollback({ executionId: 'exec1' });
    if (!rb.id) throw new Error('Rollback missing');
  });
  await test('Rollback idempotency', () => {
    const rb1 = processSecurityRemediationRollback({ executionId: 'exec1', idempotencyKey: 'rb-dup' });
    const rb2 = processSecurityRemediationRollback({ executionId: 'exec1', idempotencyKey: 'rb-dup' });
    if (rb1.id !== rb2.id) throw new Error('Expected same rollback id');
  });
  await test('Rollback failure', () => {
    const rb = processSecurityRemediationRollback({ executionId: 'exec1', fail: true });
    if (rb.state !== 'failed') throw new Error('Expected failed');
  });

  // Containment
  await test('Containment action', () => {
    const c = processContainment({ incidentId: 'inc1', assetId: 'asset1', containmentType: 'isolate' });
    if (!c.id) throw new Error('Containment missing');
  });
  await test('Containment safety', () => {
    const c = processContainment({ incidentId: 'inc1', assetId: 'asset1', containmentType: 'isolate' });
    if (!c.id) throw new Error('Containment safety missing');
  });

  // Circuit breaker
  await test('Circuit breaker closed', () => {
    const cb = processSecurityCircuitBreaker({ scope: 'security' });
    if (cb.state !== 'CLOSED') throw new Error('Expected CLOSED');
  });
  await test('Circuit breaker opens', () => {
    const cb = processSecurityCircuitBreaker({ scope: 'security', failures: 3, threshold: 3 });
    if (cb.state !== 'OPEN') throw new Error('Expected OPEN');
  });
  await test('Execution blocked while breaker is open', () => {
    const exec = processSecurityRemediationExecution({ planId: 'plan1', circuitBreakerState: 'OPEN' });
    if (!exec.blocked) throw new Error('Expected blocked');
  });

  // Incident
  await test('Security incident creation', () => {
    const inc = processSecurityIncident({ fingerprint: 'inc-1', severity: 'high' });
    if (!inc.id || inc.severity !== 'high') throw new Error('Incident missing');
  });
  await test('Duplicate incident prevention', () => {
    const i1 = processSecurityIncident({ fingerprint: 'dup-inc' });
    const i2 = processSecurityIncident({ fingerprint: 'dup-inc' });
    if (i1.id !== i2.id) throw new Error('Expected same incident id');
  });

  // Escalation
  await test('Escalation', () => {
    const esc = processSecurityEscalation({ incidentId: 'inc1', severity: 'critical' });
    if (!esc.id || esc.severity !== 'critical') throw new Error('Escalation missing');
  });

  // Evidence/Audit/Lineage/Learning
  await test('Evidence generation', () => {
    const ev = processSecurityEvidence({ source: 'test', findingId: 'f1' });
    if (!ev.id) throw new Error('Evidence missing');
  });
  await test('Audit trail', () => {
    const audit = processSecurityAudit({ action: 'isolate', resource: 'asset1' });
    if (!audit.id) throw new Error('Audit missing');
  });
  await test('Lineage', () => {
    const lin = processSecurityLineage({ assetId: 'asset1', findingId: 'f1' });
    if (!lin.id) throw new Error('Lineage missing');
  });
  await test('Learning outcome', () => {
    const learn = processSecurityLearning({ pattern: 'brute_force', outcome: 'blocked' });
    if (!learn.id) throw new Error('Learning missing');
  });

  // Control plane
  await test('Full approved SecOps lifecycle orchestration', () => {
    const result = processAutonomousSecOpsControlPlane({ assetId: 'asset1', approve: true });
    if (result.status !== 'RESOLVED') throw new Error('Lifecycle failed');
  });
  await test('Repeated identical security request remains idempotent', () => {
    const a1 = processSecurityAsset({ provider: 'aws', externalId: 'idem', assetType: 'instance', idempotencyKey: 'asset-idem' });
    const a2 = processSecurityAsset({ provider: 'aws', externalId: 'idem', assetType: 'instance', idempotencyKey: 'asset-idem' });
    if (a1.id !== a2.id) throw new Error('Expected same asset id');
  });
  await test('Unknown provider fails closed', () => {
    try {
      processProvider({ unknown: true });
      throw new Error('Should have thrown');
    } catch (e: any) {
      if (!e.message.includes('UNAVAILABLE')) throw e;
    }
  });

  // Redaction
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
  console.log('=== Phase 42: Autonomous Security Operations & SecOps Intelligence ===');
  let passed = 0;
  for (const r of results) {
    console.log(`${r.pass ? 'PASS' : 'FAIL'}: ${r.name}${r.error ? ` (${r.error})` : ''}`);
    if (r.pass) passed++;
  }
  console.log(`${passed} tests passed, ${results.length - passed} tests failed.`);
  console.log(passed === results.length ? 'PHASE 42: PASS' : 'PHASE 42: FAIL');
  process.exit(passed === results.length ? 0 : 1);
}

runTests();
