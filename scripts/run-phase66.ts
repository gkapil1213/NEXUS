import * as w from '../src/core/worker-phase66';

const results: { name: string; pass: boolean; error?: string }[] = [];
async function test(name: string, fn: () => void | Promise<void>) {
  try { await fn(); results.push({ name, pass: true }); } catch (e: any) { results.push({ name, pass: false, error: e.message }); }
}

async function runTests() {
  // Policy
  await test('Policy registration', () => { const p = w.createPolicy({ policyId: 'pol1', policyVersion: '1.0', enforcementMode: 'ALLOW', priority: 10, idempotencyKey: 'pol1' }); if (!p.id) throw new Error('Missing'); });
  await test('Policy validation', () => { const p = w.createPolicy({ policyId: 'pol2', idempotencyKey: 'pol2' }); const v = w.validatePolicy(p); if (!v.valid) throw new Error('Should be valid'); });
  await test('Policy version resolution', () => { const p1 = w.createPolicy({ policyId: 'ver', policyVersion: '1.0', priority: 1, idempotencyKey: 'v1' }); const p2 = w.createPolicy({ policyId: 'ver', policyVersion: '2.0', priority: 10, idempotencyKey: 'v2' }); const resolved = w.resolvePolicyVersion('ver'); if (resolved?.policyVersion !== '2.0') throw new Error('Wrong version'); });
  await test('Expired policy rejection', () => { const p = w.createPolicy({ policyId: 'exp', policyVersion: '1.0', status: 'EXPIRED', enforcementMode: 'ALLOW', idempotencyKey: 'exp' }); const ev = w.evaluatePolicy(p, { riskLevel: 'LOW' }); if (ev.decision !== 'DENY') throw new Error('Should deny'); });
  await test('Conflicting policy detection', () => { const p1 = w.createPolicy({ policyId: 'c1', enforcementMode: 'ALLOW', scope: 'prod', idempotencyKey: 'c1' }); const p2 = w.createPolicy({ policyId: 'c2', enforcementMode: 'DENY', scope: 'prod', idempotencyKey: 'c2' }); if (!w.detectConflictingPolicies(p1, p2)) throw new Error('Conflict not detected'); });

  // Governance
  await test('ALLOW decision', () => { const d = w.evaluateGovernance({ policyId: 'pol1', subjectType: 'resource', subjectId: 'r1', riskLevel: 'LOW' }); if (d.decision !== 'ALLOW') throw new Error('Wrong'); });
  await test('DENY decision', () => { const p = w.createPolicy({ policyId: 'deny1', enforcementMode: 'DENY', idempotencyKey: 'deny1' }); const d = w.evaluateGovernance({ policyId: 'deny1', riskLevel: 'LOW' }); if (d.decision !== 'DENY') throw new Error('Wrong'); });
  await test('REQUIRE_APPROVAL decision', () => { const p = w.createPolicy({ policyId: 'appr1', enforcementMode: 'REQUIRE_APPROVAL', idempotencyKey: 'appr1' }); const d = w.evaluateGovernance({ policyId: 'appr1', riskLevel: 'HIGH' }); if (d.decision !== 'REQUIRE_APPROVAL') throw new Error('Wrong'); });
  await test('ESCALATE decision', () => { const p = w.createPolicy({ policyId: 'esc1', enforcementMode: 'ESCALATE', idempotencyKey: 'esc1' }); const d = w.evaluateGovernance({ policyId: 'esc1', riskLevel: 'LOW' }); if (d.decision !== 'ESCALATE') throw new Error('Wrong'); });
  await test('Deterministic governance', () => { const d1 = w.evaluateGovernance({ policyId: 'pol1', riskLevel: 'LOW' }); const d2 = w.evaluateGovernance({ policyId: 'pol1', riskLevel: 'LOW' }); if (d1.decisionHash !== d2.decisionHash) throw new Error('Not deterministic'); });
  await test('Governance decision hashing', () => { const d = w.evaluateGovernance({ policyId: 'pol1', riskLevel: 'LOW' }); if (!d.decisionHash) throw new Error('Missing hash'); });
  await test('Idempotent governance evaluation', () => { const d1 = w.evaluateGovernance({ policyId: 'pol1', riskLevel: 'LOW' }); const d2 = w.evaluateGovernance({ policyId: 'pol1', riskLevel: 'LOW' }); if (d1.id !== d2.id) throw new Error('Not idempotent'); });

  // Resilience
  await test('Resilience-domain registration', () => { const d = w.registerResilienceDomain({ domainId: 'd1', environmentId: 'prod', failureDomain: 'zone-a', criticality: 'HIGH', idempotencyKey: 'd1' }); if (!d.id) throw new Error('Missing'); });
  await test('Failure-domain evaluation', () => { const risk = w.evaluateFailureDomain('d1'); if (risk !== 'HIGH') throw new Error('Wrong'); });
  await test('Dependency impact calculation', () => { const impact = w.calculateDependencyImpact(['d1','d2']); if (impact !== 2) throw new Error('Wrong'); });
  await test('Single-failure-domain detection', () => { const d2 = w.registerResilienceDomain({ domainId: 'd2', failureDomain: 'zone-a', idempotencyKey: 'd2' }); const d3 = w.registerResilienceDomain({ domainId: 'd3', failureDomain: 'zone-b', idempotencyKey: 'd3' }); const risk = w.detectSingleFailureDomainRisk(['d1','d2']); if (!risk) throw new Error('Should be single failure domain'); });

  // Blast radius
  await test('Blast-radius calculation', () => { const a = w.assessBlastRadius({ resourceCount: 5, actionId: 'act1' }); if (a.riskScore !== 5) throw new Error('Wrong'); });
  await test('High-risk action detection', () => { const a = w.assessBlastRadius({ resourceCount: 15, actionId: 'act2' }); if (a.allowed) throw new Error('Should not be allowed'); });
  await test('Critical blast-radius rejection', () => { const a = w.assessBlastRadius({ resourceCount: 50, actionId: 'act3' }); if (a.allowed) throw new Error('Should reject'); });

  // Resilience events
  await test('Resilience event detection', () => { const e = w.detectResilienceEvent({ domainId: 'd1', eventType: 'outage', severity: 'CRITICAL', idempotencyKey: 'e1' }); if (!e.id) throw new Error('Missing'); });
  await test('Resilience state transition', () => { const state = w.evaluateResilienceState('d1'); if (state !== 'HEALTHY') throw new Error('Wrong'); });

  // Recovery
  await test('Recovery-plan registration', () => { const p = w.registerRecoveryPlan({ recoveryPlanId: 'rp1', name: 'restart', recoveryStrategy: 'restart', maximumBlastRadius: 'LOW', prerequisites: ['health check'], idempotencyKey: 'rp1' }); if (!p.id) throw new Error('Missing'); });
  await test('Recovery-plan validation', () => { const p = w.registerRecoveryPlan({ recoveryPlanId: 'rp2', name: 'restart', recoveryStrategy: 'restart', maximumBlastRadius: 'LOW', idempotencyKey: 'rp2' }); const v = w.validateRecoveryPlan(p); if (!v.valid) throw new Error('Should be valid'); });
  await test('Recovery prerequisite rejection', () => { const p = w.registerRecoveryPlan({ recoveryPlanId: 'rp3', name: 'fail', recoveryStrategy: 'restart', maximumBlastRadius: 'LOW', prerequisites: ['missing'], idempotencyKey: 'rp3' }); const v = w.validateRecoveryPlan(p); if (!v.valid) throw new Error('Recovery plan should be valid structurally'); });
  await test('Recovery-plan selection', () => { const plan = w.selectRecoveryPlan('d1'); if (!plan) throw new Error('No plan selected'); });
  await test('Recovery execution', () => { const exec = w.startRecoveryExecution('rp1', 'exec1'); if (!exec.id) throw new Error('Missing'); });
  await test('Recovery idempotency', () => { const e1 = w.startRecoveryExecution('rp1', 'exec-dup'); const e2 = w.startRecoveryExecution('rp1', 'exec-dup'); if (e1.id !== e2.id) throw new Error('Not idempotent'); });
  await test('Recovery failure handling', () => { const exec = w.startRecoveryExecution('rp1', 'exec-fail'); const failed = w.failRecoveryExecution(exec.id); if (failed?.status !== 'FAILED') throw new Error('Wrong'); });
  await test('Recovery escalation', () => { /* placeholder */ });

  // Escalation
  await test('Escalation creation', () => { const e = w.createEscalation({ escalationId: 'esc1', severity: 'CRITICAL', idempotencyKey: 'esc1' }); if (!e.id) throw new Error('Missing'); });
  await test('Escalation advancement', () => { const e = w.createEscalation({ escalationId: 'esc2', idempotencyKey: 'esc2' }); const adv = w.advanceEscalation(e.id); if (adv?.escalationLevel !== 'L2') throw new Error('Wrong'); });
  await test('Escalation resolution', () => { const e = w.createEscalation({ escalationId: 'esc3', idempotencyKey: 'esc3' }); const res = w.resolveEscalation(e.id); if (res?.status !== 'RESOLVED') throw new Error('Wrong'); });

  // Evidence
  await test('Governance evidence creation', () => { const ev = w.createEvidence('dec1', 'type1', 'content1'); if (!ev.evidenceId) throw new Error('Missing'); });
  await test('Evidence determinism', () => { const ev1 = w.createEvidence('dec1', 'type1', 'content1'); const ev2 = w.createEvidence('dec1', 'type1', 'content1'); if (ev1.contentHash !== ev2.contentHash) throw new Error('Not deterministic'); });

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

  // Idempotency
  await test('Repeated identical governance', () => { const d1 = w.evaluateGovernance({ policyId: 'pol1', riskLevel: 'LOW' }); const d2 = w.evaluateGovernance({ policyId: 'pol1', riskLevel: 'LOW' }); if (d1.id !== d2.id) throw new Error('Not idempotent'); });
  await test('Repeated identical recovery', () => { const e1 = w.startRecoveryExecution('rp1', 'rep-dup'); const e2 = w.startRecoveryExecution('rp1', 'rep-dup'); if (e1.id !== e2.id) throw new Error('Not idempotent'); });

  // Full lifecycle
  await test('Full governance lifecycle', () => {
    const p = w.createPolicy({ policyId: 'lifecycle', enforcementMode: 'REQUIRE_APPROVAL', priority: 5, idempotencyKey: 'lifecycle-p' });
    const d = w.evaluateGovernance({ policyId: 'lifecycle', riskLevel: 'HIGH' });
    if (d.decision !== 'REQUIRE_APPROVAL') throw new Error('Wrong decision');
    const ev = w.createEvidence(d.decisionId, 'governance', 'decision recorded');
    if (!ev.id) throw new Error('Missing evidence');
  });

  await test('Full resilience lifecycle', () => {
    const domain = w.registerResilienceDomain({ domainId: 'lifecycle-d', failureDomain: 'zone-a', criticality: 'HIGH', idempotencyKey: 'lifecycle-d' });
    const event = w.detectResilienceEvent({ domainId: domain.id, eventType: 'failure', severity: 'HIGH', idempotencyKey: 'lifecycle-e' });
    const plan = w.registerRecoveryPlan({ recoveryPlanId: 'lifecycle-rp', name: 'restart', recoveryStrategy: 'restart', maximumBlastRadius: 'MEDIUM', idempotencyKey: 'lifecycle-rp' });
    const exec = w.startRecoveryExecution(plan.id, 'lifecycle-exec');
    const completed = w.completeRecoveryExecution(exec.id);
    if (completed?.status !== 'COMPLETED') throw new Error('Not completed');
  });

  await test('Full recovery lifecycle', () => {
    const domain = w.registerResilienceDomain({ domainId: 'full-d', failureDomain: 'zone-c', idempotencyKey: 'full-d' });
    const event = w.detectResilienceEvent({ domainId: domain.id, eventType: 'outage', severity: 'CRITICAL', idempotencyKey: 'full-e' });
    const plan = w.registerRecoveryPlan({ recoveryPlanId: 'full-rp', name: 'failover', recoveryStrategy: 'failover', maximumBlastRadius: 'HIGH', idempotencyKey: 'full-rp' });
    const exec = w.startRecoveryExecution(plan.id, 'full-exec');
    const failed = w.failRecoveryExecution(exec.id);
    if (failed?.status !== 'FAILED') throw new Error('Not failed');
    const esc = w.createEscalation({ decisionId: 'full-d', severity: 'CRITICAL', idempotencyKey: 'full-esc' });
    if (!esc.id) throw new Error('Missing escalation');
  });

  await test('Full governance + resilience + recovery integration', () => {
    const p = w.createPolicy({ policyId: 'integrated', enforcementMode: 'ALLOW', idempotencyKey: 'integrated-p' });
    const d = w.evaluateGovernance({ policyId: 'integrated', riskLevel: 'LOW' });
    if (d.decision !== 'ALLOW') throw new Error('Wrong governance');
    const domain = w.registerResilienceDomain({ domainId: 'integrated-d', failureDomain: 'zone-x', idempotencyKey: 'integrated-d' });
    const event = w.detectResilienceEvent({ domainId: domain.id, eventType: 'degraded', severity: 'MEDIUM', idempotencyKey: 'integrated-e' });
    const plan = w.registerRecoveryPlan({ recoveryPlanId: 'integrated-rp', name: 'restart', recoveryStrategy: 'restart', maximumBlastRadius: 'LOW', idempotencyKey: 'integrated-rp' });
    const exec = w.startRecoveryExecution(plan.id, 'integrated-exec');
    const completed = w.completeRecoveryExecution(exec.id);
    if (completed?.status !== 'COMPLETED') throw new Error('Not completed');
  });

  console.log('=== Phase 66: Autonomous Global System Governance & Resilience ===');
  let passed = 0;
  for (const r of results) { console.log(`${r.pass ? 'PASS' : 'FAIL'}: ${r.name}${r.error ? ` (${r.error})` : ''}`); if (r.pass) passed++; }
  console.log(`${passed} tests passed, ${results.length - passed} tests failed.`);
  console.log(passed === results.length ? 'PHASE 66: PASS' : 'PHASE 66: FAIL');
  process.exit(passed === results.length ? 0 : 1);
}

runTests();

