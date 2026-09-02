export interface BaselineMetrics {
  status: number;
  latency_ms: number;
  timestamp: string;
  memory_rss: number;
}

export class BaselineAgent {
  async measure(url: string): Promise<BaselineMetrics> {
    const start = Date.now();
    const response = await fetch(url);
    const latency = Date.now() - start;
    return {
      status: response.status,
      latency_ms: latency,
      timestamp: new Date().toISOString(),
      memory_rss: process.memoryUsage().rss
    };
  }
}
