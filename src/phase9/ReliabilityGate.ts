export interface GateResult {
  status: 'PASS' | 'FAIL' | 'BLOCKED';
  reasons: string[];
}

export class ReliabilityGate {
  evaluate(evidence: any): GateResult {
    const reasons: string[] = [];
    let status: 'PASS' | 'FAIL' | 'BLOCKED' = 'PASS';

    // Required evidence blocks
    if (!evidence.baseline || evidence.baseline.status !== 200) {
      reasons.push('Baseline missing or failed');
      status = 'FAIL';
    }
    if (!evidence.performance || evidence.performance.totalRequests === undefined || evidence.performance.latency === undefined) {
      reasons.push('Performance metrics incomplete');
      status = 'FAIL';
    } else if (evidence.performance.errorRate > 5) {
      reasons.push('Performance error rate too high');
      status = 'FAIL';
    }
    if (!evidence.load || !Array.isArray(evidence.load) || evidence.load.length === 0) {
      reasons.push('Load test results missing');
      status = 'FAIL';
    } else {
      for (const level of evidence.load) {
        if (!level.metrics || level.metrics.totalRequests === undefined) {
          reasons.push('Load test metrics incomplete');
          status = 'FAIL';
          break;
        }
      }
    }
    if (!evidence.stress || !Array.isArray(evidence.stress.levels) || evidence.stress.levels.length === 0 || evidence.stress.maxMetrics === undefined) {
      reasons.push('Stress test results missing');
      status = 'FAIL';
    } else {
      for (const level of evidence.stress.levels) {
        if (!level.metrics || level.metrics.totalRequests === undefined || !level.started_at || !level.ended_at) {
          reasons.push('Stress test level timestamps or metrics missing');
          status = 'FAIL';
          break;
        }
      }
    }
    if (!evidence.failure_injection || evidence.failure_injection.duration_ms === undefined) {
      reasons.push('Failure injection result missing');
      status = 'FAIL';
    }
    if (!evidence.recovery || !evidence.recovery.recovered) {
      reasons.push('Recovery verification failed or missing');
      status = 'FAIL';
    }
    if (!evidence.slo || !evidence.slo.slo_met) {
      reasons.push('SLO not met or missing');
      status = 'FAIL';
    }
    if (!evidence.error_budget || evidence.error_budget.observed_errors === undefined) {
      reasons.push('Error budget calculation missing');
      status = 'FAIL';
    }
    if (reasons.length > 0) {
      status = 'FAIL';
    }
    return { status, reasons };
  }
}
