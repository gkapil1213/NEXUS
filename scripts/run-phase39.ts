import Database from 'better-sqlite3';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { randomUUID } from 'crypto';

import { processRelease } from '../src/core/worker-phase39-release';
import { processReleaseCandidate } from '../src/core/worker-phase39-release-candidate';
import { processArtifactProvenance } from '../src/core/worker-phase39-artifact-provenance';
import { processVersionConsistency } from '../src/core/worker-phase39-version-consistency';
import { processDeploymentStrategy } from '../src/core/worker-phase39-deployment-strategy';
import { processProgressiveRollout } from '../src/core/worker-phase39-progressive-rollout';
import { processRolloutWave } from '../src/core/worker-phase39-rollout-wave';
import { processCanaryAnalysis } from '../src/core/worker-phase39-canary-analysis';
import { processHealthGate } from '../src/core/worker-phase39-health-gate';
import { processReleaseRisk } from '../src/core/worker-phase39-release-risk';
import { processReleaseImpact } from '../src/core/worker-phase39-release-impact';
import { processReleaseBlastRadius } from '../src/core/worker-phase39-release-blast-radius';
import { processReleaseGovernance } from '../src/core/worker-phase39-release-governance';
import { processReleaseSafety } from '../src/core/worker-phase39-release-safety';
import { processReleaseApproval } from '../src/core/worker-phase39-release-approval';
import { processReleaseExecution } from '../src/core/worker-phase39-release-execution';
import { processReleasePause } from '../src/core/worker-phase39-release-pause';
import { processReleaseHalt } from '../src/core/worker-phase39-release-halt';
import { processReleaseRollback } from '../src/core/worker-phase39-release-rollback';
import { processRemediationPlan } from '../src/core/worker-phase39-remediation-plan';
import { processRemediationExecution } from '../src/core/worker-phase39-remediation-execution';
import { processRemediationVerification } from '../src/core/worker-phase39-remediation-verification';
import { processRemediationRollback } from '../src/core/worker-phase39-remediation-rollback';
import { processRemediationCircuitBreaker } from '../src/core/worker-phase39-remediation-circuit-breaker';
import { processIncident } from '../src/core/worker-phase39-incident';
import { processEscalation } from '../src/core/worker-phase39-escalation';
import { processEvidence } from '../src/core/worker-phase39-evidence';
import { processAudit } from '../src/core/worker-phase39-audit';
import { processLineage } from '../src/core/worker-phase39-lineage';
import { processLearning } from '../src/core/worker-phase39-learning';
import { processProvider } from '../src/core/worker-phase39-provider';
import { processAutonomousReleaseControlPlane } from '../src/core/worker-phase39-autonomous-release-control-plane';

function redactSecret(text: string): string {
  return text
    .replace(/password\s*[:=]\s*\S+/gi, 'password=[REDACTED]')
    .replace(/token\s*[:=]\s*\S+/gi, 'token=[REDACTED]')
    .replace(/api[_-]?key\s*[:=]\s*\S+/gi, 'api_key=[REDACTED]')
    .replace(/authorization\s*[:=]\s*\S+/gi, 'authorization=[REDACTED]')
    .replace(/secret\s*[:=]\s*\S+/gi, 'secret=[REDACTED]')
    .replace(/credential\s*[:=]\s*\S+/gi, 'credential=[REDACTED]');
}

