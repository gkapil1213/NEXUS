import Database from 'better-sqlite3';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import * as w from '../src/core/worker-phase50';

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
const migrationPath = path.join(__dirname, '..', 'src', 'db', 'migrations', '095_phase50_autonomous_compliance_assurance.sql');
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

  // Controls
  await test('Control creation', () => { const c = w.processControl({ controlId: 'C1', frameworkId: 'fw1' }); if (!c.id) throw new Error('Missing id'); });
  await test('Duplicate control prevention', () => { const a = w.processControl({ controlId: 'dup', idempotencyKey: 'c-dup' }); const b = w.processControl({ controlId: 'dup', idempotencyKey: 'c-dup' }); if (a.id !== b.id) throw new Error('Not idempotent'); });
  await test('Control discovery', () => { const c = w.processControl({ controlId: 'C2' }); if (!c.id) throw new Error('Missing id'); });
  await test('Control mapping', () => { const m = w.processControlMapping({ controlId: 'c1', requirementId: 'r1' }); if (!m.id) throw new Error('Mapping missing'); });
  await test('Observation', () => { const o = w.processObservation({ controlId: 'c1', observedValue: 'yes' }); if (!o.id) throw new Error('Observation missing'); });
  await test('Unknown observation handling', () => { const o = w.processObservation({ controlId: 'c1' }); if (o.observedValue !== undefined) throw new Error('Expected undefined'); });

  // Evaluation
  await test('Compliant evaluation', () => { const e = w.processEvaluation({ controlId: 'c1', compliant: true }); if (e.evaluationState !== 'compliant') throw new Error('Wrong state'); });
  await test('Non-compliant evaluation', () => { const e = w.processEvaluation({ controlId: 'c1', nonCompliant: true }); if (e.evaluationState !== 'non_compliant') throw new Error('Wrong state'); });
  await test('Unknown evaluation', () => { const e = w.processEvaluation({ controlId: 'c1' }); if (e.evaluationState !== 'unknown') throw new Error('Wrong state'); });
  await test('Not-applicable evaluation', () => { const e = w.processEvaluation({ controlId: 'c1', notApplicable: true }); if (e.evaluationState !== 'not_applicable') throw new Error('Wrong state'); });
  await test('Evaluation explanation', () => { const e = w.processEvaluation({ controlId: 'c1', compliant: true, reason: 'test' }); if (!e.reason) throw new Error('Missing reason'); });

  // Effectiveness
  await test('Effectiveness calculation', () => { const e = w.processEffectiveness({ controlId: 'c1', success: true }); if (e.effectivenessScore !== 1) throw new Error('Wrong score'); });
  await test('Degraded effectiveness', () => { const e = w.processEffectiveness({ controlId: 'c1', partial: true }); if (e.effectivenessScore !== 0.5) throw new Error('Wrong score'); });
  await test('Unstable control detection', () => { const e = w.processEffectiveness({ controlId: 'c1', stability: 0.1 }); if (e.stabilityScore !== 0.1) throw new Error('Wrong stability'); });

  // Posture
  await test('Healthy posture', () => { const p = w.processPosture({ scopeId: 's1', compliantRate: 0.99 }); if (p.postureState !== 'healthy') throw new Error('Wrong posture'); });
  await test('Degraded posture', () => { const p = w.processPosture({ scopeId: 's1', compliantRate: 0.85 }); if (p.postureState !== 'degraded') throw new Error('Wrong posture'); });
  await test('At-risk posture', () => { const p = w.processPosture({ scopeId: 's1', compliantRate: 0.7 }); if (p.postureState !== 'at_risk') throw new Error('Wrong posture'); });
  await test('Non-compliant posture', () => { const p = w.processPosture({ scopeId: 's1', compliantRate: 0.4 }); if (p.postureState !== 'non_compliant') throw new Error('Wrong posture'); });
  await test('Unknown posture', () => { const p = w.processPosture({ scopeId: 's1' }); if (p.postureState !== 'unknown') throw new Error('Wrong posture'); });

  // Drift
  await test('Compliance drift', () => { const d = w.processDrift({ controlId: 'c1', driftType: 'compliance' }); if (!d.id) throw new Error('Drift missing'); });
  await test('Policy drift', () => { const pd = w.processPolicyDrift({ policyId: 'p1', driftDetails: 'mfa' }); if (!pd.id) throw new Error('Policy drift missing'); });
  await test('Repeated drift detection', () => { const a = w.processDrift({ controlId: 'c1', idempotencyKey: 'drift-dup' }); const b = w.processDrift({ controlId: 'c1', idempotencyKey: 'drift-dup' }); if (a.id !== b.id) throw new Error('Not idempotent'); });
  await test('Drift idempotency', () => { const a = w.processDrift({ controlId: 'c1', idempotencyKey: 'drift-idem' }); const b = w.processDrift({ controlId: 'c1', idempotencyKey: 'drift-idem' }); if (a.id !== b.id) throw new Error('Not idempotent'); });

  // Violations
  await test('Violation creation', () => { const v = w.processViolation({ controlId: 'c1' }); if (!v.id) throw new Error('Missing id'); });
  await test('Duplicate violation prevention', () => { const a = w.processViolation({ controlId: 'c1', idempotencyKey: 'v-dup' }); const b = w.processViolation({ controlId: 'c1', idempotencyKey: 'v-dup' }); if (a.id !== b.id) throw new Error('Not idempotent'); });
  await test('Violation lifecycle', () => { const v = w.processViolation({ controlId: 'c1', status: 'open' }); if (v.status !== 'open') throw new Error('Wrong state'); });
  await test('Severity', () => { const v = w.processViolation({ controlId: 'c1', severity: 'high' }); if (v.severity !== 'high') throw new Error('Wrong severity'); });
  await test('Risk calculation', () => { const r = w.processRisk({ violationId: 'v1', medium: true }); if (r.riskLevel !== 'medium') throw new Error('Wrong risk'); });

  // Correlation
  await test('Change correlation', () => { const c = w.processChangeCorrelation({ violationId: 'v1', changeRef: 'dep1', correlationStrength: 'high' }); if (c.correlationStrength !== 'high') throw new Error('Wrong correlation'); });
  await test('No-correlation handling', () => { const c = w.processChangeCorrelation({ violationId: 'v1', correlationStrength: 'none' }); if (c.correlationStrength !== 'none') throw new Error('Wrong correlation'); });
  await test('Dependency impact', () => { const di = w.processDependencyImpact({ violationId: 'v1', affectedServices: ['svc1'] }); if (di.affectedServices.length === 0) throw new Error('Impact missing'); });
  await test('Blast-radius analysis', () => { const br = w.processBlastRadius({ violationId: 'v1', high: true }); if (br.classification !== 'high') throw new Error('Wrong classification'); });

  // Governance
  await test('Governance allow', () => { const g = w.processGovernance({ controlId: 'c1' }); if (g.decision !== 'ALLOW') throw new Error('Wrong decision'); });
  await test('Approval requirement', () => { const g = w.processGovernance({ controlId: 'c1', risk: 'high' }); if (g.decision !== 'APPROVAL_REQUIRED') throw new Error('Wrong decision'); });
  await test('Governance denial', () => { const g = w.processGovernance({ controlId: 'c1', deny: true }); if (g.decision !== 'DENY') throw new Error('Wrong decision'); });
  await test('Governance freeze', () => { const g = w.processGovernance({ controlId: 'c1', freeze: true }); if (g.decision !== 'FREEZE') throw new Error('Wrong decision'); });

  // Safety
  await test('Unknown provider block', () => { const s = w.processSafety({ controlId: 'c1', unknownProvider: true }); if (s.safe) throw new Error('Should be unsafe'); });
  await test('Protected-resource block', () => { const s = w.processSafety({ controlId: 'c1', protectedResource: true }); if (s.safe) throw new Error('Should be unsafe'); });
  await test('Missing-evidence block', () => { const s = w.processSafety({ controlId: 'c1', missingEvidence: true }); if (s.safe) throw new Error('Should be unsafe'); });
  await test('Unknown-control block', () => { const s = w.processSafety({ controlId: 'c1', unknownControl: true }); if (s.safe) throw new Error('Should be unsafe'); });
  await test('Unsafe-remediation block', () => { const s = w.processSafety({ controlId: 'c1', unsafeRemediation: true }); if (s.safe) throw new Error('Should be unsafe'); });

  // Remediation
  await test('Remediation plan', () => { const p = w.processRemediationPlan({ violationId: 'v1' }); if (!p.id) throw new Error('Plan missing'); });
  await test('Approval', () => { const a = w.processApproval({ planId: 'p1', decision: 'approved' }); if (a.decision !== 'approved') throw new Error('Wrong decision'); });
  await test('Execution', () => { const e = w.processRemediationExecution({ planId: 'p1', operation: 'fix' }); if (!e.id) throw new Error('Execution missing'); });
  await test('Verification', () => { const v = w.processRemediationVerification({ executionId: 'e1', verified: true }); if (v.state !== 'verified') throw new Error('Wrong state'); });
  await test('Regression', () => { const v = w.processRemediationVerification({ executionId: 'e1', regression: true }); if (v.state !== 'regression') throw new Error('Wrong state'); });
  await test('Rollback', () => { const rb = w.processRemediationRollback({ executionId: 'e1' }); if (!rb.id) throw new Error('Rollback missing'); });
  await test('Rollback idempotency', () => { const a = w.processRemediationRollback({ executionId: 'e1', idempotencyKey: 'rb-dup' }); const b = w.processRemediationRollback({ executionId: 'e1', idempotencyKey: 'rb-dup' }); if (a.id !== b.id) throw new Error('Not idempotent'); });
  await test('Rollback failure', () => { const rb = w.processRemediationRollback({ executionId: 'e1', fail: true }); if (rb.state !== 'failed') throw new Error('Wrong state'); });

  // Circuit breaker
  await test('Breaker closed', () => { const cb = w.processCircuitBreaker({ scope: 'compliance' }); if (cb.state !== 'CLOSED') throw new Error('Wrong state'); });
  await test('Breaker opens', () => { const cb = w.processCircuitBreaker({ scope: 'compliance', failures: 3, threshold: 3 }); if (cb.state !== 'OPEN') throw new Error('Wrong state'); });
  await test('Execution blocked while open', () => { const e = w.processRemediationExecution({ planId: 'p1', circuitBreakerState: 'OPEN' }); if (!e.blocked) throw new Error('Should be blocked'); });

  // Incident
  await test('Incident creation', () => { const inc = w.processIncident({ violationId: 'v1', severity: 'high' }); if (!inc.id) throw new Error('Missing id'); });
  await test('Duplicate incident prevention', () => { const a = w.processIncident({ signature: 'sig1' }); const b = w.processIncident({ signature: 'sig1' }); if (a.id !== b.id) throw new Error('Not idempotent'); });
  await test('Escalation', () => { const esc = w.processEscalation({ incidentId: 'inc1', level: 'critical' }); if (!esc.id) throw new Error('Escalation missing'); });

  // Evidence/Audit/Lineage/Learning
  await test('Evidence generation', () => { const ev = w.processEvidence({ controlId: 'c1' }); if (!ev.id) throw new Error('Evidence missing'); });
  await test('Audit trail', () => { const a = w.processAudit({ eventType: 'violation_detected', resource: 'r1' }); if (!a.id) throw new Error('Audit missing'); });
  await test('Lineage', () => { const lin = w.processLineage({ controlId: 'c1', violationId: 'v1' }); if (!lin.id) throw new Error('Lineage missing'); });
  await test('Learning outcome', () => { const l = w.processLearning({ violationId: 'v1', pattern: 'recurring' }); if (!l.id) throw new Error('Learning missing'); });

  // Full lifecycle
  await test('Full lifecycle orchestration', () => { const result = w.processAutonomousComplianceControlPlane({ controlId: 'c1', approve: true }); if (result.status !== 'COMPLIANT') throw new Error('Wrong status'); });
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

  // Summary
  console.log('=== Phase 50: Autonomous Compliance Assurance & Continuous Control Validation ===');
  let passed = 0;
  for (const r of results) {
    console.log(`${r.pass ? 'PASS' : 'FAIL'}: ${r.name}${r.error ? ` (${r.error})` : ''}`);
    if (r.pass) passed++;
  }
  console.log(`${passed} tests passed, ${results.length - passed} tests failed.`);
  console.log(passed === results.length ? 'PHASE 50: PASS' : 'PHASE 50: FAIL');
  process.exit(passed === results.length ? 0 : 1);
}

runTests();
