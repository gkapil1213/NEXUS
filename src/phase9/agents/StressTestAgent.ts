import { runLoad, LoadMetrics } from '../loadGenerator';
import { PerformancePolicy } from './PerformancePolicy';

export interface StressLevel {
  concurrency: number;
  metrics: LoadMetrics;
  started_at: string;
  ended_at: string;
}

export class StressTestAgent {
  async run(url: string, policy: PerformancePolicy, maxConcurrency: number): Promise<{
    breakingPoint: number | null;
    maxMetrics: LoadMetrics;
    levels: StressLevel[];
  }> {
    const levels: StressLevel[] = [];
    let breakingPoint: number | null = null;
    let maxMetrics: LoadMetrics = await runLoad(url, { concurrency: 1, durationMs: 1000 });

    for (let concurrency = 1; concurrency <= maxConcurrency; concurrency *= 2) {
      const started_at = new Date().toISOString();
      const metrics = await runLoad(url, {
        concurrency,
        durationMs: 10000,
        warmupMs: 100
      });
      const ended_at = new Date().toISOString();
      levels.push({ concurrency, metrics, started_at, ended_at });

      if (levels.length === 0 || metrics.totalRequests > maxMetrics.totalRequests) {
        maxMetrics = metrics;
      }

      if (
        metrics.errorRate > policy.max_error_rate_percent ||
        metrics.latency.p95 > policy.max_p95_latency_ms ||
        metrics.throughput < policy.min_throughput_rps
      ) {
        breakingPoint = concurrency;
        break;
      }
    }

    // Ensure maxMetrics is set even if levels empty (edge case)
    if (levels.length > 0) {
      maxMetrics = levels[levels.length - 1].metrics;
    } else {
      maxMetrics = await runLoad(url, { concurrency: 1, durationMs: 1000 });
    }

    return { breakingPoint, maxMetrics, levels };
  }
}
