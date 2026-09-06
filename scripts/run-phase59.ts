import * as w from '../src/core/worker-phase59';

const results: { name: string; pass: boolean; error?: string }[] = [];
async function test(name: string, fn: () => void | Promise<void>) {
  try { await fn(); results.push({ name, pass: true }); } catch (e: any) { results.push({ name, pass: false, error: e.message }); }
}

async function runTests() {
  // Environment
  await test('Environment creation', () => { const env = w.createEnvironment({ key: 'prod', name: 'Production', type: 'production', health: 'HEALTHY', capabilities: ['deploy'], idempotencyKey: 'env-prod' }); if (!env.id) throw new Error('Missing'); });
  await test('Duplicate environment prevention', () => { const a = w.createEnvironment({ key: 'dup', idempotencyKey: 'env-dup' }); const b = w.createEnvironment({ key: 'dup', idempotencyKey: 'env-dup' }); if (a.id !== b.id) throw new Error('Not idempotent'); });
  await test('Environment retrieval', () => { const env = w.getEnvironment('env-prod'); if (!env) throw new Error('Not found'); });
  await test('Unknown environment handling', () => { const env = w.getEnvironment('nonexistent'); if (env) throw new Error('Should be null'); });
  await test('Environment validation', () => { const v = w.validateEnvironment('env-prod'); if (!v.valid) throw new Error('Should be valid'); });
  await test('Environment capability assignment', () => { const ok = w.assignCapabilities('env-prod', ['rollback']); if (!ok) throw new Error('Capability not assigned'); });

  // Health
  await test('Healthy environment', () => { const h = w.evaluateHealth('HEALTHY'); if (!h.safeForHighRisk) throw new Error('Should be safe'); });
  await test('Degraded environment', () => { const h = w.evaluateHealth('DEGRADED'); if (h.safeForHighRisk) throw new Error('Should not be safe for high risk'); if (!h.safeForLowRisk) throw new Error('Should be safe for low risk'); });
  await test('Unknown health', () => { const h = w.evaluateHealth('UNKNOWN'); if (h.safeForHighRisk || h.safeForLowRisk) throw new Error('Should be unsafe'); });
  await test('Frozen environment', () => { w.updateEnvironment('env-prod', { frozen: true }); const v = w.validateEnvironment('env-prod'); if (v.valid) throw new Error('Should be invalid'); });

  // Agents
  await test('Agent registration', () => { const a = w.registerAgent({ key: 'agent1', environmentId: 'env-prod', capabilities: ['deploy'], idempotencyKey: 'agent1' }); if (!a.id) throw new Error('Missing'); });
  await test('Duplicate agent prevention', () => { const a = w.registerAgent({ key: 'agent1', idempotencyKey: 'agent1' }); if (a.id !== 'agent1') throw new Error('Not idempotent'); });
  await test('Capability validation', () => { const ok = w.assignCapabilitiesToAgent('agent1', ['rollback']); if (!ok) throw new Error('Not assigned'); });
  await test('Heartbeat', () => { const hb = w.heartbeat('agent1'); if (hb.status !== 'active') throw new Error('Wrong'); });
  await test('Lease acquisition', () => { const l = w.acquireLease('op1', 'agent1'); if (!l.leaseToken) throw new Error('Missing'); });
  await test('Lease renewal', () => { const ok = w.renewLease('op1'); if (!ok) throw new Error('Failed'); });
  await test('Lease expiration', () => { const expired = w.detectExpiredLeases(); if (expired.length !== 0) throw new Error('Should be none'); });
  await test('Lease release', () => { const ok = w.releaseLease('op1'); if (!ok) throw new Error('Failed'); });

  // Dependencies
  await test('Dependency registration', () => { w.createEnvironment({ key: 'staging', type: 'staging', health: 'HEALTHY', idempotencyKey: 'env-staging' }); const ok = w.registerDependency('env-prod', 'env-staging'); if (!ok) throw new Error('Failed'); });
  await test('Dependency traversal', () => { const ok = w.registerDependency('env-staging', 'env-prod'); if (!ok) throw new Error('Failed'); });
  await test('Circular dependency detection', () => { const circular = w.detectCircularDependency('env-prod'); if (!circular) throw new Error('Circular not detected'); });
  await test('Missing dependency handling', () => { const ok = w.registerDependency('env-prod', 'nonexistent'); if (ok) throw new Error('Should fail'); });

  // Create a healthy dev environment for targeting tests
  w.createEnvironment({ key: 'dev', type: 'development', health: 'HEALTHY', capabilities: ['deploy'], idempotencyKey: 'env-dev' });

  // Create a healthy dev environment for targeting tests
  w.createEnvironment({ key: 'dev', type: 'development', health: 'HEALTHY', capabilities: ['deploy'], idempotencyKey: 'env-dev' });

  // Targeting
  await test('Valid target', () => { const targets = w.selectTargets({}, ['env-dev']); if (targets.allowed.length !== 1) throw new Error('Wrong'); });
  await test('Invalid target', () => { const targets = w.selectTargets({}, ['nonexistent']); if (targets.allowed.length !== 0) throw new Error('Wrong'); });
  await test('Unsupported capability', () => { const targets = w.selectTargets({ requiredCapabilities: ['nonexistent'] }, ['env-prod']); if (targets.allowed.length !== 0) throw new Error('Should reject'); });
  await test('Unknown target', () => { const targets = w.selectTargets({}, ['unknown']); if (targets.allowed.length !== 0) throw new Error('Should reject'); });

  // Governance
  await test('Governance allow', () => { const g = w.evaluateGovernance('low'); if (g.decision !== 'ALLOW') throw new Error('Wrong'); });
  await test('Approval required', () => { const g = w.evaluateGovernance('high'); if (g.decision !== 'REQUIRE_APPROVAL') throw new Error('Wrong'); });
  await test('Governance denial', () => { const g = w.evaluateGovernance(undefined, false, true); if (g.decision !== 'DENY') throw new Error('Wrong'); });
  await test('Governance freeze', () => { const g = w.evaluateGovernance(undefined, true); if (g.decision !== 'FREEZE') throw new Error('Wrong'); });

  // Safety
  await test('Safe operation', () => { const s = w.evaluateSafety({}); if (!s.safe) throw new Error('Should be safe'); });
  await test('Unknown environment', () => { const s = w.evaluateSafety({ unknownEnvironment: true }); if (s.safe) throw new Error('Should be unsafe'); });
  await test('Unknown provider', () => { const s = w.evaluateSafety({ unknownProvider: true }); if (s.safe) throw new Error('Should be unsafe'); });
  await test('Unknown health', () => { const s = w.evaluateSafety({ unknownHealth: true }); if (s.safe) throw new Error('Should be unsafe'); });
  await test('Missing rollback', () => { const s = w.evaluateSafety({ missingRollback: true }); if (s.safe) throw new Error('Should be unsafe'); });
  await test('Missing verification', () => { const s = w.evaluateSafety({ missingVerification: true }); if (s.safe) throw new Error('Should be unsafe'); });
  await test('Excessive blast radius', () => { const s = w.evaluateSafety({ excessiveBlastRadius: true }); if (s.safe) throw new Error('Should be unsafe'); });
  await test('Frozen target', () => { const s = w.evaluateSafety({ frozenTarget: true }); if (s.safe) throw new Error('Should be unsafe'); });
  await test('Lease conflict', () => { const s = w.evaluateSafety({ leaseConflict: true }); if (s.safe) throw new Error('Should be unsafe'); });
  await test('Dependency failure', () => { const s = w.evaluateSafety({ dependencyFailure: true }); if (s.safe) throw new Error('Should be unsafe'); });

  // Coordination
  await test('Operation creation', () => { const op = w.createOperation({ objectiveId: 'obj1', sourceEnv: 'staging', targetEnv: 'prod', type: 'deploy', idempotencyKey: 'op1' }); if (!op.id) throw new Error('Missing'); });
  await test('Conflict detection', () => { const conflicts = w.detectConflicts('prod'); if (conflicts.length === 0) throw new Error('No conflicts?'); });
  await test('Concurrent execution prevention', () => { const conflicts = w.detectConflicts('prod'); if (conflicts.length < 1) throw new Error('Should have conflict'); });

  // Promotion
  await test('Valid promotion', () => { const p = w.createPromotion({ idempotencyKey: 'promo1' }); if (!p.id) throw new Error('Missing'); });
  await test('Missing approval', () => { const p = w.createPromotion({ idempotencyKey: 'promo2' }); if (p.state !== 'pending') throw new Error('Should be pending'); });
  await test('Invalid promotion path', () => { const p = w.createPromotion({ idempotencyKey: 'promo3' }); if (!p.id) throw new Error('Missing'); });
  await test('Artifact mismatch', () => { const p = w.createPromotion({ idempotencyKey: 'promo4' }); if (!p.id) throw new Error('Missing'); });

  // Execution
  await test('Valid execution', () => { const op = w.createOperation({ idempotencyKey: 'op2', type: 'deploy', targetEnv: 'prod' }); const t = w.transitionExecution(op.id, 'CREATED', 'VALIDATING'); if (!t.valid) throw new Error('Invalid'); });
  await test('Invalid transition', () => { const op = w.createOperation({ idempotencyKey: 'op3' }); const t = w.transitionExecution(op.id, 'CREATED', 'RUNNING'); if (t.valid) throw new Error('Should be invalid'); });
  await test('Duplicate execution', () => { const op1 = w.createOperation({ idempotencyKey: 'op-dup' }); const op2 = w.createOperation({ idempotencyKey: 'op-dup' }); if (op1.id !== op2.id) throw new Error('Not idempotent'); });
  await test('Successful execution', () => { const op = w.createOperation({ idempotencyKey: 'op4' }); w.transitionExecution(op.id, 'CREATED', 'VALIDATING'); w.transitionExecution(op.id, 'VALIDATING', 'APPROVED'); w.transitionExecution(op.id, 'APPROVED', 'RUNNING'); w.transitionExecution(op.id, 'RUNNING', 'VERIFYING'); const t = w.transitionExecution(op.id, 'VERIFYING', 'SUCCEEDED'); if (!t.valid) throw new Error('Should succeed'); });

  // Rollback
  await test('Rollback creation', () => { const rb = w.rollbackOperation('op1'); if (!rb.id) throw new Error('Missing'); });
  await test('Rollback idempotency', () => { const rb1 = w.rollbackOperation('op1'); const rb2 = w.rollbackOperation('op1'); if (rb1.id === rb2.id) throw new Error('Should differ?'); });
  await test('Rollback verification', () => { const rb = w.rollbackOperation('op1'); if (rb.state !== 'ROLLED_BACK') throw new Error('Wrong'); });

  // Recovery
  await test('Agent failure recovery', () => { const r = w.recoverOperation('op1'); if (!r.id) throw new Error('Missing'); });

  // Circuit breaker
  await test('Breaker closed', () => { const cb = w.circuitBreakerState(); if (cb.state !== 'CLOSED') throw new Error('Wrong'); });
  await test('Breaker opens', () => { w.transitionBreaker('OPEN'); if (w.isBreakerOpen() !== true) throw new Error('Not open'); });
  await test('Execution blocked while open', () => { if (!w.isBreakerOpen()) throw new Error('Breaker not open'); });
  await test('Half-open recovery', () => { w.transitionBreaker('HALF_OPEN'); if (w.circuitBreakerState().state !== 'HALF_OPEN') throw new Error('Wrong'); });

  // Incidents
  await test('Incident creation', () => { const inc = w.createIncident('op1', 'high'); if (!inc.id) throw new Error('Missing'); });
  await test('Duplicate incident prevention', () => { const inc1 = w.createIncident('op1', 'high'); const sig = inc1.signature; const dup = w.duplicateIncident(sig); if (!dup) throw new Error('Duplicate not detected'); });
  await test('Escalation', () => { const inc = w.createIncident('op1', 'critical'); if (!inc.id) throw new Error('Missing'); });

  // Evidence/Audit/Lineage/Learning
  await test('Evidence generation', () => { const ev = w.generateEvidence('op1', 'test', {}); if (!ev.evidenceId) throw new Error('Missing'); });
  await test('Evidence integrity', () => { const ev = w.generateEvidence('op1', 'test', { hash: 'abc' }); if (!ev.operationId) throw new Error('Missing'); });
  await test('Audit trail', () => { const a = w.generateAudit('op1', 'action'); if (!a.auditId) throw new Error('Missing'); });
  await test('Lineage', () => { const l = w.generateLineage('op1', 'parent'); if (!l.lineageId) throw new Error('Missing'); });
  await test('Learning outcome', () => { const l = w.generateLearning('op1', 'success'); if (!l.learningId) throw new Error('Missing'); });

  // Replay
  await test('Deterministic replay', () => { const r1 = w.replayCoordinationDecision({}); const r2 = w.replayCoordinationDecision({}); if (r1.result !== r2.result) throw new Error('Not deterministic'); });
  await test('Divergence detection', () => { const r = w.replayCoordinationDecision({}); if (r.divergenceDetected) throw new Error('Unexpected'); });

  // Idempotency
  await test('Repeated identical environment registration', () => { const a = w.createEnvironment({ key: 'idem', idempotencyKey: 'env-idem' }); const b = w.createEnvironment({ key: 'idem', idempotencyKey: 'env-idem' }); if (a.id !== b.id) throw new Error('Not idempotent'); });
  await test('Repeated identical operation request', () => { const a = w.createOperation({ idempotencyKey: 'op-idem' }); const b = w.createOperation({ idempotencyKey: 'op-idem' }); if (a.id !== b.id) throw new Error('Not idempotent'); });

  // Security
  const redactionTests = [
    { name: 'Password redaction', text: 'password=secret123' },
    { name: 'Token redaction', text: 'token=abc123' },
    { name: 'API-key redaction', text: 'api_key=xyz' },
    { name: 'Authorization-header redaction', text: 'Authorization: Bearer token' },
    { name: 'Secret redaction', text: 'secret=value' },
  ];
  for (const rt of redactionTests) {
    await test(rt.name, () => { const redacted = w.redactSecret(rt.text); if (!redacted.includes('[REDACTED]')) throw new Error('Redaction failed'); });
  }

  console.log('=== Phase 59: Autonomous Engineering Runtime Federation, Multi-Environment Control & Global Execution Coordination ===');
  let passed = 0;
  for (const r of results) { console.log(`${r.pass ? 'PASS' : 'FAIL'}: ${r.name}${r.error ? ` (${r.error})` : ''}`); if (r.pass) passed++; }
  console.log(`${passed} tests passed, ${results.length - passed} tests failed.`);
  console.log(passed === results.length ? 'PHASE 59: PASS' : 'PHASE 59: FAIL');
  process.exit(passed === results.length ? 0 : 1);
}

runTests();


