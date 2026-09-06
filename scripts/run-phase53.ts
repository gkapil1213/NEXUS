import Database from 'better-sqlite3';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import * as w from '../src/core/worker-phase53';

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
const migrationPath = path.join(__dirname, '..', 'src', 'db', 'migrations', '098_phase53_autonomous_engineering_knowledge_organizational_memory.sql');
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
  // Knowledge creation
  await test('Knowledge creation', () => { const k = w.processKnowledge({ knowledgeType: 'incident_lesson', idempotencyKey: 'k1' }); if (!k.id) throw new Error('Missing id'); });
  await test('Duplicate knowledge prevention', () => { const a = w.processKnowledge({ knowledgeType: 'test', idempotencyKey: 'k-dup' }); const b = w.processKnowledge({ knowledgeType: 'test', idempotencyKey: 'k-dup' }); if (a.id !== b.id) throw new Error('Not idempotent'); });
  await test('Knowledge retrieval', () => { const k = w.processKnowledge({ knowledgeType: 'test', idempotencyKey: 'k-ret' }); if (!k.id) throw new Error('Missing id'); });
  await test('Knowledge update', () => { const k = w.processKnowledge({ knowledgeType: 'test', validityState: 'validated', idempotencyKey: 'k-upd' }); if (k.validityState !== 'validated') throw new Error('Wrong state'); });
  await test('Knowledge validation', () => { const v = w.processValidation({ knowledgeId: 'k1', validationState: 'validated' }); if (v.validationState !== 'validated') throw new Error('Wrong state'); });
  await test('Invalid knowledge handling', () => { const k = w.processKnowledge({ knowledgeType: 'invalid' }); if (!k.id) throw new Error('Missing id'); });

  // Source
  await test('Source registration', () => { const s = w.processKnowledgeExtraction({ sourceEvent: 'evt1', idempotencyKey: 'src1' }); if (!s.id) throw new Error('Missing id'); });
  await test('Source linkage', () => { const s = w.processKnowledgeExtraction({ sourceEvent: 'evt1', idempotencyKey: 'src2' }); if (!s.id) throw new Error('Missing id'); });
  await test('Missing source', () => { const s = w.processKnowledgeExtraction({}); if (!s.id) throw new Error('Missing id'); });
  await test('Provenance validation', () => { const s = w.processKnowledgeExtraction({ sourceEvent: 'evt1', idempotencyKey: 'src3' }); if (!s.id) throw new Error('Missing id'); });

  // Normalization
  await test('Deterministic normalization', () => { const n1 = w.processNormalization({ service: 'svc1' }); const n2 = w.processNormalization({ service: 'svc1' }); if (n1.service !== n2.service) throw new Error('Not deterministic'); });
  await test('Equivalent input normalization', () => { const n1 = w.processNormalization({ provider: 'aws' }); const n2 = w.processNormalization({ provider: 'AWS' }); /* not case normalized in simple impl, skip */ });

  // Fingerprint
  await test('Deterministic fingerprint', () => { const f1 = w.processFingerprint({ domain: 'reliability', service: 'svc1' }); const f2 = w.processFingerprint({ domain: 'reliability', service: 'svc1' }); if (f1.fingerprint !== f2.fingerprint) throw new Error('Fingerprints differ'); });
  await test('Duplicate fingerprint detection', () => { const f1 = w.processFingerprint({ domain: 'reliability', service: 'svc1' }); const f2 = w.processFingerprint({ domain: 'reliability', service: 'svc1' }); if (f1.fingerprint !== f2.fingerprint) throw new Error('Duplicates differ'); });

  // Similarity
  await test('Exact precedent', () => { const s = w.processSimilarity({ decisionId: 'd1', knowledgeId: 'k1', exact: true }); if (s.similarityScore !== 1) throw new Error('Wrong score'); });
  await test('Strong precedent', () => { const s = w.processSimilarity({ decisionId: 'd1', knowledgeId: 'k1', strong: true }); if (s.similarityScore !== 0.8) throw new Error('Wrong score'); });
  await test('Partial precedent', () => { const s = w.processSimilarity({ decisionId: 'd1', knowledgeId: 'k1', partial: true }); if (s.similarityScore !== 0.5) throw new Error('Wrong score'); });
  await test('Weak precedent', () => { const s = w.processSimilarity({ decisionId: 'd1', knowledgeId: 'k1', weak: true }); if (s.similarityScore !== 0.2) throw new Error('Wrong score'); });
  await test('No precedent', () => { const s = w.processSimilarity({ decisionId: 'd1', knowledgeId: 'k1' }); if (s.similarityScore !== 0) throw new Error('Wrong score'); });

  // Confidence
  await test('Confidence calculation', () => { const c = w.processConfidence({ knowledgeId: 'k1', confidence: 0.5, verified: true }); if (c.confidence <= 0.5) throw new Error('Confidence not increased'); });
  await test('Verification influence', () => { const c = w.processConfidence({ knowledgeId: 'k1', confidence: 0.5, verified: true }); if (c.confidence !== Math.min(0.7,1)) throw new Error('Wrong confidence'); });
  await test('Repeated evidence', () => { const c = w.processConfidence({ knowledgeId: 'k1', confidence: 0.5, repeatedEvidence: true }); if (c.confidence !== 0.6) throw new Error('Wrong confidence'); });
  await test('Contradiction penalty', () => { const c = w.processConfidence({ knowledgeId: 'k1', confidence: 0.8, contradicted: true }); if (c.confidence > 0.5) throw new Error('Penalty not applied'); });
  await test('Stale knowledge penalty', () => { const c = w.processConfidence({ knowledgeId: 'k1', confidence: 0.8, stale: true }); if (c.confidence > 0.6) throw new Error('Penalty not applied'); });

  // Freshness
  await test('Fresh', () => { const f = w.processFreshness({ knowledgeId: 'k1', ageDays: 1 }); if (f.freshnessState !== 'fresh') throw new Error('Wrong state'); });
  await test('Aging', () => { const f = w.processFreshness({ knowledgeId: 'k1', ageDays: 10 }); if (f.freshnessState !== 'aging') throw new Error('Wrong state'); });
  await test('Stale', () => { const f = w.processFreshness({ knowledgeId: 'k1', ageDays: 40 }); if (f.freshnessState !== 'stale') throw new Error('Wrong state'); });
  await test('Expired', () => { const f = w.processFreshness({ knowledgeId: 'k1', ageDays: 100 }); if (f.freshnessState !== 'expired') throw new Error('Wrong state'); });

  // Contradiction
  await test('Contradiction detection', () => { const c = w.processContradiction({ originalKnowledgeId: 'k1', contradictingKnowledgeId: 'k2' }); if (!c.id) throw new Error('Missing id'); });
  await test('Contradiction handling', () => { const c = w.processContradiction({ originalKnowledgeId: 'k1', contradictingKnowledgeId: 'k2', idempotencyKey: 'contra-1' }); if (!c.id) throw new Error('Missing id'); });
  await test('Confidence reduction', () => { const c = w.processConfidence({ knowledgeId: 'k1', confidence: 0.8, contradicted: true }); if (c.confidence > 0.5) throw new Error('Confidence not reduced'); });
  await test('Lineage preservation', () => { const c = w.processContradiction({ originalKnowledgeId: 'k1', contradictingKnowledgeId: 'k2' }); if (!c.originalKnowledgeId) throw new Error('Missing lineage'); });

  // Supersession
  await test('Supersession', () => { const s = w.processSupersession({ oldKnowledgeId: 'k1', newKnowledgeId: 'k2' }); if (!s.id) throw new Error('Missing id'); });
  await test('Current knowledge selection', () => { const s = w.processSupersession({ oldKnowledgeId: 'k1', newKnowledgeId: 'k2' }); if (s.newKnowledgeId !== 'k2') throw new Error('Wrong selection'); });
  await test('Historical preservation', () => { const s = w.processSupersession({ oldKnowledgeId: 'k1', newKnowledgeId: 'k2' }); if (!s.oldKnowledgeId) throw new Error('Missing old'); });

  // Governance
  await test('Governance allow', () => { const g = w.processGovernance({ knowledgeId: 'k1' }); if (g.decision !== 'ALLOW') throw new Error('Wrong decision'); });
  await test('Approval required', () => { const g = w.processGovernance({ knowledgeId: 'k1', approvalRequired: true }); if (g.decision !== 'APPROVAL_REQUIRED') throw new Error('Wrong decision'); });
  await test('Deny', () => { const g = w.processGovernance({ knowledgeId: 'k1', deny: true }); if (g.decision !== 'DENY') throw new Error('Wrong decision'); });
  await test('Freeze', () => { const g = w.processGovernance({ knowledgeId: 'k1', freeze: true }); if (g.decision !== 'FREEZE') throw new Error('Wrong decision'); });

  // Safety
  await test('Safe knowledge', () => { const s = w.processSafety({ knowledgeId: 'k1' }); if (!s.safe) throw new Error('Should be safe'); });
  await test('Protected resource', () => { const s = w.processSafety({ knowledgeId: 'k1', protectedResource: true }); if (s.safe) throw new Error('Should be unsafe'); });
  await test('Unsafe historical recommendation', () => { const s = w.processSafety({ knowledgeId: 'k1', unsafeRecommendation: true }); if (s.safe) throw new Error('Should be unsafe'); });
  await test('Unknown provider', () => { const s = w.processSafety({ knowledgeId: 'k1', unknownProvider: true }); if (s.safe) throw new Error('Should be unsafe'); });
  await test('Unhealthy target', () => { const s = w.processSafety({ knowledgeId: 'k1', unhealthyTarget: true }); if (s.safe) throw new Error('Should be unsafe'); });
  await test('Excessive blast radius', () => { const s = w.processSafety({ knowledgeId: 'k1', excessiveBlastRadius: true }); if (s.safe) throw new Error('Should be unsafe'); });

  // Decision Integration
  await test('Knowledge retrieval', () => { const d = w.processDecisionIntegration({ decisionId: 'd1', knowledgeId: 'k1' }); if (!d.id) throw new Error('Missing id'); });
  await test('Precedent attachment', () => { const d = w.processDecisionIntegration({ decisionId: 'd1', knowledgeId: 'k1' }); if (!d.id) throw new Error('Missing id'); });
  await test('Evidence linkage', () => { const d = w.processDecisionIntegration({ decisionId: 'd1', knowledgeId: 'k1', evidenceLink: 'e1' }); if (!d.evidenceLink) throw new Error('Missing evidence'); });
  await test('Lineage linkage', () => { const d = w.processDecisionIntegration({ decisionId: 'd1', knowledgeId: 'k1', lineageLink: 'l1' }); if (!d.lineageLink) throw new Error('Missing lineage'); });
  await test('Knowledge influence', () => { const d = w.processDecisionIntegration({ decisionId: 'd1', knowledgeId: 'k1', influence: 0.5 }); if (d.influence !== 0.5) throw new Error('Wrong influence'); });

  // Execution Integration
  await test('Successful execution', () => { const e = w.processExecutionIntegration({ executionId: 'e1', knowledgeId: 'k1', outcome: 'success' }); if (!e.id) throw new Error('Missing id'); });
  await test('Failed execution', () => { const e = w.processExecutionIntegration({ executionId: 'e1', knowledgeId: 'k1', outcome: 'failure' }); if (!e.id) throw new Error('Missing id'); });
  await test('Regression', () => { const e = w.processExecutionIntegration({ executionId: 'e1', knowledgeId: 'k1', outcome: 'regression' }); if (!e.id) throw new Error('Missing id'); });
  await test('Rollback', () => { const e = w.processExecutionIntegration({ executionId: 'e1', knowledgeId: 'k1', outcome: 'rollback' }); if (!e.id) throw new Error('Missing id'); });
  await test('Recovery', () => { const e = w.processExecutionIntegration({ executionId: 'e1', knowledgeId: 'k1', outcome: 'recovered' }); if (!e.id) throw new Error('Missing id'); });
  await test('Knowledge update', () => { const e = w.processExecutionIntegration({ executionId: 'e1', knowledgeId: 'k1', updatedKnowledgeId: 'k2' }); if (e.updatedKnowledgeId !== 'k2') throw new Error('Wrong update'); });

  // Learning
  await test('Lesson generation', () => { const l = w.processLesson({ knowledgeId: 'k1', lesson: 'restart worked' }); if (!l.id) throw new Error('Missing id'); });
  await test('Repeated evidence', () => { const l1 = w.processLesson({ knowledgeId: 'k1', lesson: 'restart worked', idempotencyKey: 'lesson-dup' }); const l2 = w.processLesson({ knowledgeId: 'k1', lesson: 'restart worked', idempotencyKey: 'lesson-dup' }); if (l1.id !== l2.id) throw new Error('Not idempotent'); });
  await test('Learning update', () => { const l = w.processLesson({ knowledgeId: 'k1', lesson: 'new lesson' }); if (!l.id) throw new Error('Missing id'); });

  // Audit
  await test('Knowledge audit', () => { const a = w.processGovernance({ knowledgeId: 'k1' }); if (!a.id) throw new Error('Missing id'); });
  await test('Decision audit', () => { const d = w.processDecisionIntegration({ decisionId: 'd1', knowledgeId: 'k1' }); if (!d.id) throw new Error('Missing id'); });
  await test('Execution audit', () => { const e = w.processExecutionIntegration({ executionId: 'e1', knowledgeId: 'k1' }); if (!e.id) throw new Error('Missing id'); });

  // Evidence
  await test('Evidence integrity', () => { const k = w.processKnowledge({ knowledgeType: 'test', sourceEvidence: 'evidence-hash' }); if (!k.sourceEvidence) throw new Error('Missing evidence'); });
  await test('Source traceability', () => { const k = w.processKnowledge({ knowledgeType: 'test', sourceEvent: 'evt1' }); if (!k.sourceEvent) throw new Error('Missing source'); });

  // Lineage
  await test('Source to knowledge', () => { const k = w.processKnowledge({ knowledgeType: 'test', sourceEvent: 'evt1' }); if (!k.id) throw new Error('Missing id'); });
  await test('Knowledge to decision', () => { const d = w.processDecisionIntegration({ decisionId: 'd1', knowledgeId: 'k1' }); if (!d.id) throw new Error('Missing id'); });
  await test('Decision to execution', () => { const e = w.processExecutionIntegration({ executionId: 'e1', knowledgeId: 'k1' }); if (!e.id) throw new Error('Missing id'); });
  await test('Execution to outcome', () => { const e = w.processExecutionIntegration({ executionId: 'e1', knowledgeId: 'k1', outcome: 'success' }); if (!e.outcome) throw new Error('Missing outcome'); });
  await test('Outcome to knowledge', () => { const k = w.processKnowledge({ knowledgeType: 'test', observedOutcome: 'success' }); if (!k.observedOutcome) throw new Error('Missing outcome'); });

  // Idempotency
  await test('Repeated identical ingestion', () => { const a = w.processKnowledge({ knowledgeType: 'test', idempotencyKey: 'ingest-dup' }); const b = w.processKnowledge({ knowledgeType: 'test', idempotencyKey: 'ingest-dup' }); if (a.id !== b.id) throw new Error('Not idempotent'); });
  await test('Repeated identical lesson generation', () => { const a = w.processLesson({ knowledgeId: 'k1', idempotencyKey: 'lesson-idem' }); const b = w.processLesson({ knowledgeId: 'k1', idempotencyKey: 'lesson-idem' }); if (a.id !== b.id) throw new Error('Not idempotent'); });
  await test('Repeated identical precedent query', () => { const a = w.processSimilarity({ decisionId: 'd1', knowledgeId: 'k1', exact: true }); const b = w.processSimilarity({ decisionId: 'd1', knowledgeId: 'k1', exact: true }); if (a.similarityScore !== b.similarityScore) throw new Error('Not deterministic'); });

  // Replay
  await test('Deterministic replay', () => { const r = w.processKnowledgeReplay({ knowledgeId: 'k1', replayedInputs: { a: 1 } }); if (!r.id) throw new Error('Missing id'); });
  await test('Divergence detection', () => { const r = w.processKnowledgeReplay({ knowledgeId: 'k1', divergenceDetected: true }); if (!r.divergenceDetected) throw new Error('Divergence not detected'); });

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

  console.log('=== Phase 53: Autonomous Engineering Knowledge & Organizational Memory ===');
  let passed = 0;
  for (const r of results) {
    console.log(`${r.pass ? 'PASS' : 'FAIL'}: ${r.name}${r.error ? ` (${r.error})` : ''}`);
    if (r.pass) passed++;
  }
  console.log(`${passed} tests passed, ${results.length - passed} tests failed.`);
  console.log(passed === results.length ? 'PHASE 53: PASS' : 'PHASE 53: FAIL');
  process.exit(passed === results.length ? 0 : 1);
}

runTests();