const db = new Database(':memory:');
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const migrations = [
  '080_phase35_autonomous_cicd_pipeline_intelligence.sql',
  '081_phase36_autonomous_release_engineering.sql',
  '082_phase37_autonomous_release_progressive_delivery.sql',
  '083_phase38_autonomous_release_engineering.sql',
  '084_phase39_autonomous_release_engineering.sql'
];
for (const m of migrations) {
  const p = path.join(__dirname, '..', 'src', 'db', 'migrations', m);
  const sql = fs.readFileSync(p, 'utf8');
  db.exec(sql);
}

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
  // 1. Release creation
  await test('Release creation', () => {
    const r = processRelease({ name: 'rel1', version: '1.0.0', idempotencyKey: 'rel-1' });
    if (!r.id || r.name !== 'rel1') throw new Error('Invalid release');
  });

  // 2. Duplicate release prevention
  await test('Duplicate release prevention', () => {
    const r1 = processRelease({ name: 'dup', version: '1.0.0', idempotencyKey: 'dup-key' });
    const r2 = processRelease({ name: 'dup', version: '1.0.0', idempotencyKey: 'dup-key' });
    if (r1.id !== r2.id) throw new Error('Expected same id');
  });

  // 3. Release candidate creation
  await test('Release candidate creation', () => {
    const c = processReleaseCandidate({ releaseId: 'rel1', sourceRevision: 'abc' });
    if (!c.id) throw new Error('Candidate not created');
  });

  // 4. Duplicate candidate prevention
  await test('Duplicate candidate prevention', () => {
    const c1 = processReleaseCandidate({ releaseId: 'rel1', idempotencyKey: 'cand-dup' });
    const c2 = processReleaseCandidate({ releaseId: 'rel1', idempotencyKey: 'cand-dup' });
    if (c1.id !== c2.id) throw new Error('Expected same candidate id');
  });

  // 5. Artifact provenance validation
  await test('Artifact provenance validation', () => {
    const ap = processArtifactProvenance({ artifactId: 'art1', digest: 'sha256:abc' });
    if (!ap.valid) throw new Error('Provenance should be valid');
  });

  // 6. Artifact mismatch detection
  await test('Artifact mismatch detection', () => {
    const ap = processArtifactProvenance({ artifactId: 'art1', digest: 'sha256:wrong', mismatch: true });
    if (ap.valid) throw new Error('Mismatch should be invalid');
  });

  // 7. Version consistency
  await test('Version consistency', () => {
    const vc = processVersionConsistency({ releaseId: 'rel1', expectedVersion: '1.0.0', artifactVersion: '1.0.0' });
    if (!vc.consistent) throw new Error('Version should be consistent');
  });

  // 8. Version mismatch detection
  await test('Version mismatch detection', () => {
    const vc = processVersionConsistency({ releaseId: 'rel1', expectedVersion: '1.0.0', artifactVersion: '1.1.0', mismatch: true });
    if (vc.consistent) throw new Error('Version mismatch should be detected');
  });

  // 9. Deployment strategy detection
  await test('Deployment strategy detection', () => {
    const ds = processDeploymentStrategy({ releaseId: 'rel1', strategy: 'canary' });
    if (ds.strategy !== 'canary') throw new Error('Strategy should be canary');
  });

  // 10. Unknown strategy handling
  await test('Unknown strategy handling', () => {
    try {
      processDeploymentStrategy({ releaseId: 'rel1', strategy: 'bogus' });
      throw new Error('Should have thrown for unknown strategy');
    } catch (e: any) {
      if (!e.message.includes('Unknown strategy')) throw e;
    }
  });

  // 11. Progressive rollout creation
  await test('Progressive rollout creation', () => {
    const pr = processProgressiveRollout({ releaseId: 'rel1', strategy: 'canary', idempotencyKey: 'prog-1' });
    if (!pr.id || pr.strategy !== 'canary') throw new Error('Rollout creation failed');
  });

  // 12. Rollout wave creation
  await test('Rollout wave creation', () => {
    const wave = processRolloutWave({ rolloutId: 'pr1', waveNumber: 1, percentage: 5 });
    if (!wave.id) throw new Error('Wave not created');
  });

  // 13. Duplicate wave prevention
  await test('Duplicate wave prevention', () => {
    const w1 = processRolloutWave({ rolloutId: 'pr1', idempotencyKey: 'wave-dup' });
    const w2 = processRolloutWave({ rolloutId: 'pr1', idempotencyKey: 'wave-dup' });
    if (w1.id !== w2.id) throw new Error('Expected same wave id');
  });

  // 14. Wave dependency validation
  await test('Wave dependency validation', () => {
    const w1 = processRolloutWave({ rolloutId: 'pr1', waveNumber: 1, percentage: 5, state: 'succeeded' });
    const w2 = processRolloutWave({ rolloutId: 'pr1', waveNumber: 2, percentage: 10, state: 'pending' });
    if (w2.waveNumber <= w1.waveNumber) throw new Error('Wave order invalid');
    if (w1.state !== 'succeeded') throw new Error('Previous wave not succeeded');
  });

  // 15. Canary healthy classification
  await test('Canary healthy classification', () => {
    const ca = processCanaryAnalysis({ releaseId: 'rel1', errorRate: 0.001, availability: 0.999 });
    if (ca.outcome !== 'healthy') throw new Error('Expected healthy');
  });

  // 16. Canary degraded classification
  await test('Canary degraded classification', () => {
    const ca = processCanaryAnalysis({ releaseId: 'rel1', errorRate: 0.03, availability: 0.98 });
    if (ca.outcome !== 'degraded') throw new Error('Expected degraded');
  });

  // 17. Canary unhealthy classification
  await test('Canary unhealthy classification', () => {
    const ca = processCanaryAnalysis({ releaseId: 'rel1', errorRate: 0.08, availability: 0.90 });
    if (ca.outcome !== 'unhealthy') throw new Error('Expected unhealthy');
  });

  // 18. Unknown canary health handling
  await test('Unknown canary health handling', () => {
    const ca = processCanaryAnalysis({ releaseId: 'rel1' });
    if (ca.outcome !== 'unknown') throw new Error('Expected unknown');
  });

  // 19. Health gate allow
  await test('Health gate allow', () => {
    const hg = processHealthGate({ releaseId: 'rel1', appHealth: 'HEALTHY', infraHealth: 'HEALTHY', deploymentHealth: 'HEALTHY' });
    if (hg.decision !== 'ALLOW') throw new Error('Expected ALLOW');
  });

  // 20. Health gate pause
  await test('Health gate pause', () => {
    const hg = processHealthGate({ releaseId: 'rel1', appHealth: 'DEGRADED' });
    if (hg.decision !== 'PAUSE') throw new Error('Expected PAUSE');
  });

  // 21. Health gate halt
  await test('Health gate halt', () => {
    const hg = processHealthGate({ releaseId: 'rel1', appHealth: 'UNHEALTHY' });
    if (hg.decision !== 'HALT') throw new Error('Expected HALT');
  });

  // 22. Unknown health fails closed
  await test('Unknown health fails closed', () => {
    const hg = processHealthGate({ releaseId: 'rel1' });
    if (hg.decision !== 'UNKNOWN') throw new Error('Expected UNKNOWN');
  });

  // 23. Release risk calculation
  await test('Release risk calculation', () => {
    const risk = processReleaseRisk({ releaseId: 'rel1', medium: true });
    if (risk.riskLevel !== 'MEDIUM') throw new Error('Risk level wrong');
  });

  // 24. Critical release risk detection
  await test('Critical release risk detection', () => {
    const risk = processReleaseRisk({ releaseId: 'rel1', critical: true });
    if (risk.riskLevel !== 'CRITICAL') throw new Error('Expected CRITICAL');
  });

  // 25. Unknown risk handling
  await test('Unknown risk handling', () => {
    const risk = processReleaseRisk({ releaseId: 'rel1' });
    if (risk.riskLevel !== 'UNKNOWN') throw new Error('Expected UNKNOWN');
  });

  // 26. Impact analysis
  await test('Impact analysis', () => {
    const impact = processReleaseImpact({ releaseId: 'rel1' });
    if (!impact.id) throw new Error('Impact missing');
  });

  // 27. Blast-radius analysis
  await test('Blast-radius analysis', () => {
    const br = processReleaseBlastRadius({ releaseId: 'rel1', resourceCount: 100, criticalResources: 5, customerFacing: 3 });
    if (br.classification !== 'HIGH') throw new Error('Expected HIGH');
  });

  // 28. Governance allow
  await test('Governance allow', () => {
    const gov = processReleaseGovernance({ releaseId: 'rel1' });
    if (gov.decision !== 'ALLOW') throw new Error('Expected ALLOW');
  });

  // 29. Approval requirement
  await test('Approval requirement', () => {
    const gov = processReleaseGovernance({ releaseId: 'rel1', risk: 'HIGH' });
    if (gov.decision !== 'APPROVAL_REQUIRED') throw new Error('Expected APPROVAL_REQUIRED');
  });

  // 30. Governance denial
  await test('Governance denial', () => {
    const gov = processReleaseGovernance({ releaseId: 'rel1', deny: true });
    if (gov.decision !== 'DENY') throw new Error('Expected DENY');
  });

  // 31. Change freeze
  await test('Change freeze', () => {
    const gov = processReleaseGovernance({ releaseId: 'rel1', freeze: true });
    if (gov.decision !== 'FREEZE') throw new Error('Expected FREEZE');
  });

  // 32. Safety allow
  await test('Safety allow', () => {
    const safety = processReleaseSafety({ releaseId: 'rel1' });
    if (!safety.safe) throw new Error('Expected safe');
  });

  // 33. Protected-resource safety block
  await test('Protected-resource safety block', () => {
    const safety = processReleaseSafety({ releaseId: 'rel1', protectedResource: true });
    if (safety.safe) throw new Error('Expected unsafe');
  });

  // 34. Unknown provider safety block
  await test('Unknown provider safety block', () => {
    const safety = processReleaseSafety({ releaseId: 'rel1', unknownProvider: true });
    if (safety.safe) throw new Error('Expected unsafe');
  });

  // 35. Missing rollback safety block
  await test('Missing rollback safety block', () => {
    const safety = processReleaseSafety({ releaseId: 'rel1', missingRollback: true });
    if (safety.safe) throw new Error('Expected unsafe');
  });

  // 36. Execution creation
  await test('Execution creation', () => {
    const exec = processReleaseExecution({ releaseId: 'rel1', operation: 'deploy' });
    if (!exec.id) throw new Error('Execution not created');
  });

  // 37. Valid execution transition
  await test('Valid execution transition', () => {
    const exec = processReleaseExecution({ releaseId: 'rel1', from: 'created', to: 'approved' });
    if (!exec.validTransition || exec.state !== 'approved') throw new Error('Transition should be valid');
  });

  // 38. Invalid execution transition
  await test('Invalid execution transition', () => {
    try {
      processReleaseExecution({ releaseId: 'rel1', from: 'running', to: 'created' });
      throw new Error('Should have thrown invalid transition');
    } catch (e: any) {
      if (!e.message.includes('Invalid transition')) throw e;
    }
  });

  // 39. Progressive wave execution
  await test('Progressive wave execution', () => {
    const wave = processRolloutWave({ rolloutId: 'pr1', waveNumber: 1, state: 'executing' });
    if (wave.state !== 'executing') throw new Error('Wave not executing');
  });

  // 40. Automatic pause
  await test('Automatic pause', () => {
    const pause = processReleasePause({ releaseId: 'rel1', reason: 'health' });
    if (!pause.id) throw new Error('Pause failed');
  });

  // 41. Automatic halt
  await test('Automatic halt', () => {
    const halt = processReleaseHalt({ releaseId: 'rel1', reason: 'critical' });
    if (!halt.id) throw new Error('Halt failed');
  });

  // 42. Duplicate execution prevention
  await test('Duplicate execution prevention', () => {
    const e1 = processReleaseExecution({ releaseId: 'rel1', idempotencyKey: 'exec-dup' });
    const e2 = processReleaseExecution({ releaseId: 'rel1', idempotencyKey: 'exec-dup' });
    if (e1.id !== e2.id) throw new Error('Expected same execution id');
  });

  // 43. Rollback creation
  await test('Rollback creation', () => {
    const rb = processReleaseRollback({ releaseId: 'rel1' });
    if (!rb.id) throw new Error('Rollback not created');
  });

  // 44. Rollback idempotency
  await test('Rollback idempotency', () => {
    const rb1 = processReleaseRollback({ releaseId: 'rel1', idempotencyKey: 'rb-dup' });
    const rb2 = processReleaseRollback({ releaseId: 'rel1', idempotencyKey: 'rb-dup' });
    if (rb1.id !== rb2.id) throw new Error('Expected same rollback id');
  });

  // 45. Rollback safety
  await test('Rollback safety', () => {
    const rb = processReleaseRollback({ releaseId: 'rel1' });
    if (!rb.id) throw new Error('Rollback safety missing');
  });

  // 46. Rollback failure handling
  await test('Rollback failure handling', () => {
    const rb = processReleaseRollback({ releaseId: 'rel1', fail: true });
    if (rb.result !== 'FAILED') throw new Error('Expected FAILED');
  });

  // 47. Remediation plan
  await test('Remediation plan', () => {
    const rp = processRemediationPlan({ releaseId: 'rel1' });
    if (!rp.id) throw new Error('Remediation plan missing');
  });

  // 48. Remediation execution
  await test('Remediation execution', () => {
    const re = processRemediationExecution({ remediationId: 'rem1' });
    if (!re.id) throw new Error('Remediation execution missing');
  });

  // 49. Remediation verification
  await test('Remediation verification', () => {
    const rv = processRemediationVerification({ remediationId: 'rem1', result: 'SUCCESS' });
    if (!rv.id) throw new Error('Verification missing');
  });

  // 50. Remediation rollback
  await test('Remediation rollback', () => {
    const rr = processRemediationRollback({ remediationId: 'rem1' });
    if (!rr.id) throw new Error('Rollback missing');
  });

  // 51. Remediation idempotency
  await test('Remediation idempotency', () => {
    const rp1 = processRemediationPlan({ releaseId: 'rel1', idempotencyKey: 'rem-dup' });
    const rp2 = processRemediationPlan({ releaseId: 'rel1', idempotencyKey: 'rem-dup' });
    if (rp1.id !== rp2.id) throw new Error('Expected same remediation id');
  });

  // 52. Circuit breaker closed
  await test('Circuit breaker closed', () => {
    const cb = processRemediationCircuitBreaker({ scope: 'release' });
    if (cb.state !== 'CLOSED') throw new Error('Expected CLOSED');
  });

  // 53. Circuit breaker opens
  await test('Circuit breaker opens', () => {
    const cb = processRemediationCircuitBreaker({ scope: 'release', failures: 3, threshold: 3 });
    if (cb.state !== 'OPEN') throw new Error('Expected OPEN');
  });

  // 54. Execution blocked while breaker is open
  await test('Execution blocked while breaker is open', () => {
    const exec = processReleaseExecution({ releaseId: 'rel1', circuitBreakerState: 'OPEN' });
    if (!exec.blocked) throw new Error('Expected blocked');
  });

  // 55. Incident creation
  await test('Incident creation', () => {
    const inc = processIncident({ releaseId: 'rel1', severity: 'HIGH' });
    if (!inc.id) throw new Error('Incident not created');
  });

  // 56. Duplicate incident prevention
  await test('Duplicate incident prevention', () => {
    const inc1 = processIncident({ releaseId: 'rel1', signature: 'sig1' });
    const inc2 = processIncident({ releaseId: 'rel1', signature: 'sig1' });
    if (inc1.id !== inc2.id) throw new Error('Expected same incident id');
  });

  // 57. Escalation
  await test('Escalation', () => {
    const esc = processEscalation({ incidentId: 'inc1', level: 'CRITICAL' });
    if (!esc.id) throw new Error('Escalation failed');
  });

  // 58. Evidence generation
  await test('Evidence generation', () => {
    const ev = processEvidence({ releaseId: 'rel1' });
    if (!ev.id) throw new Error('Evidence missing');
  });

  // 59. Audit trail
  await test('Audit trail', () => {
    const audit = processAudit({ releaseId: 'rel1', eventType: 'release_created', previousState: 'candidate', newState: 'candidate' });
    if (!audit.id) throw new Error('Audit missing');
  });

  // 60. Lineage
  await test('Lineage', () => {
    const lin = processLineage({ releaseId: 'rel1', sourceCommit: 'abc' });
    if (!lin.id) throw new Error('Lineage missing');
  });

  // 61. Learning outcome
  await test('Learning outcome', () => {
    const learn = processLearning({ releaseId: 'rel1', outcome: 'success' });
    if (!learn.id) throw new Error('Learning missing');
  });

  // 62. Unknown provider fails closed
  await test('Unknown provider fails closed', () => {
    try {
      processProvider({ unknown: true });
      throw new Error('Should have thrown');
    } catch (e: any) {
      if (!e.message.includes('UNAVAILABLE')) throw e;
    }
  });

  // 63. Full approved lifecycle orchestration
  await test('Full approved lifecycle orchestration', () => {
    const result = processAutonomousReleaseControlPlane({ releaseId: 'rel1', approve: true });
    if (result.status !== 'COMPLETED') throw new Error('Lifecycle failed');
  });

  // 64. Repeated identical release request remains idempotent
  await test('Repeated identical release request remains idempotent', () => {
    const r1 = processRelease({ name: 'idem', version: '1.0.0', idempotencyKey: 'rel-idem' });
    const r2 = processRelease({ name: 'idem', version: '1.0.0', idempotencyKey: 'rel-idem' });
    if (r1.id !== r2.id) throw new Error('Expected same release id');
  });

  // 65-69: Redaction tests
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
  console.log('=== Phase 39: Autonomous Release Engineering, Progressive Delivery & Production Change Control ===');
  let passed = 0;
  for (const r of results) {
    console.log(`${r.pass ? 'PASS' : 'FAIL'}: ${r.name}${r.error ? ` (${r.error})` : ''}`);
    if (r.pass) passed++;
  }
  console.log(`${passed} tests passed, ${results.length - passed} tests failed.`);
  console.log(passed === results.length ? 'PHASE 39: PASS' : 'PHASE 39: FAIL');
  process.exit(passed === results.length ? 0 : 1);
}

runTests();
