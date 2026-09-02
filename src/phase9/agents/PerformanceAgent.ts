import { runLoad, LoadMetrics } from '../loadGenerator';

export class PerformanceAgent {
  async run(url: string, options: {
    concurrency: number;
    durationMs: number;
    warmupMs?: number;
  }): Promise<LoadMetrics> {
    return runLoad(url, {
      concurrency: options.concurrency,
      durationMs: options.durationMs,
      warmupMs: options.warmupMs || 0
    });
  }
}
