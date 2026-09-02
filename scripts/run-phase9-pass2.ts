import { detectCapabilities } from '../src/phase9/capabilities';
import { ChaosFixture } from '../src/phase9/fixture/chaosService';
import { BaselineAgent } from '../src/phase9/agents/BaselineAgent';
import { PerformanceAgent } from '../src/phase9/agents/PerformanceAgent';
import { LoadTestAgent } from '../src/phase9/agents/LoadTestAgent';
import { StressTestAgent } from '../src/phase9/agents/StressTestAgent';
import { FailureInjectionAgent } from '../src/phase9/agents/FailureInjectionAgent';
import { RecoveryAgent } from '../src/phase9/agents/RecoveryAgent';
import { SLOAgent } from '../src/phase9/agents/SLOAgent';
import { ErrorBudgetService } from '../src/phase9/ErrorBudgetService';
import { defaultPolicy } from '../src/phase9/agents/PerformancePolicy';
import { ReliabilityGate } from '../src/phase9/ReliabilityGate';
import * as fs from 'fs';
import * as path from 'path';

async function main() {
  console.log('Starting Phase 9 Pass 2 verification...');
  const evidence: any = {
    capabilities: [],
    baseline: null,
    performance: null,
    load: null,
    stress: null,
    failure_injection: null,
    recovery: null,
    slo: null,
    error_budget: null,
    reliability_gate: null,
    events: [],
    audit: []
  };

  // Detect capabilities
  evidence.capabilities = detectCapabilities();
  console.log('Capabilities detected.');

  // Start fixture
  const fixture = new ChaosFixture();
  await fixture.start(0);
  const baseUrl = `http://localhost:${fixture.port}`;
  console.log(`Chaos fixture started on port ${fixture.port}`);
  await new Promise(resolve => setTimeout(resolve, 500));

  // Baseline
  try {
    const baselineAgent = new BaselineAgent();
    const baselineMetrics = await baselineAgent.measure(`${baseUrl}/health`);
    evidence.baseline = baselineMetrics;
    console.log('Baseline measured:', baselineMetrics);
  } catch (err) {
    console.error('Baseline failed:', err);
    evidence.baseline = null;
  }

  // Performance (use request count to avoid long duration)
  try {
    const perfAgent = new PerformanceAgent();
    const perfMetrics = await perfAgent.run(`${baseUrl}/health`, {
      concurrency: 5,
      requests: 200,
      warmupMs: 500
    });
    evidence.performance = perfMetrics;
    console.log('Performance test complete:', perfMetrics);
  } catch (err) {
    console.error('Performance test failed:', err);
    evidence.performance = null;
  }

  // Load test
  try {
    const loadAgent = new LoadTestAgent();
    const loadResults = await loadAgent.run(`${baseUrl}/health`, [5, 10, 20], 100);
    evidence.load = loadResults;
    console.log('Load test complete.');
  } catch (err) {
    console.error('Load test failed:', err);
    evidence.load = null;
  }

  // Stress test (with timestamps)
  try {
    const stressAgent = new StressTestAgent();
    const stressResult = await stressAgent.run(`${baseUrl}/health`, defaultPolicy, 16);
    evidence.stress = stressResult;
    console.log('Stress test complete. Breaking point:', stressResult.breakingPoint);
  } catch (err) {
    console.error('Stress test failed:', err);
    evidence.stress = null;
  }

  // Failure injection
  try {
    const failureAgent = new FailureInjectionAgent(fixture);
    const injectionResult = await failureAgent.inject('HTTP_503', 5000);
    evidence.failure_injection = injectionResult;
    console.log('Failure injected and restored.');
  } catch (err) {
    console.error('Failure injection failed:', err);
    evidence.failure_injection = null;
  }

  // Recovery
  try {
    const recoveryAgent = new RecoveryAgent();
    const healthBeforeFailure = await recoveryAgent.verifyRecovery(`${baseUrl}/health`);
    const recovered = await recoveryAgent.waitForRecovery(`${baseUrl}/health`, 10000);
    evidence.recovery = {
      health_before_failure: healthBeforeFailure,
      recovered,
      timestamp: new Date().toISOString()
    };
    console.log('Recovery verification:', evidence.recovery);
  } catch (err) {
    console.error('Recovery failed:', err);
    evidence.recovery = null;
  }

  // SLO
  try {
    const sloConfig = {
      availability_target_percent: 99,
      latency_p95_target_ms: 1000,
      error_rate_target_percent: 5,
      throughput_target_rps: 1
    };
    const sloAgent = new SLOAgent();
    const sloEvaluation = sloAgent.evaluate(sloConfig, evidence.performance || {});
    evidence.slo = sloEvaluation;
    console.log('SLO evaluation:', sloEvaluation);
  } catch (err) {
    console.error('SLO evaluation failed:', err);
    evidence.slo = null;
  }

  // Error budget
  try {
    const perf = evidence.performance || { totalRequests: 0, failed: 0 };
    const errorBudgetService = new ErrorBudgetService();
    const errorBudget = errorBudgetService.calculate(
      perf.totalRequests,
      perf.failed,
      5
    );
    evidence.error_budget = errorBudget;
    console.log('Error budget:', errorBudget);
  } catch (err) {
    console.error('Error budget failed:', err);
    evidence.error_budget = null;
  }

  // Reliability gate
  try {
    const gate = new ReliabilityGate();
    const gateResult = gate.evaluate(evidence);
    evidence.reliability_gate = gateResult;
    console.log('Reliability gate:', gateResult);
  } catch (err) {
    console.error('Reliability gate failed:', err);
    evidence.reliability_gate = { status: 'FAIL', reasons: ['Gate evaluation error'] };
  }

  // Stop fixture
  await fixture.stop();
  console.log('Chaos fixture stopped.');

  // Write evidence
  const evidencePath = path.join(process.cwd(), 'phase9-pass2-evidence.json');
  fs.writeFileSync(evidencePath, JSON.stringify(evidence, null, 2));
  console.log(`Evidence written to ${evidencePath}`);
}

main().catch(err => {
  console.error('Fatal error during Phase 9 Pass 2:', err);
  process.exit(1);
});
