import * as w from '../src/core/worker-phase69';

const results: { name: string; pass: boolean; error?: string }[] = [];
async function test(name: string, fn: () => void | Promise<void>) {
  try { await fn(); results.push({ name, pass: true }); } catch (e: any) { results.push({ name, pass: false, error: e.message }); }
}

async function runTests() {
  // Observation
  await test('Observation ingestion', () => { const o = w.ingestObservation({ sourceType: 'deployment', idempotencyKey: 'obs1' }); if (!o.id) throw new Error('Missing'); });
  await test('Observation idempotency', () => { const a = w.ingestObservation({ sourceType: 'x', idempotencyKey: 'obs-dup' }); const b = w.ingestObservation({ sourceType: 'x', idempotencyKey: 'obs-dup' }); if (a.id !== b.id) throw new Error('Not idempotent'); });
  await test('Observation validation', () => { const o = w.ingestObservation({ sourceType: 'deployment', confidence: 0.5 }); if (o.confidence !== 0.5) throw new Error('Wrong'); });

  // Correlation
  await test('Correlation', () => { const c = w.correlateObservations(['o1','o2'], 'CAUSAL', 0.8); if (!c.id) throw new Error('Missing'); });
  await test('Correlation vs causation distinction', () => { const c = w.correlateObservations(['a','b'], 'CORRELATION', 0.5); if (c.isCausal) throw new Error('Should not be causal'); });

  // Pattern & Lesson
  await test('Learned pattern generation', () => { const p = w.learnPattern({ description: 'restart pattern', confidence: 0.7, idempotencyKey: 'p1' }); if (!p.id) throw new Error('Missing'); });
  await test('Lesson validation', () => { const l = w.validateLesson({ lessonContent: 'restart works', confidence: 0.8, idempotencyKey: 'l1' }); if (l.state !== 'VALIDATED') throw new Error('Wrong'); });
  await test('Insufficient evidence', () => { try { w.validateLesson({ lessonContent: 'x', confidence: 0.1 }); throw new Error('Should fail'); } catch (e: any) { if (!e.message.includes('Insufficient')) throw e; } });
  await test('Contradictory evidence', () => { try { w.validateLesson({ lessonContent: 'x', confidence: 0.9, contradictoryEvidence: ['e1'] }); throw new Error('Should fail'); } catch (e: any) { if (!e.message.includes('Contradictory')) throw e; } });

  // Improvement
  await test('Improvement proposal', () => { const c = w.proposeImprovement({ description: 'improve gate', idempotencyKey: 'c1' }); if (!c.id) throw new Error('Missing'); });
  await test('Risk classification', () => { const risk = w.assessAdaptationRisk({ productionImpact: 8 }); if (risk !== 'HIGH' && risk !== 'CRITICAL') throw new Error('Wrong'); });
  await test('Governance enforcement', () => { const gov = w.evaluateGovernance('CRITICAL'); if (gov.approvalRequired !== true) throw new Error('Should require approval'); });

  // Adaptation
  await test('Authorized adaptation', () => { const p = { id: 'p1', proposalId: 'p1', candidateId: 'c1', riskLevel: 'LOW', approvalRequired: false, status: 'PROPOSED', idempotencyKey: 'p1', createdAt: '', updatedAt: '' }; const r = w.applyAuthorizedAdaptation(p, false); if (r.status !== 'APPLIED') throw new Error('Should apply'); });
  await test('Unauthorized adaptation', () => { const p = { id: 'p2', proposalId: 'p2', candidateId: 'c1', riskLevel: 'CRITICAL', approvalRequired: true, status: 'PROPOSED', idempotencyKey: 'p2', createdAt: '', updatedAt: '' }; const r = w.applyAuthorizedAdaptation(p, false); if (r.status !== 'APPROVAL_REQUIRED') throw new Error('Should block'); });
  await test('Verification', () => { const v = w.verifyAdaptation('p1', 'ok', 'ok'); if (!v.verified) throw new Error('Should verify'); });
  await test('Rollback', () => { const rb = w.rollbackAdaptation('p1'); if (rb.status !== 'ROLLED_BACK') throw new Error('Wrong'); });

  // Replay
  await test('Deterministic replay', () => { const input = { sourceType: 'test', idempotencyKey: 'replay' }; const r1 = w.replayLearning(input); const r2 = w.replayLearning(input); if (r1.divergenceDetected !== r2.divergenceDetected) throw new Error('Not deterministic'); });

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

  // Full lifecycle
  await test('Full lifecycle', () => {
    const obs = w.ingestObservation({ sourceType: 'deployment', idempotencyKey: 'full-obs' });
    const corr = w.correlateObservations([obs.id], 'CAUSAL', 0.6);
    const pattern = w.learnPattern({ description: 'deploy pattern', confidence: 0.7, idempotencyKey: 'full-pattern' });
    const lesson = w.validateLesson({ lessonContent: 'deploy works', confidence: 0.8, idempotencyKey: 'full-lesson' });
    const candidate = w.proposeImprovement({ description: 'improve deploy', lessonId: lesson.id, idempotencyKey: 'full-candidate' });
    const risk = w.assessAdaptationRisk({ productionImpact: 5 });
    const gov = w.evaluateGovernance(risk);
    const proposal = { id: 'full-proposal', proposalId: 'full-proposal', candidateId: candidate.id, riskLevel: risk, approvalRequired: gov.approvalRequired, status: 'PROPOSED', idempotencyKey: 'full-proposal', createdAt: '', updatedAt: '' };
    const applied = w.applyAuthorizedAdaptation(proposal, gov.approvalRequired ? true : false);
    if (applied.status !== 'APPLIED') throw new Error('Adaptation failed');
    const verified = w.verifyAdaptation(proposal.id, 'ok', 'ok');
    if (!verified.verified) throw new Error('Verification failed');
    const outcome = { obs, corr, pattern, lesson, candidate, risk, gov, applied, verified };
    if (!outcome) throw new Error('Missing outcome');
  });

  console.log('=== Phase 69: Autonomous Enterprise Learning & Continuous Improvement ===');
  let passed = 0;
  for (const r of results) { console.log(`${r.pass ? 'PASS' : 'FAIL'}: ${r.name}${r.error ? ` (${r.error})` : ''}`); if (r.pass) passed++; }
  console.log(`${passed} tests passed, ${results.length - passed} tests failed.`);
  console.log(passed === results.length ? 'PHASE 69: PASS' : 'PHASE 69: FAIL');
  process.exit(passed === results.length ? 0 : 1);
}

runTests();
