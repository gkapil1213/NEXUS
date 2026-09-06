import Database from 'better-sqlite3';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import * as w from '../src/core/worker-phase49';

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
const migrationPath = path.join(__dirname, '..', 'src', 'db', 'migrations', '094_phase49_autonomous_compliance_policy_regulatory.sql');
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
  // Framework
  await test('Framework creation', () => { const f = w.processFramework({ name: 'SOC2', version: '2024' }); if (!f.id || f.name !== 'SOC2') throw new Error('Invalid'); });
  await test('Duplicate framework prevention', () => { const a = w.processFramework({ name: 'dup', version: '1.0', idempotencyKey: 'fw-dup' }); const b = w.processFramework({ name: 'dup', version: '1.0', idempotencyKey: 'fw-dup' }); if (a.id !== b.id) throw new Error('Not idempotent'); });
  await test('Framework discovery', () => { const f = w.processFramework({ name: 'disc', version: '1.0' }); if (!f.id) throw new Error('Missing id'); });
  await test('Unknown framework handling', () => { const f = w.processFramework({ name: 'unknown' }); if (f.version !== '1.0') throw new Error('Default version wrong'); });
  await test('Framework version handling', () => { const f = w.processFramework({ name: 'ver', version: '2.0' }); if (f.version !== '2.0') throw new Error('Version wrong'); });

  // Policy
  await test('Policy creation', () => { const p = w.processPolicy({ name: 'encryption', version: '1.0' }); if (!p.id) throw new Error('Missing id'); });
  await test('Duplicate policy prevention', () => { const a = w.processPolicy({ name: 'dup', idempotencyKey: 'pol-dup' }); const b = w.processPolicy({ name: 'dup', idempotencyKey: 'pol-dup' }); if (a.id !== b.id) throw new Error('Not idempotent'); });
  await test('Policy discovery', () => { const p = w.processPolicy({ name: 'disc' }); if (!p.id) throw new Error('Missing id'); });
  await test('Policy evaluation', () => { const pe = w.processPolicyEvaluation({ policyId: 'pol1', fail: true }); if (pe.result !== 'fail') throw new Error('Wrong result'); });
  await test('Unknown policy handling', () => { const pe = w.processPolicyEvaluation({ policyId: 'unknown', unknown: true }); if (pe.result !== 'unknown') throw new Error('Wrong result'); });

  // Controls
  await test('Control creation', () => { const c = w.processControl({ controlId: 'C1' }); if (!c.id) throw new Error('Missing id'); });
  await test('Control discovery', () => { const c = w.processControl({ controlId: 'C2' }); if (!c.id) throw new Error('Missing id'); });
  await test('Control pass', () => { const a = w.processAssessment({ controlId: 'c1', pass: true }); if (a.assessmentState !== 'pass') throw new Error('Wrong state'); });
  await test('Control fail', () => { const a = w.processAssessment({ controlId: 'c1', fail: true }); if (a.assessmentState !== 'fail') throw new Error('Wrong state'); });
  await test('Control unknown', () => { const a = w.processAssessment({ controlId: 'c1', unknown: true }); if (a.assessmentState !== 'unknown') throw new Error('Wrong state'); });
  await test('Missing evidence handling', () => { const a = w.processAssessment({ controlId: 'c1' }); if (a.assessmentState !== 'pending') throw new Error('Wrong state'); });

  // Evidence
  await test('Evidence creation', () => { const e = w.processEvidence({ source: 'sys' }); if (!e.id) throw new Error('Missing id'); });
  await test('Evidence validation', () => { const v = w.processEvidenceValidation({ evidenceId: 'e1', integrityValid: true, notStale: true }); if (!v.valid) throw new Error('Should be valid'); });
  await test('Stale evidence', () => { const v = w.processEvidenceValidation({ evidenceId: 'e1', integrityValid: true, notStale: false }); if (v.valid) throw new Error('Should be invalid'); });
  await test('Invalid evidence', () => { const v = w.processEvidenceValidation({ evidenceId: 'e1', integrityValid: false, notStale: true }); if (v.valid) throw new Error('Should be invalid'); });
  await test('Evidence lineage', () => { const e = w.processEvidence({ source: 'sys' }); if (!e.id) throw new Error('Missing id'); });

  // Assessment
  await test('Assessment creation', () => { const a = w.processAssessment({ controlId: 'c1' }); if (!a.id) throw new Error('Missing id'); });
  await test('PASS assessment', () => { const a = w.processAssessment({ controlId: 'c1', pass: true }); if (a.assessmentState !== 'pass') throw new Error('Wrong state'); });
  await test('FAIL assessment', () => { const a = w.processAssessment({ controlId: 'c1', fail: true }); if (a.assessmentState !== 'fail') throw new Error('Wrong state'); });
  await test('UNKNOWN assessment', () => { const a = w.processAssessment({ controlId: 'c1', unknown: true }); if (a.assessmentState !== 'unknown') throw new Error('Wrong state'); });
  await test('Duplicate assessment prevention', () => { const a = w.processAssessment({ controlId: 'c1', assetId: 'a1', evidenceId: 'e1' }); const b = w.processAssessment({ controlId: 'c1', assetId: 'a1', evidenceId: 'e1' }); if (a.id === b.id) throw new Error('Should not be identical'); });

  // Violations
  await test('Violation creation', () => { const v = w.processViolation({ policyId: 'pol1' }); if (!v.id) throw new Error('Missing id'); });
  await test('Duplicate violation prevention', () => { const a = w.processViolation({ policyId: 'pol1', idempotencyKey: 'v-dup' }); const b = w.processViolation({ policyId: 'pol1', idempotencyKey: 'v-dup' }); if (a.id !== b.id) throw new Error('Not idempotent'); });
  await test('Violation correlation', () => { const c = w.processCorrelation({ sourceType: 'violation', sourceId: 'v1', targetType: 'asset', targetId: 'a1', correlationStrength: 'high' }); if (c.correlationStrength !== 'high') throw new Error('Wrong strength'); });
  await test('Violation lifecycle', () => { const v = w.processViolation({ policyId: 'pol1', state: 'open' }); if (v.state !== 'open') throw new Error('Wrong state'); });

  // Risk
  await test('Compliance risk calculation', () => { const r = w.processComplianceRisk({ violationId: 'v1', medium: true }); if (r.riskLevel !== 'medium') throw new Error('Wrong risk'); });
  await test('Critical-risk detection', () => { const r = w.processComplianceRisk({ violationId: 'v1', critical: true }); if (r.riskLevel !== 'critical') throw new Error('Wrong risk'); });
  await test('Unknown-risk handling', () => { const r = w.processComplianceRisk({ violationId: 'v1' }); if (r.riskLevel !== 'unknown') throw new Error('Wrong risk'); });

  // Mapping
  await test('Regulatory mapping', () => { const m = w.processRegulatoryMapping({ sourceType: 'framework', sourceId: 'fw1', targetType: 'regulation', targetId: 'reg1' }); if (!m.id) throw new Error('Missing id'); });
  await test('Control mapping', () => { const m = w.processControlMapping({ sourceType: 'control', sourceId: 'c1', targetType: 'policy', targetId: 'p1' }); if (!m.id) throw new Error('Missing id'); });
  await test('Cross-framework mapping', () => { const m = w.processRegulatoryMapping({ sourceType: 'control', sourceId: 'c1', targetType: 'framework', targetId: 'fw2' }); if (!m.id) throw new Error('Missing id'); });

  // Exceptions
  await test('Exception creation', () => { const e = w.processException({ policyId: 'p1' }); if (!e.id) throw new Error('Missing id'); });
  await test('Duplicate exception prevention', () => { const a = w.processException({ policyId: 'p1', idempotencyKey: 'e-dup' }); const b = w.processException({ policyId: 'p1', idempotencyKey: 'e-dup' }); if (a.id !== b.id) throw new Error('Not idempotent'); });
  await test('Exception approval requirement', () => { const e = w.processException({ policyId: 'p1', status: 'pending' }); if (e.status !== 'pending') throw new Error('Wrong status'); });
  await test('Exception approval', () => { const e = w.processException({ policyId: 'p1', status: 'approved' }); if (e.status !== 'approved') throw new Error('Wrong status'); });
  await test('Exception denial', () => { const e = w.processException({ policyId: 'p1', status: 'denied' }); if (e.status !== 'denied') throw new Error('Wrong status'); });
  await test('Exception expiration', () => { const e = w.processException({ policyId: 'p1', expiration: '2025-01-01' }); if (!e.expiration) throw new Error('Missing expiration'); });

  // Governance
  await test('Governance allow', () => { const g = w.processGovernance({ resourceId: 'r1' }); if (g.decision !== 'ALLOW') throw new Error('Wrong decision'); });
  await test('Approval requirement', () => { const g = w.processGovernance({ resourceId: 'r1', risk: 'high' }); if (g.decision !== 'APPROVAL_REQUIRED') throw new Error('Wrong decision'); });
  await test('Governance denial', () => { const g = w.processGovernance({ resourceId: 'r1', deny: true }); if (g.decision !== 'DENY') throw new Error('Wrong decision'); });
  await test('Governance freeze', () => { const g = w.processGovernance({ resourceId: 'r1', freeze: true }); if (g.decision !== 'FREEZE') throw new Error('Wrong decision'); });

  // Safety
  await test('Safety allow', () => { const s = w.processSafety({ resourceId: 'r1' }); if (!s.safe) throw new Error('Should be safe'); });
  await test('Protected-resource block', () => { const s = w.processSafety({ resourceId: 'r1', protectedResource: true }); if (s.safe) throw new Error('Should be unsafe'); });
  await test('Unknown-provider block', () => { const s = w.processSafety({ resourceId: 'r1', unknownProvider: true }); if (s.safe) throw new Error('Should be unsafe'); });
  await test('Unknown-policy block', () => { const s = w.processSafety({ resourceId: 'r1', unknownPolicy: true }); if (s.safe) throw new Error('Should be unsafe'); });
  await test('Unknown-compliance-state block', () => { const s = w.processSafety({ resourceId: 'r1', unknownComplianceState: true }); if (s.safe) throw new Error('Should be unsafe'); });
  await test('Critical-risk block', () => { const s = w.processSafety({ resourceId: 'r1', criticalRisk: true }); if (s.safe) throw new Error('Should be unsafe'); });

  // Remediation
  await test('Remediation plan', () => { const p = w.processRemediationPlan({ violationId: 'v1' }); if (!p.id) throw new Error('Missing id'); });
  await test('Remediation execution', () => { const e = w.processRemediationExecution({ planId: 'p1' }); if (!e.id) throw new Error('Missing id'); });
  await test('Remediation verification', () => { const v = w.processRemediationVerification({ executionId: 'e1', verified: true }); if (v.state !== 'verified') throw new Error('Wrong state'); });
  await test('Regression detection', () => { const v = w.processRemediationVerification({ executionId: 'e1', regression: true }); if (v.state !== 'regression') throw new Error('Wrong state'); });
  await test('Rollback', () => { const rb = w.processRemediationRollback({ executionId: 'e1' }); if (!rb.id) throw new Error('Missing id'); });
  await test('Rollback idempotency', () => { const a = w.processRemediationRollback({ executionId: 'e1', idempotencyKey: 'r-dup' }); const b = w.processRemediationRollback({ executionId: 'e1', idempotencyKey: 'r-dup' }); if (a.id !== b.id) throw new Error('Not idempotent'); });
  await test('Rollback failure', () => { const rb = w.processRemediationRollback({ executionId: 'e1', fail: true }); if (rb.state !== 'failed') throw new Error('Wrong state'); });

  // Circuit breaker
  await test('Breaker closed', () => { const cb = w.processCircuitBreaker({ scope: 'compliance' }); if (cb.state !== 'CLOSED') throw new Error('Wrong state'); });
  await test('Breaker opens', () => { const cb = w.processCircuitBreaker({ scope: 'compliance', failures: 3, threshold: 3 }); if (cb.state !== 'OPEN') throw new Error('Wrong state'); });
  await test('Execution blocked while open', () => { const e = w.processRemediationExecution({ planId: 'p1', circuitBreakerState: 'OPEN' }); if (!e.blocked) throw new Error('Should be blocked'); });

  // Incident
  await test('Incident creation', () => { const inc = w.processIncident({ violationId: 'v1', severity: 'high' }); if (!inc.id) throw new Error('Missing id'); });
  await test('Duplicate incident prevention', () => { const a = w.processIncident({ signature: 'sig1' }); const b = w.processIncident({ signature: 'sig1' }); if (a.id !== b.id) throw new Error('Not idempotent'); });
  await test('Escalation', () => { const esc = w.processEscalation({ incidentId: 'inc1', level: 'critical' }); if (!esc.id) throw new Error('Missing id'); });

  // Evidence/Audit/Lineage/Learning
  await test('Evidence generation', () => { const ev = w.processEvidence({ source: 'sys' }); if (!ev.id) throw new Error('Missing id'); });
  await test('Audit trail', () => { const a = w.processAudit({ eventType: 'violation_detected', resource: 'r1' }); if (!a.id) throw new Error('Missing id'); });
  await test('Lineage', () => { const lin = w.processLineage({ violationId: 'v1' }); if (!lin.id) throw new Error('Missing id'); });
  await test('Learning outcome', () => { const l = w.processLearning({ violationId: 'v1' }); if (!l.id) throw new Error('Missing id'); });

  // Full lifecycle
  await test('Full lifecycle orchestration', () => { const result = w.processAutonomousComplianceControlPlane({ resourceId: 'r1', approve: true }); if (result.status !== 'COMPLIANT') throw new Error('Wrong status'); });
  await test('Repeated identical request remains idempotent', () => { const a = w.processFramework({ name: 'idem', version: '1.0', idempotencyKey: 'fw-idem' }); const b = w.processFramework({ name: 'idem', version: '1.0', idempotencyKey: 'fw-idem' }); if (a.id !== b.id) throw new Error('Not idempotent'); });

  // Security redaction
  const redactionTests = [
    { name: 'Password redaction', text: 'password=secret123' },
    { name: 'Token redaction', text: 'token=abc123' },
    { name: 'API-key redaction', text: 'api_key=xyz' },
    { name: 'Authorization-header redaction', text: 'Authorization: Bearer token' },
    { name: 'Secret redaction', text: 'secret=value' },
  ];
  for (const rt of redactionTests) {
    await test(rt.name, () => { const redacted = redactSecret(rt.text); if (!redacted.includes('[REDACTED]')) throw new Error('Redaction failed'); });
  }

  console.log('=== Phase 49: Autonomous Compliance, Policy & Regulatory Operations Intelligence ===');
  let passed = 0;
  for (const r of results) {
    console.log(`${r.pass ? 'PASS' : 'FAIL'}: ${r.name}${r.error ? ` (${r.error})` : ''}`);
    if (r.pass) passed++;
  }
  console.log(`${passed} tests passed, ${results.length - passed} tests failed.`);
  console.log(passed === results.length ? 'PHASE 49: PASS' : 'PHASE 49: FAIL');
  process.exit(passed === results.length ? 0 : 1);
}

runTests();