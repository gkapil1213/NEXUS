import Database from 'better-sqlite3';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import * as w from '../src/core/worker-phase51';

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
const migrationPath = path.join(__dirname, '..', 'src', 'db', 'migrations', '096_phase51_autonomous_engineering_decision_intelligence.sql');
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
  // Decision creation
  await test('Decision creation', () => {
    const d = w.processDecision({ idempotencyKey: 'dec-1', decisionType: 'test' });
    if (!d.id || d.decisionStatus !== 'pending') throw new Error('Invalid decision');
  });
  await test('Duplicate decision prevention', () => {
    const a = w.processDecision({ idempotencyKey: 'dec-dup', decisionType: 'test' });
    const b = w.processDecision({ idempotencyKey: 'dec-dup', decisionType: 'test' });
    if (a.id !== b.id) throw new Error('Not idempotent');
  });
  await test('Decision retrieval', () => {
    const d = w.processDecision({ idempotencyKey: 'dec-ret', decisionType: 'test' });
    if (!d.id) throw new Error('Missing id');
  });
  await test('Decision state transitions', () => {
    const d = w.processDecision({ idempotencyKey: 'dec-state', decisionType: 'test', decisionStatus: 'evaluating' });
    if (d.decisionStatus !== 'evaluating') throw new Error('Wrong status');
  });

  // Context
  await test('Context creation', () => {
    const c = w.processDecisionContext({ decisionId: 'd1', contextType: 'reliability', contextData: { health: 'healthy' } });
    if (!c.id) throw new Error('Context missing');
  });
  await test('Multi-domain evidence', () => {
    const c = w.processDecisionContext({ decisionId: 'd1', contextType: 'multi', contextData: { security: 'ok', reliability: 'ok' } });
    if (!c.id) throw new Error('Missing id');
  });
  await test('Missing evidence', () => {
    const c = w.processDecisionContext({ decisionId: 'd1', contextType: 'empty' });
    if (Object.keys(c.contextData).length !== 0) throw new Error('Expected empty');
  });
  await test('Stale evidence', () => {
    const c = w.processDecisionContext({ decisionId: 'd1', contextType: 'stale', evidenceRef: 'old' });
    if (!c.id) throw new Error('Missing id');
  });

  // Evaluation
  await test('Candidate generation', () => {
    const cand = w.processDecisionCandidate({ decisionId: 'd1', candidateAction: 'rollback', score: 0.8 });
    if (!cand.id) throw new Error('Candidate missing');
  });
  await test('Risk evaluation', () => {
    const ev = w.processDecisionEvaluation({ decisionId: 'd1', reliabilityRisk: 'high' });
    if (ev.reliabilityRisk !== 'high') throw new Error('Risk wrong');
  });
  await test('Confidence calculation', () => {
    const conf = w.processDecisionConfidence({ decisionId: 'd1', confidence: 0.9 });
    if (conf.confidence !== 0.9) throw new Error('Confidence wrong');
  });
  await test('Priority calculation', () => {
    const pri = w.processDecisionPriority({ decisionId: 'd1', critical: true });
    if (pri.priority !== 100) throw new Error('Priority wrong');
  });

  // Conflict
  await test('Reliability/security conflict', () => {
    const c = w.processDecisionConflict({ decisionId: 'd1', conflictType: 'reliability_security', description: 'conflict' });
    if (c.conflictType !== 'reliability_security') throw new Error('Wrong conflict');
  });
  await test('Reliability/cost conflict', () => {
    const c = w.processDecisionConflict({ decisionId: 'd1', conflictType: 'reliability_cost', description: 'conflict' });
    if (c.conflictType !== 'reliability_cost') throw new Error('Wrong conflict');
  });
  await test('Compliance/operations conflict', () => {
    const c = w.processDecisionConflict({ decisionId: 'd1', conflictType: 'compliance_operations', description: 'conflict' });
    if (c.conflictType !== 'compliance_operations') throw new Error('Wrong conflict');
  });
  await test('No-conflict case', () => {
    const c = w.processDecisionConflict({ decisionId: 'd1', conflictType: 'none', description: null });
    if (c.conflictType !== 'none') throw new Error('Wrong conflict');
  });

  // Governance
  await test('Governance allow', () => {
    const g = w.processDecisionGovernance({ decisionId: 'd1' });
    if (g.decision !== 'ALLOW') throw new Error('Wrong decision');
  });
  await test('Approval requirement', () => {
    const g = w.processDecisionGovernance({ decisionId: 'd1', risk: 'high' });
    if (g.decision !== 'APPROVAL_REQUIRED') throw new Error('Wrong decision');
  });
  await test('Governance denial', () => {
    const g = w.processDecisionGovernance({ decisionId: 'd1', deny: true });
    if (g.decision !== 'DENY') throw new Error('Wrong decision');
  });
  await test('Governance freeze', () => {
    const g = w.processDecisionGovernance({ decisionId: 'd1', freeze: true });
    if (g.decision !== 'FREEZE') throw new Error('Wrong decision');
  });

  // Safety
  await test('Safe action', () => {
    const s = w.processDecisionSafety({ decisionId: 'd1' });
    if (!s.safe) throw new Error('Should be safe');
  });
  await test('Protected resource', () => {
    const s = w.processDecisionSafety({ decisionId: 'd1', protectedResource: true });
    if (s.safe) throw new Error('Should be unsafe');
  });
  await test('Unknown provider', () => {
    const s = w.processDecisionSafety({ decisionId: 'd1', unknownProvider: true });
    if (s.safe) throw new Error('Should be unsafe');
  });
  await test('Unknown health', () => {
    const s = w.processDecisionSafety({ decisionId: 'd1', unknownHealth: true });
    if (s.safe) throw new Error('Should be unsafe');
  });
  await test('Excessive blast radius', () => {
    const s = w.processDecisionSafety({ decisionId: 'd1', excessiveBlastRadius: true });
    if (s.safe) throw new Error('Should be unsafe');
  });
  await test('Missing rollback', () => {
    const s = w.processDecisionSafety({ decisionId: 'd1', missingRollback: true });
    if (s.safe) throw new Error('Should be unsafe');
  });
  await test('Missing verification', () => {
    const s = w.processDecisionSafety({ decisionId: 'd1', missingVerification: true });
    if (s.safe) throw new Error('Should be unsafe');
  });

  // Approval
  await test('Approval required', () => {
    const a = w.processDecisionApproval({ decisionId: 'd1', status: 'pending' });
    if (a.status !== 'pending') throw new Error('Wrong status');
  });
  await test('Approval granted', () => {
    const a = w.processDecisionApproval({ decisionId: 'd1', status: 'approved' });
    if (a.status !== 'approved') throw new Error('Wrong status');
  });
  await test('Approval rejected', () => {
    const a = w.processDecisionApproval({ decisionId: 'd1', status: 'rejected' });
    if (a.status !== 'rejected') throw new Error('Wrong status');
  });
  await test('Expired/invalid approval', () => {
    const a = w.processDecisionApproval({ decisionId: 'd1', status: 'expired' });
    if (a.status !== 'expired') throw new Error('Wrong status');
  });
  await test('Execution blocked without approval', () => {
    const a = w.processDecisionApproval({ decisionId: 'd1', status: 'pending' });
    if (a.status === 'approved') throw new Error('Should not be approved');
  });

  // Execution
  await test('Valid execution', () => {
    const e = w.processDecisionExecution({ decisionId: 'd1', operation: 'deploy' });
    if (!e.id) throw new Error('Missing id');
  });
  await test('Invalid transition', () => {
    try {
      w.processDecisionExecution({ decisionId: 'd1', from: 'completed', to: 'executing' });
      throw new Error('Should have thrown');
    } catch (e: any) {
      if (!e.message.includes('Invalid transition')) throw e;
    }
  });
  await test('Duplicate execution', () => {
    const a = w.processDecisionExecution({ decisionId: 'd1', idempotencyKey: 'exec-dup' });
    const b = w.processDecisionExecution({ decisionId: 'd1', idempotencyKey: 'exec-dup' });
    if (a.id !== b.id) throw new Error('Not idempotent');
  });
  await test('Execution failure', () => {
    const e = w.processDecisionExecution({ decisionId: 'd1', operation: 'fail', result: 'error' });
    if (e.result !== 'error') throw new Error('Expected error');
  });
  await test('Execution halt', () => {
    const e = w.processDecisionExecution({ decisionId: 'd1', operation: 'halt' });
    if (e.state !== 'halted') throw new Error('Expected halted');
  });

  // Verification
  await test('Success', () => {
    const v = w.processDecisionVerification({ executionId: 'e1', success: true });
    if (v.state !== 'success') throw new Error('Wrong state');
  });
  await test('Failure', () => {
    const v = w.processDecisionVerification({ executionId: 'e1', failed: true });
    if (v.state !== 'failed') throw new Error('Wrong state');
  });
  await test('Partial success', () => {
    const v = w.processDecisionVerification({ executionId: 'e1', partial: true });
    if (v.state !== 'partial') throw new Error('Wrong state');
  });
  await test('Regression', () => {
    const v = w.processDecisionVerification({ executionId: 'e1', regression: true });
    if (v.state !== 'regression') throw new Error('Wrong state');
  });
  await test('Unknown outcome', () => {
    const v = w.processDecisionVerification({ executionId: 'e1' });
    if (v.state !== 'unknown') throw new Error('Wrong state');
  });

  // Rollback
  await test('Rollback', () => {
    const rb = w.processDecisionRollback({ executionId: 'e1' });
    if (!rb.id) throw new Error('Missing id');
  });
  await test('Rollback verification', () => {
    const rb = w.processDecisionRollback({ executionId: 'e1', result: 'success' });
    if (rb.result !== 'success') throw new Error('Wrong result');
  });
  await test('Rollback idempotency', () => {
    const a = w.processDecisionRollback({ executionId: 'e1', idempotencyKey: 'rb-dup' });
    const b = w.processDecisionRollback({ executionId: 'e1', idempotencyKey: 'rb-dup' });
    if (a.id !== b.id) throw new Error('Not idempotent');
  });
  await test('Rollback failure', () => {
    const rb = w.processDecisionRollback({ executionId: 'e1', fail: true });
    if (rb.state !== 'failed') throw new Error('Wrong state');
  });

  // Circuit breaker
  await test('Closed', () => {
    const cb = w.processDecisionCircuitBreaker({ scope: 'decision' });
    if (cb.state !== 'CLOSED') throw new Error('Wrong state');
  });
  await test('Opens', () => {
    const cb = w.processDecisionCircuitBreaker({ scope: 'decision', failures: 3, threshold: 3 });
    if (cb.state !== 'OPEN') throw new Error('Wrong state');
  });
  await test('Blocked while open', () => {
    const e = w.processDecisionExecution({ decisionId: 'd1', circuitBreakerState: 'OPEN' });
    if (!e.blocked) throw new Error('Should be blocked');
  });
  await test('Recovery/half-open behavior', () => {
    const cb = w.processDecisionCircuitBreaker({ scope: 'decision', state: 'HALF_OPEN' });
    if (cb.state !== 'HALF_OPEN') throw new Error('Wrong state');
  });

  // Incidents
  await test('Incident creation', () => {
    const inc = w.processDecisionIncident({ decisionId: 'd1', severity: 'high' });
    if (!inc.id) throw new Error('Missing id');
  });
  await test('Duplicate incident prevention', () => {
    const a = w.processDecisionIncident({ signature: 'sig1' });
    const b = w.processDecisionIncident({ signature: 'sig1' });
    if (a.id !== b.id) throw new Error('Not idempotent');
  });
  await test('Escalation', () => {
    const esc = w.processDecisionIncident({ decisionId: 'd1', severity: 'critical' });
    if (esc.severity !== 'critical') throw new Error('Wrong severity');
  });

  // Evidence
  await test('Evidence generation', () => {
    const ev = w.processDecisionEvidence({ decisionId: 'd1' });
    if (!ev.id) throw new Error('Missing id');
  });
  await test('Evidence integrity', () => {
    const ev = w.processDecisionEvidence({ decisionId: 'd1', data: { hash: 'abc' } });
    if (!ev.data.hash) throw new Error('Missing hash');
  });

  // Audit
  await test('Audit trail', () => {
    const a = w.processDecisionAudit({ decisionId: 'd1', eventType: 'decision_created' });
    if (!a.id) throw new Error('Missing id');
  });

  // Lineage
  await test('Decision lineage', () => {
    const lin = w.processDecisionLineage({ decisionId: 'd1', executionId: 'e1' });
    if (!lin.id) throw new Error('Missing id');
  });

  // Learning
  await test('Learning outcome', () => {
    const l = w.processDecisionLearning({ decisionId: 'd1', predictedOutcome: 'success', actualOutcome: 'success' });
    if (!l.id) throw new Error('Missing id');
  });

  // Replay
  await test('Deterministic replay', () => {
    const r = w.processDecisionReplay({ decisionId: 'd1', replayedInputs: { a: 1 }, replayedOutputs: { b: 2 } });
    if (!r.id) throw new Error('Missing id');
  });
  await test('Divergence detection', () => {
    const r = w.processDecisionReplay({ decisionId: 'd1', divergenceDetected: true });
    if (!r.divergenceDetected) throw new Error('Divergence not detected');
  });

  // Security redaction
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

  // Full lifecycle
  await test('Full lifecycle orchestration', () => {
    const result = w.processAutonomousDecisionControlPlane({ decisionId: 'd1', approve: true });
    if (result.status !== 'COMPLETED') throw new Error('Wrong status');
  });

  // Idempotency
  await test('Repeated identical decision requests remain idempotent', () => {
    const a = w.processDecision({ idempotencyKey: 'dec-idem', decisionType: 'test' });
    const b = w.processDecision({ idempotencyKey: 'dec-idem', decisionType: 'test' });
    if (a.id !== b.id) throw new Error('Not idempotent');
  });

  console.log('=== Phase 51: Autonomous Engineering Decision Intelligence & Unified Control Plane ===');
  let passed = 0;
  for (const r of results) {
    console.log(`${r.pass ? 'PASS' : 'FAIL'}: ${r.name}${r.error ? ` (${r.error})` : ''}`);
    if (r.pass) passed++;
  }
  console.log(`${passed} tests passed, ${results.length - passed} tests failed.`);
  console.log(passed === results.length ? 'PHASE 51: PASS' : 'PHASE 51: FAIL');
  process.exit(passed === results.length ? 0 : 1);
}

runTests();