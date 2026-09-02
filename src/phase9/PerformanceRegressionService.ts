import { getPerformanceHistory } from './persistence';

export interface RegressionResult {
  status: 'PASS' | 'FAIL' | 'BLOCKED';
  reason?: string;
  comparisons?: {
    metric: string;
    baseline: number;
    current: number;
    change: number; // percentage
    threshold: number;
    decision: string;
  }[];
}

export class PerformanceRegressionService {
  async evaluate(currentMetrics: any, policy: any = {}): Promise<RegressionResult> {
    const history = getPerformanceHistory(2);
    if (history.length < 2) {
      return { status: 'BLOCKED', reason: 'NO_HISTORICAL_BASELINE' };
    }
    const baseline = history[1]; // second latest (previous run)
    const current = history[0]; // latest run

    const thresholds = {
      latency_p95: policy.latency_p95 ?? 20,
      latency_p99: policy.latency_p99 ?? 30,
      throughput: policy.throughput ?? 20,
      error_rate: policy.error_rate ?? 5,
      success_rate: policy.success_rate ?? 0,
    };

    const comparisons: any[] = [];
    let failed = false;

    // p95 latency
    const p95Baseline = baseline.p95;
    const p95Current = current.p95;
    if (p95Baseline !== null && p95Current !== null) {
      const change = ((p95Current - p95Baseline) / p95Baseline) * 100;
      const decision = change > thresholds.latency_p95 ? 'FAIL' : 'PASS';
      if (decision === 'FAIL') failed = true;
      comparisons.push({ metric: 'p95_latency', baseline: p95Baseline, current: p95Current, change, threshold: thresholds.latency_p95, decision });
    }

    // p99 latency
    const p99Baseline = baseline.p99;
    const p99Current = current.p99;
    if (p99Baseline !== null && p99Current !== null) {
      const change = ((p99Current - p99Baseline) / p99Baseline) * 100;
      const decision = change > thresholds.latency_p99 ? 'FAIL' : 'PASS';
      if (decision === 'FAIL') failed = true;
      comparisons.push({ metric: 'p99_latency', baseline: p99Baseline, current: p99Current, change, threshold: thresholds.latency_p99, decision });
    }

    // throughput
    const tpBaseline = baseline.throughput;
    const tpCurrent = current.throughput;
    if (tpBaseline !== null && tpCurrent !== null) {
      const change = ((tpBaseline - tpCurrent) / tpBaseline) * 100;
      const decision = change > thresholds.throughput ? 'FAIL' : 'PASS';
      if (decision === 'FAIL') failed = true;
      comparisons.push({ metric: 'throughput', baseline: tpBaseline, current: tpCurrent, change, threshold: thresholds.throughput, decision });
    }

    // error rate
    const erBaseline = baseline.error_rate;
    const erCurrent = current.error_rate;
    if (erBaseline !== null && erCurrent !== null) {
      const change = erCurrent - erBaseline;
      const decision = change > thresholds.error_rate ? 'FAIL' : 'PASS';
      if (decision === 'FAIL') failed = true;
      comparisons.push({ metric: 'error_rate', baseline: erBaseline, current: erCurrent, change, threshold: thresholds.error_rate, decision });
    }

    return { status: failed ? 'FAIL' : 'PASS', comparisons };
  }
}
