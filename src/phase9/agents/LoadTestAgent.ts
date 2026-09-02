import { runLoad, LoadMetrics } from '../loadGenerator';

export class LoadTestAgent {
  async run(url: string, levels: number[], requestCount: number): Promise<{ level: number; metrics: LoadMetrics }[]> {
    const results: { level: number; metrics: LoadMetrics }[] = [];
    for (const concurrency of levels) {
      const metrics = await runLoad(url, {
        concurrency,
        requests: requestCount,
        warmupMs: 100
      });
      results.push({ level: concurrency, metrics });
    }
    return results;
  }
}
