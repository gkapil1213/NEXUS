export interface LoadMetrics {
  totalRequests: number;
  success: number;
  failed: number;
  latency: {
    min: number;
    max: number;
    p50: number;
    p90: number;
    p95: number;
    p99: number;
  };
  throughput: number;
  errorRate: number;
  duration_ms: number;
}

interface RequestResult {
  status: number;
  latency: number;
  ok: boolean;
}

export async function runLoad(
  url: string,
  options: {
    concurrency: number;
    requests?: number;
    durationMs?: number;
    rampUpMs?: number;
    warmupMs?: number;
  }
): Promise<LoadMetrics> {
  const { concurrency, requests, durationMs } = options;
  const startTime = Date.now();
  const results: RequestResult[] = [];
  let inFlight = 0;
  let completed = 0;
  let shouldStop = false;

  if (options.warmupMs) {
    await new Promise(resolve => setTimeout(resolve, options.warmupMs));
  }

  const worker = async () => {
    while (!shouldStop) {
      if (requests && completed >= requests) break;
      if (durationMs && Date.now() - startTime >= durationMs) break;

      inFlight++;
      const reqStart = Date.now();
      try {
        const res = await fetch(url);
        const latency = Date.now() - reqStart;
        results.push({ status: res.status, latency, ok: res.ok });
      } catch (err) {
        const latency = Date.now() - reqStart;
        results.push({ status: 0, latency, ok: false });
      } finally {
        inFlight--;
        completed++;
      }

      if (!requests && !durationMs) break;
    }
  };

  const workers: Promise<void>[] = [];
  for (let i = 0; i < concurrency; i++) {
    workers.push(worker());
  }

  await new Promise<void>(resolve => {
    const check = setInterval(() => {
      if (durationMs && Date.now() - startTime >= durationMs) {
        shouldStop = true;
        clearInterval(check);
        resolve();
      } else if (requests && completed >= requests) {
        shouldStop = true;
        clearInterval(check);
        resolve();
      } else if (completed > 0 && !requests && !durationMs) {
        shouldStop = true;
        clearInterval(check);
        resolve();
      }
    }, 100);
  });

  await Promise.all(workers);

  const duration = Date.now() - startTime;
  const latencies = results.map(r => r.latency).sort((a, b) => a - b);
  const failed = results.filter(r => !r.ok).length;
  const success = results.length - failed;

  return {
    totalRequests: results.length,
    success,
    failed,
    latency: {
      min: latencies[0] || 0,
      max: latencies[latencies.length - 1] || 0,
      p50: percentile(latencies, 50),
      p90: percentile(latencies, 90),
      p95: percentile(latencies, 95),
      p99: percentile(latencies, 99)
    },
    throughput: results.length / (duration / 1000),
    errorRate: (failed / results.length) * 100,
    duration_ms: duration
  };
}

function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  const index = Math.ceil((p / 100) * sorted.length) - 1;
  return sorted[Math.max(0, index)];
}
