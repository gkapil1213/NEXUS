import { evaluateEffectiveness } from '../src/core/worker-policy-effectiveness';
import { detectDrift } from '../src/core/worker-policy-drift-detector';
import { generatePolicyLearningProposal } from '../src/core/worker-policy-learning';
import { storePolicyEvidence } from '../src/core/worker-policy-evidence';
import { redactSecrets } from '../src/core/secret-redaction';
// ... other imports

let passed = 0;
let failed = 0;

function assert(condition: boolean, testName: string) {
  if (condition) {
    console.log(`PASS: ${testName}`);
    passed++;
  } else {
    console.error(`FAIL: ${testName}`);
    failed++;
  }
}

async function main() {
  console.log('=== Phase 17.28: Autonomous Production Policy Learning and Governed Self-Adaptation ===');

  // Test effectiveness
  assert(evaluateEffectiveness({ sampleSize: 100, successRate: 0.99, failureRate: 0.01, rollbackRate: 0 }) === 'EFFECTIVE', 'Effective policy');
  assert(evaluateEffectiveness({ sampleSize: 5, successRate: 1, failureRate: 0, rollbackRate: 0 }) === 'INSUFFICIENT_DATA', 'Insufficient data');
  assert(evaluateEffectiveness({ sampleSize: 100, successRate: 0.7, failureRate: 0.3, rollbackRate: 0.1 }) === 'INEFFECTIVE', 'Ineffective policy');

  // Test drift
  const baseline = { successRate: 0.99, failureRate: 0.01, latencyP95: 100, cost: 10, reliability: 0.999 };
  const noDrift = { ...baseline };
  assert(detectDrift(baseline, noDrift, true) === 'NO_DRIFT', 'No drift');
  const highDrift = { successRate: 0.80, failureRate: 0.20, latencyP95: 200, cost: 30, reliability: 0.90 };
  assert(detectDrift(baseline, highDrift, true) === 'CRITICAL_DRIFT', 'Critical drift');
  assert(detectDrift(baseline, highDrift, false) === 'UNKNOWN', 'Stale telemetry gives unknown');

  // Test secret redaction
  const secret = { apiKey: 'sk-1234567890', nested: { token: 'abc' } };
  const redacted = redactSecrets(secret);
  assert(!JSON.stringify(redacted).includes('1234567890'), 'Secret redacted');
  assert(!JSON.stringify(redacted).includes('abc'), 'Nested secret redacted');

  // Test learning proposal
  const proposal = generatePolicyLearningProposal({
    tenantId: 'tenantA',
    policyId: 'policy1',
    currentVersion: 'v1',
    evidence: [], // can be empty for proposal generation?
    effectiveness: 'INEFFECTIVE',
    drift: 'HIGH_DRIFT',
  });
  assert(proposal !== null, 'Proposal generated when needed');
  assert(proposal?.sourceVersion === 'v1', 'Source version correct');
  assert(proposal?.proposedVersion !== 'v1', 'Proposed version differs');

  // ... many more tests

  // Regression tests: import and run previous phases if possible
  // For example:
  // const phase27 = require('./run-phase17-pass27');
  // await phase27.main();

  console.log(`\n${passed} tests passed, ${failed} tests failed.`);
  if (failed > 0) {
    console.log('PHASE 17 PASS 28: FAIL');
    process.exit(1);
  } else {
    console.log('PHASE 17 PASS 28: PASS');
  }
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});