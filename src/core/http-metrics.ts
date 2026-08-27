import { IncomingMessage, ServerResponse } from "http";

export interface HttpMetrics {
  requestCount: number;
  errorCount: number;
  totalDurationMs: number;
  averageLatencyMs: number;
  lastRequests: { timestamp: string; method: string; route: string; statusCode: number; durationMs: number }[];
}

export function instrumentHttpServer(server: any): HttpMetrics {
  const metrics: HttpMetrics = {
    requestCount: 0,
    errorCount: 0,
    totalDurationMs: 0,
    averageLatencyMs: 0,
    lastRequests: [],
  };

  const oldEmit = server.emit;
  server.emit = function(event: string, ...args: any[]) {
    if (event === "request") {
      const req = args[0] as IncomingMessage;
      const res = args[1] as ServerResponse;
      const start = Date.now();

      const finish = () => {
        const duration = Date.now() - start;
        metrics.requestCount++;
        metrics.totalDurationMs += duration;
        metrics.averageLatencyMs = metrics.totalDurationMs / metrics.requestCount;
        if (res.statusCode && res.statusCode >= 400) {
          metrics.errorCount++;
        }
        metrics.lastRequests.push({
          timestamp: new Date().toISOString(),
          method: req.method || "UNKNOWN",
          route: req.url || "/",
          statusCode: res.statusCode || 0,
          durationMs: duration,
        });
        // Keep bounded
        if (metrics.lastRequests.length > 100) metrics.lastRequests.shift();
      };
      res.on("finish", finish);
    }
    return oldEmit.call(this, event, ...args);
  };

  return metrics;
}