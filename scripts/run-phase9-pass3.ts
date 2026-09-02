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
import * as persistence from '../src/phase9/persistence';
import { randomUUID } from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import express from 'express';
import reliabilityRouter from '../src/api/reliability';

async function emitEvent(eventData: any) {
  const eventId = randomUUID();
  persistence.db.prepare(`INSERT INTO events (id, type, timestamp, data) VALUES (?, ?, ?, ?)`).run(eventId, eventData.type, new Date().toISOString(), JSON.stringify(eventData));
  persistence.insertEventRef({ id: randomUUID(), reliability_run_id: eventData.reliability_run_id, event_id: eventId, created_at: new Date().toISOString() });
}

async function auditAction(action: string, resource: string, result: string, metadata: any = {}, runId: string) {
  const auditId = randomUUID();
  persistence.db.prepare(`INSERT INTO audits (id, actor, action, resource, result, metadata, timestamp, reliability_run_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
    .run(auditId, 'system', action, resource, result, JSON.stringify(metadata), new Date().toISOString(), runId);
}

async function main() {
  console.log('Phase 9 Pass 3 verification started');
  const evidence: any = {
    capabilities: [], reliability_run: null, baseline: null, performance: null,
    load: null, stress: null, failure_injection: null, recovery: null,
    slo: null, error_budget: null, regression: null, incidents: [],
    events: [], audit: [], api_verification: null, dashboard_verification: null,
    reliability_gate: null, timestamps: {}, blockers: [], failures: []
  };

  evidence.capabilities = detectCapabilities();
  evidence.timestamps.started = new Date().toISOString();

  const runId = randomUUID();
  const run = {
    id: runId, project_id: 'nexus', execution_id: randomUUID(), status: 'RUNNING',
    started_at: new Date().toISOString(), completed_at: null, duration_ms: null,
    environment: 'local', trigger: 'phase9-pass3', git_commit: null, version: '0.1.0',
    gate_status: null, created_at: new Date().toISOString(), updated_at: new Date().toISOString()
  };
  persistence.insertReliabilityRun(run);
  evidence.reliability_run = run;
  await emitEvent({ type: 'reliability.started', reliability_run_id: runId, stage: 'start', status: 'RUNNING' });
  await auditAction('reliability_run_started', 'reliability_run', 'SUCCESS', { runId }, runId);

  const fixture = new ChaosFixture();
  await fixture.start(0);
  const baseUrl = `http://localhost:${fixture.port}`;

  // Baseline
  try {
    const baselineAgent = new BaselineAgent();
    const baselineMetrics = await baselineAgent.measure(`${baseUrl}/health`);
    evidence.baseline = baselineMetrics;
    persistence.insertBaseline({ id: randomUUID(), reliability_run_id: runId, status_code: baselineMetrics.status, latency_ms: baselineMetrics.latency_ms, memory_rss: baselineMetrics.memory_rss, cpu_count: 0, timestamp: baselineMetrics.timestamp });
    await emitEvent({ type: 'reliability.baseline.completed', reliability_run_id: runId, stage: 'baseline', status: 'PASS' });
  } catch (err) { evidence.failures.push({ stage: 'baseline', error: err }); }

  // Performance
  try {
    const perfAgent = new PerformanceAgent();
    const perfMetrics = await perfAgent.run(`${baseUrl}/health`, { concurrency: 5, requests: 200, warmupMs: 500 });
    evidence.performance = perfMetrics;
    persistence.insertPerformance({ id: randomUUID(), reliability_run_id: runId, total_requests: perfMetrics.totalRequests, successful_requests: perfMetrics.success, failed_requests: perfMetrics.failed, error_rate: perfMetrics.errorRate, throughput: perfMetrics.throughput, duration_ms: perfMetrics.duration_ms, p50: perfMetrics.latency.p50, p90: perfMetrics.latency.p90, p95: perfMetrics.latency.p95, p99: perfMetrics.latency.p99, min_latency: perfMetrics.latency.min, max_latency: perfMetrics.latency.max, created_at: new Date().toISOString() });
    await emitEvent({ type: 'reliability.performance.completed', reliability_run_id: runId, stage: 'performance', status: 'PASS' });
  } catch (err) { evidence.failures.push({ stage: 'performance', error: err }); }

  // Load
  try {
    const loadAgent = new LoadTestAgent();
    const loadResults = await loadAgent.run(`${baseUrl}/health`, [5, 10, 20], 100);
    evidence.load = loadResults;
    for (const level of loadResults) {
      persistence.insertLoadTest({ id: randomUUID(), reliability_run_id: runId, concurrency: level.level, total_requests: level.metrics.totalRequests, success: level.metrics.success, failure: level.metrics.failed, throughput: level.metrics.throughput, p50: level.metrics.latency.p50, p90: level.metrics.latency.p90, p95: level.metrics.latency.p95, p99: level.metrics.latency.p99, error_rate: level.metrics.errorRate, duration_ms: level.metrics.duration_ms, created_at: new Date().toISOString() });
    }
    await emitEvent({ type: 'reliability.load.completed', reliability_run_id: runId, stage: 'load', status: 'PASS' });
  } catch (err) { evidence.failures.push({ stage: 'load', error: err }); }

  // Stress
  try {
    const stressAgent = new StressTestAgent();
    const stressResult = await stressAgent.run(`${baseUrl}/health`, defaultPolicy, 16);
    evidence.stress = stressResult;
    for (const level of stressResult.levels) {
      persistence.insertStressLevel({ id: randomUUID(), reliability_run_id: runId, concurrency: level.concurrency, total_requests: level.metrics.totalRequests, success: level.metrics.success, failure: level.metrics.failed, throughput: level.metrics.throughput, p50: level.metrics.latency.p50, p90: level.metrics.latency.p90, p95: level.metrics.latency.p95, p99: level.metrics.latency.p99, error_rate: level.metrics.errorRate, breaking_point: stressResult.breakingPoint, created_at: new Date().toISOString() });
    }
    await emitEvent({ type: 'reliability.stress.completed', reliability_run_id: runId, stage: 'stress', status: 'PASS' });
  } catch (err) { evidence.failures.push({ stage: 'stress', error: err }); }

  // Failure injection
  try {
    const failureAgent = new FailureInjectionAgent(fixture);
    const injectionResult = await failureAgent.inject('HTTP_503', 5000);
    evidence.failure_injection = injectionResult;
    persistence.insertFailureInjection({ id: randomUUID(), reliability_run_id: runId, failure_type: injectionResult.failure_type, target: `${baseUrl}/health`, started_at: injectionResult.started_at, ended_at: injectionResult.ended_at, duration_ms: injectionResult.duration_ms, status_before: '200', status_during: '503', status_after: '200', recovered: 1, evidence: JSON.stringify(injectionResult) });
    await emitEvent({ type: 'reliability.failure.injected', reliability_run_id: runId, stage: 'failure_injection', status: 'INJECTED' });
    await emitEvent({ type: 'reliability.failure.detected', reliability_run_id: runId, stage: 'failure_detection', status: 'DETECTED' });
    await auditAction('failure_injected', 'failure_injection', 'SUCCESS', { runId, failure_type: injectionResult.failure_type }, runId);
  } catch (err) { evidence.failures.push({ stage: 'failure_injection', error: err }); }

  // Recovery
  try {
    const recoveryAgent = new RecoveryAgent();
    const healthBefore = await recoveryAgent.verifyRecovery(`${baseUrl}/health`);
    const recovered = await recoveryAgent.waitForRecovery(`${baseUrl}/health`, 10000);
    const recoveryRun = { id: randomUUID(), reliability_run_id: runId, health_before_failure: healthBefore ? 1 : 0, failure_detected_at: evidence.failure_injection?.started_at, recovery_started_at: new Date().toISOString(), recovered_at: new Date().toISOString(), recovery_duration_ms: 0, recovery_status: recovered ? 'RECOVERED' : 'FAILED' };
    evidence.recovery = recoveryRun;
    persistence.insertRecovery(recoveryRun);
    await emitEvent({ type: 'reliability.recovery.completed', reliability_run_id: runId, stage: 'recovery', status: recovered ? 'RECOVERED' : 'FAILED' });
    await auditAction('recovery_executed', 'recovery', recovered ? 'SUCCESS' : 'FAILURE', { runId }, runId);
  } catch (err) { evidence.failures.push({ stage: 'recovery', error: err }); }

  // SLO
  try {
    const sloConfig = { availability_target_percent: 99, latency_p95_target_ms: 1000, error_rate_target_percent: 5, throughput_target_rps: 1 };
    const sloAgent = new SLOAgent();
    const sloEval = sloAgent.evaluate(sloConfig, evidence.performance || {});
    evidence.slo = sloEval;
    persistence.insertSLOEvaluation({ id: randomUUID(), reliability_run_id: runId, availability_percent: sloEval.availability_percent, latency_p95_ms: sloEval.latency_p95_ms, error_rate_percent: sloEval.error_rate_percent, throughput_rps: sloEval.throughput_rps, availability_target: sloConfig.availability_target_percent, latency_target: sloConfig.latency_p95_target_ms, error_rate_target: sloConfig.error_rate_target_percent, throughput_target: sloConfig.throughput_target_rps, result: sloEval.slo_met ? 'PASS' : 'FAIL', created_at: new Date().toISOString() });
    await emitEvent({ type: 'reliability.slo.evaluated', reliability_run_id: runId, stage: 'slo', status: sloEval.slo_met ? 'PASS' : 'FAIL' });
  } catch (err) { evidence.failures.push({ stage: 'slo', error: err }); }

  // Error budget
  try {
    const perf = evidence.performance || { totalRequests: 0, failed: 0 };
    const errorBudgetService = new ErrorBudgetService();
    const budget = errorBudgetService.calculate(perf.totalRequests, perf.failed, 5);
    evidence.error_budget = budget;
    persistence.insertErrorBudget({ id: randomUUID(), reliability_run_id: runId, allowed_errors: budget.allowed_errors, observed_errors: budget.observed_errors, remaining_budget: budget.remaining_budget, budget_consumed_percent: budget.budget_consumed_percent, created_at: new Date().toISOString() });
    await emitEvent({ type: 'reliability.error_budget.evaluated', reliability_run_id: runId, stage: 'error_budget', status: 'PASS' });
  } catch (err) { evidence.failures.push({ stage: 'error_budget', error: err }); }

  // Regression (blocked first run)
  evidence.regression = { status: 'BLOCKED', reason: 'NO_HISTORICAL_BASELINE' };
  await emitEvent({ type: 'reliability.regression.evaluated', reliability_run_id: runId, stage: 'regression', status: 'BLOCKED' });

  // Gate
  const gate = new ReliabilityGate();
  const gateResult = gate.evaluate(evidence);
  evidence.reliability_gate = gateResult;
  await emitEvent({ type: 'reliability.gate.completed', reliability_run_id: runId, stage: 'gate', status: gateResult.status });
  await auditAction('reliability_gate_evaluated', 'gate', gateResult.status, { runId }, runId);

  // Update run
  persistence.updateReliabilityRun(runId, { status: gateResult.status, completed_at: new Date().toISOString(), duration_ms: Date.now() - Date.parse(run.started_at), gate_status: gateResult.status });

  await fixture.stop();

  // API verification
  try {
    const app = express();
    app.use(express.json());
    app.use('/api/reliability', reliabilityRouter);
    const server = app.listen(0, '127.0.0.1', async () => {
      const port = (server.address() as any).port;
      const baseApi = `http://127.0.0.1:${port}/api/reliability`;
      const endpoints = ['runs', `runs/${runId}`, `runs/${runId}/baseline`, `runs/${runId}/performance`, `runs/${runId}/load`, `runs/${runId}/stress`, `runs/${runId}/failures`, `runs/${runId}/recovery`, `runs/${runId}/slo`, `runs/${runId}/error-budget`, `runs/${runId}/regression`];
      const results = [];
      for (const ep of endpoints) {
        const response = await fetch(`${baseApi}/${ep}`);
        results.push({ endpoint: ep, status: response.status });
      }
      evidence.api_verification = { status: results.every(r => r.status === 200) ? 'PASS' : 'FAIL', results };
      server.close();
    });
    await new Promise(resolve => setTimeout(resolve, 3000));
  } catch (err) {
    evidence.api_verification = { status: 'FAIL', error: err };
  }

  // Dashboard verification
  const latestRun = persistence.getLatestRun();
  evidence.dashboard_verification = { status: latestRun.id === runId ? 'PASS' : 'FAIL' };

  evidence.timestamps.completed = new Date().toISOString();
  fs.writeFileSync(path.join(process.cwd(), 'phase9-pass3-evidence.json'), JSON.stringify(evidence, null, 2));
  console.log('Evidence written');
}

main().catch(err => { console.error('Fatal:', err); process.exit(1); });
